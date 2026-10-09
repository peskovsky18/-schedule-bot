# -*- coding: utf-8 -*-
"""
HTTP-API шахмат для мини-приложения.

Кто есть кто, определяется по подписи Telegram WebApp initData: клиент
присылает её в заголовке X-Telegram-Init-Data, сервер проверяет
HMAC-SHA256 секретом из токена бота. Без этого «я — это он» ничем
не подтверждается, и ходить за соперника может кто угодно.
"""

import time

from flask import Blueprint, jsonify, request

import auth
import casino
import chess_game

# Проверка подписи вынесена в общий модуль: её используют и шахматы,
# и музыка. Имена переэкспортируем, чтобы обращаться по-прежнему.
from auth import DEV_AUTH, current_user, verify_init_data  # noqa: F401

bp = Blueprint("chess", __name__, url_prefix="/api/chess")

# Чем сообщать сопернику о ходе. Ставит bot.py: chess_api не может
# импортировать его сам — получится замкнутый круг, bot.py уже
# импортирует chess_api.
_notify = None

# Адрес мини-приложения. Здесь только для диагностики: из него бот
# собирает кнопку меню и ссылки «Открыть доску», и если он пустой,
# обе возможности молчат — а увидеть это снаружи иначе нечем.
_mini_app_url = ""

# Кто и когда последний раз открывал доску. Хранится в памяти процесса
# намеренно: это подсказка для уведомлений, а не данные партии. Потерять
# её не страшно — в худшем случае придёт лишнее сообщение. Зато не тратит
# ни одной команды Upstash, а на бесплатном тарифе их 10 000 в сутки.
_seen = {}
SEEN_WINDOW = 90


def mark_seen(game_id, user_id):
    """Запоминает, что игрок сейчас смотрит на доску."""
    _seen[(game_id, user_id)] = time.time()


def seen_recently(game_id, user_id, within=None):
    """Открывал ли игрок доску вот только что."""
    stamp = _seen.get((game_id, user_id))
    if not stamp:
        return False

    return (time.time() - stamp) < (SEEN_WINDOW if within is None else within)


def forget_old_seen(limit=500):
    """Убирает старые отметки, чтобы словарь не рос бесконечно."""
    if len(_seen) < limit:
        return

    deadline = time.time() - SEEN_WINDOW
    for key, stamp in list(_seen.items()):
        if stamp < deadline:
            _seen.pop(key, None)


def init_app(app, bot_token, notify=None, mini_app_url=""):
    """
    Регистрирует раздел шахмат в приложении.

    notify(game, game_id, user_id) вызывается после хода и после сдачи.
    """
    global _notify, _mini_app_url
    _notify = notify
    _mini_app_url = mini_app_url

    auth.configure(bot_token)

    app.register_blueprint(bp)


def _state(game, user_id):
    """Состояние партии плюс размер награды за победу."""
    data = chess_game.serialize(game, user_id)

    # Размер награды показываем только когда её правда выдали: при
    # сдаче победитель видит победу, но не «+300», которых не было
    data["reward"] = casino.CHESS_WIN_COINS if game.get("rewarded") else 0

    return data


def _award_winner(game):
    """
    Начисляет тугрики победителю.

    Зовётся после каждого хода и после сдачи. Ничья не приносит тугриков
    никому.

    Партия помечается как оплаченная. Формально повторный вызов
    недостижим: законченная партия отклоняет и ход, и повторную сдачу.
    Но начисление денег не должно держаться на условии в другом месте —
    если однажды появится второй путь к этой функции, тугрики не
    удвоятся.
    """
    if game.get("status") != "finished":
        return None

    if game.get("rewarded"):
        return None

    # Сдача наградой не считается: победитель получает победу,
    # но не тугрики — так решил владелец приложения
    if game.get("endReason") == "resign":
        return None

    result = game.get("result")

    if result == "1-0":
        winner = (game.get("white") or {}).get("id")
    elif result == "0-1":
        winner = (game.get("black") or {}).get("id")
    else:
        # Ничья — награды нет
        return None

    if not winner:
        return None

    try:
        casino.award_chess_win(winner)
        print(f"[CHESS] победитель {winner} получил {casino.CHESS_WIN_COINS} тугриков")
    except Exception as error:
        # Монеты — приятный довесок, а не причина ронять ход
        print("[CHESS] тугрики за победу не начислены:", error)
        return None

    # Отмечаем в самой партии, что за неё уже заплатили
    game["rewarded"] = winner
    chess_game.save_game(game)

    return winner


def _tell_opponent(game, game_id, user_id, resigned=False, reward=None):
    """
    Просит бота предупредить соперника.

    Уведомление — вещь полезная, но необязательная: если Telegram
    недоступен, ход всё равно должен пройти, поэтому ошибку только
    записываем в лог.
    """
    if not _notify:
        return

    try:
        _notify(game, game_id, user_id, resigned, reward)
    except Exception as error:
        print("[CHESS] уведомление не ушло:", error)


# =========================
# МАРШРУТЫ
# =========================
@bp.route("/new", methods=["POST"])
def api_new():
    """Создаёт партию: игрок садится за белых."""
    user, error = current_user()
    if error:
        return jsonify({"ok": False, "error": error}), 401

    game = chess_game.create_game(user)

    return jsonify({
        "ok": True,
        "game": _state(game, user["id"]),
    })


@bp.route("/<game_id>/join", methods=["POST"])
def api_join(game_id):
    """Второй игрок садится за чёрных."""
    user, error = current_user()
    if error:
        return jsonify({"ok": False, "error": error}), 401

    game = chess_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    game, error = chess_game.join_game(game, user)
    if error:
        return jsonify({"ok": False, "error": error}), 409

    return jsonify({"ok": True, "game": _state(game, user["id"])})


@bp.route("/<game_id>", methods=["GET"])
def api_state(game_id):
    """
    Состояние партии.

    Смотреть может кто угодно по ссылке, но подсказки легальных ходов
    получает только тот, чей сейчас ход, — иначе соперник увидел бы
    подсказки за другого.
    """
    user, _ = current_user()

    game = chess_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    # Игрок смотрит на доску — значит, о ходе ему можно не писать:
    # он увидит его сам через пару секунд
    if user and chess_game.is_player(game, user["id"]):
        mark_seen(game_id, user["id"])
        forget_old_seen()

    return jsonify({
        "ok": True,
        "game": _state(game, user["id"] if user else None),
    })


@bp.route("/<game_id>/move", methods=["POST"])
def api_move(game_id):
    """Принимает ход. Легальность и очередь проверяет сервер."""
    user, error = current_user()
    if error:
        return jsonify({"ok": False, "error": error}), 401

    payload = request.get_json(silent=True) or {}
    from_square = (payload.get("from") or "").strip().lower()
    to_square = (payload.get("to") or "").strip().lower()
    promotion = (payload.get("promotion") or "").strip().lower() or None

    if not from_square or not to_square:
        return jsonify({"ok": False, "error": "Нужны поля from и to"}), 400

    game = chess_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    game, error = chess_game.apply_move(game, user["id"], from_square, to_square, promotion)
    if error:
        return jsonify({"ok": False, "error": error}), 409

    winner = _award_winner(game)
    _tell_opponent(game, game_id, user["id"], reward=winner)

    return jsonify({"ok": True, "game": _state(game, user["id"])})


@bp.route("/<game_id>/cancel", methods=["POST"])
def api_cancel(game_id):
    """Отменяет партию, к которой никто не присоединился."""
    user, error = current_user()
    if error:
        return jsonify({"ok": False, "error": error}), 401

    game = chess_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    game, error = chess_game.cancel(game, user["id"])
    if error:
        return jsonify({"ok": False, "error": error}), 409

    return jsonify({"ok": True, "cancelled": game_id})


@bp.route("/<game_id>/resign", methods=["POST"])
def api_resign(game_id):
    """Игрок сдаётся."""
    user, error = current_user()
    if error:
        return jsonify({"ok": False, "error": error}), 401

    game = chess_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    game, error = chess_game.resign(game, user["id"])
    if error:
        return jsonify({"ok": False, "error": error}), 409

    winner = _award_winner(game)
    _tell_opponent(game, game_id, user["id"], resigned=True, reward=winner)

    return jsonify({"ok": True, "game": _state(game, user["id"])})


@bp.route("/status", methods=["GET"])
def api_status():
    """Диагностика: хранилище и адрес мини-приложения."""
    store = chess_game.get_store()

    return jsonify({
        "ok": True,
        "storage": "redis" if isinstance(store, chess_game.RedisStore) else "memory",
        "persistent": isinstance(store, chess_game.RedisStore),
        "devAuth": DEV_AUTH,
        "miniAppUrl": _mini_app_url or "",
    })
