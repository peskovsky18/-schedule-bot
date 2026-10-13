# -*- coding: utf-8 -*-
"""
HTTP-API для крестиков-ноликов 3х3.
"""

import time
from flask import Blueprint, jsonify, request

import auth
import casino
import ttt_game

bp = Blueprint("ttt", __name__, url_prefix="/api/ttt")

_notify = None
_mini_app_url = ""
_seen = {}
SEEN_WINDOW = 60


def mark_seen(game_id, user_id):
    """Запоминает, что игрок сейчас смотрит на доску."""
    _seen[(game_id, user_id)] = time.time()


def seen_recently(game_id, user_id, within=None):
    stamp = _seen.get((game_id, user_id))
    if not stamp:
        return False
    return (time.time() - stamp) < (SEEN_WINDOW if within is None else within)


def init_app(app, bot_token="", notify=None, mini_app_url=""):
    global _notify, _mini_app_url
    _notify = notify
    _mini_app_url = (mini_app_url or "").rstrip("/")
    app.register_blueprint(bp)


def _player():
    user, error = auth.current_user()
    if error:
        return None, (jsonify({"ok": False, "error": error}), 401)
    return user, None


def serialize_game(game, user_id=None):
    symbol = ttt_game.player_symbol(game, user_id) if user_id else None
    return {
        "id": game["id"],
        "board": game["board"],
        "x": game.get("x"),
        "o": game.get("o"),
        "turn": game["turn"],
        "status": game["status"],
        "winner": game.get("winner"),
        "winningLine": game.get("winning_line"),
        "mySymbol": symbol,
        "isMyTurn": game["status"] == "active" and game["turn"] == symbol,
        "winCoins": ttt_game.TTT_WIN_COINS,
    }


@bp.route("/new", methods=["POST"])
def api_new():
    """Создаёт новую партию."""
    user, failure = _player()
    if failure:
        return failure

    game = ttt_game.create_game(user)
    mark_seen(game["id"], user["id"])
    return jsonify({"ok": True, "game": serialize_game(game, user["id"])})


@bp.route("/<game_id>", methods=["GET"])
def api_get(game_id):
    """Возвращает текущее состояние партии."""
    user, failure = _player()
    if failure:
        return failure

    game = ttt_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    mark_seen(game_id, user["id"])
    return jsonify({"ok": True, "game": serialize_game(game, user["id"])})


@bp.route("/<game_id>/join", methods=["POST"])
def api_join(game_id):
    """Присоединяет второго игрока."""
    user, failure = _player()
    if failure:
        return failure

    game = ttt_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    game, error = ttt_game.join_game(game, user)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    mark_seen(game_id, user["id"])
    return jsonify({"ok": True, "game": serialize_game(game, user["id"])})


@bp.route("/<game_id>/move", methods=["POST"])
def api_move(game_id):
    """Делает ход в партии."""
    user, failure = _player()
    if failure:
        return failure

    game = ttt_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    payload = request.get_json(silent=True) or {}
    cell = payload.get("cell")

    game, error, reward_user_id = ttt_game.make_move(game, user["id"], cell)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    mark_seen(game_id, user["id"])

    # Уведомляем соперника, если он не смотрит в экран
    if _notify:
        try:
            _notify(game, user["id"], reward_user_id)
        except Exception as e:
            print("[TTT] Ошибка отправки уведомления:", e)

    return jsonify({"ok": True, "game": serialize_game(game, user["id"])})


@bp.route("/<game_id>/resign", methods=["POST"])
def api_resign(game_id):
    """Сдаться в партии."""
    user, failure = _player()
    if failure:
        return failure

    game = ttt_game.load_game(game_id)
    if not game:
        return jsonify({"ok": False, "error": "Партия не найдена"}), 404

    game, error = ttt_game.resign_game(game, user["id"])
    if error:
        return jsonify({"ok": False, "error": error}), 400

    return jsonify({"ok": True, "game": serialize_game(game, user["id"])})


@bp.route("/solo_reward", methods=["POST"])
def api_solo_reward():
    """Небольшая награда (+25 тугриков) за победу над ботом."""
    user, failure = _player()
    if failure:
        return failure

    SOLO_COINS = 25
    record = casino.add_coins(user["id"], SOLO_COINS)
    return jsonify({
        "ok": True,
        "gained": SOLO_COINS,
        "balance": record.get("balance", 0),
    })
