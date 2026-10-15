# -*- coding: utf-8 -*-
"""
API для игры Flappy Челик.
Хранит рекорды игрока и начисляет тугрики только за побитый рекорд.
"""

import json
from datetime import datetime
from flask import Blueprint, jsonify, request

import auth
import casino
import store

bp = Blueprint("flappy", __name__, url_prefix="/api/flappy")


def _flappy_key(user_id):
    return f"flappy:user:{user_id}"


def get_user_flappy(user_id):
    s = store.get_store()
    raw = s.get(_flappy_key(user_id))
    default_data = {
        "best_score": 0,
        "games_played": 0,
    }
    if not raw:
        return default_data

    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(data, dict):
            return default_data
        return data
    except Exception:
        return default_data


def save_user_flappy(user_id, data):
    s = store.get_store()
    s.set(_flappy_key(user_id), json.dumps(data, ensure_ascii=False))


def init_app(app):
    app.register_blueprint(bp)


@bp.route("", methods=["GET", "OPTIONS"])
def get_stats():
    if request.method == "OPTIONS":
        return "", 204

    user, err = auth.current_user()
    if err:
        return jsonify({"ok": False, "error": err}), 401

    data = get_user_flappy(user["id"])
    return jsonify({
        "ok": True,
        "best_score": data.get("best_score", 0),
        "games_played": data.get("games_played", 0),
    })


@bp.route("/game_over", methods=["POST", "OPTIONS"])
def game_over():
    if request.method == "OPTIONS":
        return "", 204

    user, err = auth.current_user()
    if err:
        return jsonify({"ok": False, "error": err}), 401

    body = request.get_json(silent=True, force=True) or {}
    score = max(0, int(body.get("score", 0)))
    client_balance = body.get("client_balance")

    data = get_user_flappy(user["id"])
    data["games_played"] = data.get("games_played", 0) + 1

    old_best = data.get("best_score", 0)
    is_record = score > old_best
    if is_record:
        data["best_score"] = score

    # Тугрики начисляются ТОЛЬКО если побит личный рекорд: вся сумма нового рекорда целиком!
    coins_to_award = score if is_record else 0

    if coins_to_award > 0:
        casino.add_coins(user["id"], coins_to_award)

    save_user_flappy(user["id"], data)

    rec = casino.load(user["id"])
    server_bal = int(rec.get("balance") or 0)

    # Защита от рассинхронизации баланса
    if client_balance is not None:
        try:
            client_bal_int = int(client_balance)
            if client_bal_int > server_bal:
                rec["balance"] = client_bal_int
                rec["best"] = max(int(rec.get("best") or 0), client_bal_int)
                casino.save(user["id"], rec)
                server_bal = client_bal_int
        except (ValueError, TypeError):
            pass

    return jsonify({
        "ok": True,
        "score": score,
        "best_score": data["best_score"],
        "is_record": is_record,
        "coins_awarded": coins_to_award,
        "balance": server_bal,
    })
