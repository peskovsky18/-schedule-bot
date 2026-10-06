# -*- coding: utf-8 -*-
"""
Шахматные партии: хранение и правила.

Правила проверяет python-chess, а не клиент. Иначе достаточно отправить
произвольный ход и объявить себя победителем — фронтенд это не защита.

Хранилище подключается снаружи: Redis (Upstash) в проде, память — для
локального запуска и тестов. Upstash говорит по REST, поэтому отдельная
библиотека не нужна: хватает requests.
"""

import json
import os
import secrets
import time

import chess
import requests

# Партия живёт неделю: бесплатный тариф Upstash не бесконечный,
# а брошенные партии копятся
GAME_TTL = 7 * 24 * 60 * 60

# Короткий идентификатор для ссылки в боте
ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
ID_LENGTH = 10


# =========================
# ХРАНИЛИЩЕ
# =========================
class MemoryStore:
    """
    Хранилище в памяти процесса.

    Годится для тестов и локального запуска. В проде не подходит:
    у Render диск эфемерный, и партия исчезнет при первом же перезапуске.
    """

    def __init__(self):
        self._data = {}
        self._expires = {}

    def get(self, key):
        expires = self._expires.get(key)
        if expires and expires < time.time():
            self._data.pop(key, None)
            self._expires.pop(key, None)
            return None
        return self._data.get(key)

    def set(self, key, value, ttl=None):
        self._data[key] = value
        if ttl:
            self._expires[key] = time.time() + ttl
        else:
            self._expires.pop(key, None)

    def delete(self, key):
        self._data.pop(key, None)
        self._expires.pop(key, None)

    def clear(self):
        self._data.clear()
        self._expires.clear()


class RedisStore:
    """
    Upstash Redis через REST.

    Команда передаётся массивом в теле POST-запроса, ответ приходит
    в поле result. Так работает REST-API Upstash, отдельный клиент
    Redis не нужен.
    """

    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token

    def _command(self, *args):
        response = requests.post(
            self.url,
            json=list(args),
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=10,
        )
        response.raise_for_status()
        return response.json().get("result")

    def get(self, key):
        return self._command("GET", key)

    def set(self, key, value, ttl=None):
        if ttl:
            return self._command("SET", key, value, "EX", int(ttl))
        return self._command("SET", key, value)

    def delete(self, key):
        return self._command("DEL", key)


_store = None


def get_store():
    """
    Выбирает хранилище по переменным окружения.

    UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN задаются в панели
    Render. Без них работает память — приложение не падает, просто
    партии не переживут перезапуск.
    """
    global _store

    if _store is not None:
        return _store

    url = (os.getenv("UPSTASH_REDIS_REST_URL") or "").strip()
    token = (os.getenv("UPSTASH_REDIS_REST_TOKEN") or "").strip()

    if url and token:
        print("[CHESS] хранение: Upstash Redis")
        _store = RedisStore(url, token)
    else:
        print("[CHESS] хранение: память (партии не переживут перезапуск)")
        _store = MemoryStore()

    return _store


def set_store(store):
    """Подменяет хранилище. Нужно тестам и локальным прогонам."""
    global _store
    _store = store
    return store


# =========================
# ПАРТИИ
# =========================
def _key(game_id):
    return f"chess:game:{game_id}"


def new_id():
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(ID_LENGTH))


def save_game(game):
    game["updated"] = int(time.time())
    get_store().set(_key(game["id"]), json.dumps(game, ensure_ascii=False), GAME_TTL)
    return game


def load_game(game_id):
    if not game_id:
        return None

    raw = get_store().get(_key(game_id))
    if not raw:
        return None

    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def delete_game(game_id):
    get_store().delete(_key(game_id))


def create_game(player):
    """
    Создаёт партию. Игрок садится за белых, соперник присоединится позже.
    """
    game = {
        "id": new_id(),
        "fen": chess.STARTING_FEN,
        "moves": [],
        "white": player,
        "black": None,
        "status": "waiting",  # waiting | active | finished
        "result": None,
        "created": int(time.time()),
        "updated": int(time.time()),
    }

    return save_game(game)


def join_game(game, player):
    """
    Присоединяет второго игрока за чёрных.

    Повторный заход того же игрока ничего не ломает: он просто вернётся
    на своё место. Если партия уже занята кем-то другим — отказ.
    """
    if game["status"] != "waiting":
        # Свой ли это игрок — проверяем отдельно
        if is_player(game, player["id"]):
            return game, None
        return None, "Партия уже занята"

    if game["white"] and game["white"]["id"] == player["id"]:
        return None, "Это ваша же партия — ждите соперника"

    game["black"] = player
    game["status"] = "active"

    return save_game(game), None


def player_color(game, user_id):
    """Каким цветом играет пользователь. None — он в этой партии не играет."""
    if game.get("white") and game["white"]["id"] == user_id:
        return "white"
    if game.get("black") and game["black"]["id"] == user_id:
        return "black"
    return None


def is_player(game, user_id):
    return player_color(game, user_id) is not None


def _result_for(board):
    """Итог партии в шахматной нотации или None, если игра идёт."""
    if board.is_checkmate():
        # Мат поставил тот, чей ход был до этого
        return "0-1" if board.turn == chess.WHITE else "1-0"
    if board.is_stalemate() or board.is_insufficient_material():
        return "1/2-1/2"
    if board.is_seventyfive_moves() or board.is_fivefold_repetition():
        return "1/2-1/2"
    return None


def board_of(game):
    try:
        return chess.Board(game["fen"])
    except (ValueError, KeyError):
        return chess.Board()


def apply_move(game, user_id, from_square, to_square, promotion=None):
    """
    Проверяет и применяет ход.

    Возвращает (game, error). Ход принимается, только если он легален
    и сделан тем, чья сейчас очередь.
    """
    if game["status"] == "waiting":
        return None, "Соперник ещё не присоединился"
    if game["status"] == "finished":
        return None, "Партия уже закончена"

    color = player_color(game, user_id)
    if color is None:
        return None, "Вы не участник этой партии"

    board = board_of(game)

    if (color == "white") != (board.turn == chess.WHITE):
        return None, "Сейчас не ваш ход"

    try:
        move = chess.Move.from_uci(f"{from_square}{to_square}{(promotion or '').lower()}")
    except ValueError:
        return None, "Некорректные координаты хода"

    if move not in board.legal_moves:
        return None, "Так ходить нельзя"

    board.push(move)

    game["fen"] = board.fen()
    game["moves"].append(board.peek().uci())

    result = _result_for(board)
    if result:
        game["status"] = "finished"
        game["result"] = result

    return save_game(game), None


def resign(game, user_id):
    """Игрок сдаётся: победа достаётся сопернику."""
    color = player_color(game, user_id)
    if color is None:
        return None, "Вы не участник этой партии"
    if game["status"] == "finished":
        return None, "Партия уже закончена"

    game["status"] = "finished"
    game["result"] = "0-1" if color == "white" else "1-0"

    return save_game(game), None


def serialize(game, user_id=None):
    """
    Состояние партии для клиента.

    Вместе с позицией отдаём список легальных ходов по клеткам: тогда
    интерфейсу не нужен свой движок, а сервер всё равно перепроверит ход.
    """
    board = board_of(game)
    color = player_color(game, user_id) if user_id else None

    legal = {}
    # Подсказки имеет смысл считать только тому, чей сейчас ход
    if game["status"] == "active" and color and (color == "white") == (board.turn == chess.WHITE):
        for move in board.legal_moves:
            legal.setdefault(chess.square_name(move.from_square), []).append(
                chess.square_name(move.to_square)
            )

    last = None
    if game["moves"]:
        last_move = chess.Move.from_uci(game["moves"][-1])
        last = {
            "from": chess.square_name(last_move.from_square),
            "to": chess.square_name(last_move.to_square),
        }

    return {
        "id": game["id"],
        "fen": game["fen"],
        "status": game["status"],
        "result": game["result"],
        "turn": "white" if board.turn == chess.WHITE else "black",
        "you": color,
        "inCheck": board.is_check(),
        "isCheckmate": board.is_checkmate(),
        "moves": game["moves"],
        "legal": legal,
        "lastMove": last,
        "white": game["white"],
        "black": game["black"],
        "created": game["created"],
        "updated": game.get("updated"),
    }
