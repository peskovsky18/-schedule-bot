# -*- coding: utf-8 -*-
"""
HTTP-API шахмат для мини-приложения.

Кто есть кто, определяется по подписи Telegram WebApp initData: клиент
присылает её в заголовке X-Telegram-Init-Data, сервер проверяет
HMAC-SHA256 секретом из токена бота. Без этого «я — это он» ничем
не подтверждается, и ходить за соперника может кто угодно.
"""

import hashlib
import hmac
import json
import os
import time
import urllib.parse

from flask import Blueprint, jsonify, request

import chess_game

bp = Blueprint("chess", __name__, url_prefix="/api/chess")

# Токен бота нужен для проверки подписи. Проставляется в init_app.
_bot_token = None

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

# Режим отладки: разрешает играть без подписи Telegram.
# Нужен только для локального запуска в браузере, где initData пустая.
# В проде быть не должно — тогда личность не проверяется вообще.
DEV_AUTH = os.getenv("CHESS_DEV_AUTH") == "1"


def init_app(app, bot_token, notify=None, mini_app_url=""):
    """
    Регистрирует раздел шахмат в приложении.

    notify(game, game_id, user_id) вызывается после хода и после сдачи.
    """
    global _bot_token, _notify, _mini_app_url
    _bot_token = bot_token
    _notify = notify
    _mini_app_url = mini_app_url

    if DEV_AUTH:
        print("[CHESS] ВНИМАНИЕ: CHESS_DEV_AUTH=1 — подпись Telegram не проверяется")

    app.register_blueprint(bp)


# =========================
# ПРОВЕРКА ПОДПИСИ
# =========================
def verify_init_data(init_data, bot_token):
    """
    Проверяет подпись initData из Telegram WebApp.

    Алгоритм из документации: секрет — HMAC-SHA256 от токена бота
    с ключом «WebAppData», затем HMAC-SHA256 от строки данных.
    """
    if not init_data or not bot_token:
        return None

    try:
        pairs = urllib.parse.parse_qsl(
            init_data, strict_parsing=True, keep_blank_values=True
        )
    except ValueError:
        return None

    data = dict(pairs)
    received = data.pop("hash", None)

    if not received:
        return None

    check_string = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))

    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    calculated = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated, received):
        return None

    try:
        user = json.loads(data.get("user") or "{}")
    except ValueError:
        return None

    if not user.get("id"):
        return None

    return user


def _raw_init_data():
    """initData приходит заголовком, из тела или из строки запроса."""
    value = request.headers.get("X-Telegram-Init-Data")
    if value:
        return value

    payload = request.get_json(silent=True)
    if isinstance(payload, dict) and payload.get("initData"):
        return payload["initData"]

    return request.args.get("initData")


def current_user():
    """
    Возвращает (пользователь, ошибка).

    Пользователь — словарь с id и именем, как его отдаёт Telegram.
    """
    init_data = _raw_init_data()

    if init_data:
        user = verify_init_data(init_data, _bot_token)
        if user:
            return {
                "id": user["id"],
                "name": user.get("first_name") or user.get("username") or "Игрок",
            }, None
        return None, "Подпись Telegram не совпала"

    if DEV_AUTH:
        user_id = request.headers.get("X-Dev-User-Id") or request.args.get("devUserId")
        if user_id:
            try:
                user_id = int(user_id)
            except ValueError:
                return None, "Некорректный X-Dev-User-Id"

            return {
                "id": user_id,
                "name": request.headers.get("X-Dev-User-Name") or f"Игрок {user_id}",
            }, None

    return None, "Нужна авторизация через Telegram"


def _tell_opponent(game, game_id, user_id, resigned=False):
    """
    Просит бота предупредить соперника.

    Уведомление — вещь полезная, но необязательная: если Telegram
    недоступен, ход всё равно должен пройти, поэтому ошибку только
    записываем в лог.
    """
    if not _notify:
        return

    try:
        _notify(game, game_id, user_id, resigned)
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
        "game": chess_game.serialize(game, user["id"]),
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

    return jsonify({"ok": True, "game": chess_game.serialize(game, user["id"])})


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
        "game": chess_game.serialize(game, user["id"] if user else None),
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

    _tell_opponent(game, game_id, user["id"])

    return jsonify({"ok": True, "game": chess_game.serialize(game, user["id"])})


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

    _tell_opponent(game, game_id, user["id"], resigned=True)

    return jsonify({"ok": True, "game": chess_game.serialize(game, user["id"])})


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
