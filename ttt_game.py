# -*- coding: utf-8 -*-
"""
Крестики-нолики 3х3: правила и хранение партий.

Правила и ходы проверяются на сервере, чтобы избежать нечестной игры.
Хранилище: Redis (Upstash) в проде, память — для локального запуска и тестов.
"""

import json
import secrets
import time

from store import get_store

# Партия живёт 3 дня
GAME_TTL = 3 * 24 * 60 * 60

ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
ID_LENGTH = 10

# Награда за победу в мультиплеере (тугрики)
TTT_WIN_COINS = 100

# Выигрышные линии 5х5 (4 в ряд для победы)
def _generate_lines_5x5():
    res = []
    # Строки (по 4 в ряд)
    for r in range(5):
        for c in range(2):
            res.append([r * 5 + c + i for i in range(4)])
    # Столбцы (по 4 в ряд)
    for c in range(5):
        for r in range(2):
            res.append([(r + i) * 5 + c for i in range(4)])
    # Главные диагонали (dr=1, dc=1)
    for r in range(2):
        for c in range(2):
            res.append([(r + i) * 5 + (c + i) for i in range(4)])
    # Побочные диагонали (dr=1, dc=-1)
    for r in range(2):
        for c in range(3, 5):
            res.append([(r + i) * 5 + (c - i) for i in range(4)])
    return res

LINES = _generate_lines_5x5()


def _key(game_id):
    return f"ttt:game:{game_id}"


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
    Создаёт партию. Игрок садится за 'X' (первый ход), соперник за 'O'.
    """
    game = {
        "id": new_id(),
        "board": [""] * 25,
        "x": player,
        "o": None,
        "turn": "X",
        "status": "waiting",  # waiting | active | finished
        "winner": None,       # 'X' | 'O' | 'draw' | None
        "winning_line": None, # [a, b, c, d] | None
        "moves": 0,
        "reward_given": False,
        "created": int(time.time()),
        "updated": int(time.time()),
    }
    return save_game(game)


def is_player(game, user_id):
    if not game or not user_id:
        return False
    user_id = int(user_id)
    return (
        (game.get("x") and int(game["x"]["id"]) == user_id)
        or (game.get("o") and int(game["o"]["id"]) == user_id)
    )


def player_symbol(game, user_id):
    if not game or not user_id:
        return None
    user_id = int(user_id)
    if game.get("x") and int(game["x"]["id"]) == user_id:
        return "X"
    if game.get("o") and int(game["o"]["id"]) == user_id:
        return "O"
    return None


def opponent_of(game, user_id):
    user_id = int(user_id)
    if game.get("x") and int(game["x"]["id"]) == user_id:
        return game.get("o")
    if game.get("o") and int(game["o"]["id"]) == user_id:
        return game.get("x")
    return None


def join_game(game, player):
    """
    Присоединяет второго игрока за 'O'.
    """
    if game["status"] != "waiting":
        if is_player(game, player["id"]):
            return game, None
        return None, "Партия уже занята"

    if game["x"] and int(game["x"]["id"]) == int(player["id"]):
        return game, None

    game["o"] = player
    game["status"] = "active"
    return save_game(game), None


def check_board_winner(board):
    """
    Проверяет победителя по состоянию доски.
    Возвращает (победитель, выигрышная_линия).
    Победитель: 'X', 'O', 'draw' или None.
    """
    for line in LINES:
        a, b, c, d = line
        if board[a] and board[a] == board[b] == board[c] == board[d]:
            return board[a], line

    if all(cell != "" for cell in board):
        return "draw", None

    return None, None


def make_move(game, user_id, cell_index):
    """
    Делает ход в клетку cell_index (0..24).
    Возвращает (game, ошибка, награда_id).
    """
    if game["status"] == "waiting":
        return None, "Ждём подключения второго игрока", None

    if game["status"] == "finished":
        return None, "Партия уже завершена", None

    symbol = player_symbol(game, user_id)
    if not symbol:
        return None, "Вы не участник этой партии", None

    if game["turn"] != symbol:
        return None, "Сейчас ход соперника", None

    try:
        cell_index = int(cell_index)
    except (TypeError, ValueError):
        return None, "Некорректный номер клетки", None

    if cell_index < 0 or cell_index > 24:
        return None, "Клетка должна быть от 0 до 24", None

    board = list(game["board"])
    if board[cell_index] != "":
        return None, "Эта клетка уже занята", None

    board[cell_index] = symbol
    game["board"] = board
    game["moves"] = int(game.get("moves") or 0) + 1

    winner, win_line = check_board_winner(board)
    reward_user_id = None

    if winner:
        game["status"] = "finished"
        game["winner"] = winner
        game["winning_line"] = win_line

        if winner in ("X", "O") and not game.get("reward_given"):
            game["reward_given"] = True
            winning_player = game["x"] if winner == "X" else game["o"]
            if winning_player:
                reward_user_id = winning_player["id"]
                try:
                    import casino
                    casino.add_coins(reward_user_id, TTT_WIN_COINS)
                except Exception as e:
                    print("[TTT] Ошибка начисления награды:", e)
    else:
        game["turn"] = "O" if symbol == "X" else "X"

    save_game(game)
    return game, None, reward_user_id


def resign_game(game, user_id):
    """
    Сдаться в партии. Победа присуждается сопернику.
    """
    if game["status"] == "finished":
        return game, "Партия уже завершена"

    symbol = player_symbol(game, user_id)
    if not symbol:
        return None, "Вы не участник этой партии"

    winner = "O" if symbol == "X" else "X"
    game["status"] = "finished"
    game["winner"] = winner
    game["winning_line"] = None

    reward_user_id = None
    if not game.get("reward_given"):
        game["reward_given"] = True
        winning_player = game["x"] if winner == "X" else game["o"]
        if winning_player:
            reward_user_id = winning_player["id"]
            try:
                import casino
                casino.add_coins(reward_user_id, TTT_WIN_COINS)
            except Exception as e:
                print("[TTT] Ошибка начисления награды:", e)

    return save_game(game), None
