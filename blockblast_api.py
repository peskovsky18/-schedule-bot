# -*- coding: utf-8 -*-
"""
API для игры Block Blast (Взрыв блоков).
Хранит рекорды игрока и начисляет тугрики за успешные партии.
"""

import json
from datetime import datetime
from flask import Blueprint, jsonify, request

import auth
import casino
import store

bp = Blueprint("blockblast", __name__, url_prefix="/api/blockblast")

DAILY_COINS_LIMIT = 200
MAX_COINS_PER_GAME = 60


def _bb_key(user_id):
    return f"blockblast:user:{user_id}"


def _today_str():
    try:
        from parser import now_msk
        return now_msk().strftime("%Y-%m-%d")
    except Exception:
        return datetime.utcnow().strftime("%Y-%m-%d")


def get_user_bb(user_id):
    s = store.get_store()
    raw = s.get(_bb_key(user_id))
    today = _today_str()
    default_data = {
        "best_score": 0,
        "games_played": 0,
        "total_lines": 0,
        "daily_date": today,
        "daily_coins_earned": 0,
    }
    if not raw:
        return default_data

    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(data, dict):
            return default_data
        if data.get("daily_date") != today:
            data["daily_date"] = today
            data["daily_coins_earned"] = 0
        return data
    except Exception:
        return default_data


def save_user_bb(user_id, data):
    s = store.get_store()
    s.set(_bb_key(user_id), json.dumps(data, ensure_ascii=False))


def init_app(app):
    app.register_blueprint(bp)


@bp.route("", methods=["GET"])
def get_stats():
    user, err = auth.current_user()
    if err:
        return jsonify({"ok": False, "error": err}), 401

    data = get_user_bb(user["id"])
    return jsonify({
        "ok": True,
        "best_score": data.get("best_score", 0),
        "games_played": data.get("games_played", 0),
        "total_lines": data.get("total_lines", 0),
        "daily_coins_earned": data.get("daily_coins_earned", 0),
        "daily_limit": DAILY_COINS_LIMIT,
    })


@bp.route("/game_over", methods=["POST"])
def game_over():
    user, err = auth.current_user()
    if err:
        return jsonify({"ok": False, "error": err}), 401

    body = request.get_json(silent=True) or {}
    score = max(0, int(body.get("score", 0)))
    lines = max(0, int(body.get("lines", 0)))

    data = get_user_bb(user["id"])
    data["games_played"] = data.get("games_played", 0) + 1
    data["total_lines"] = data.get("total_lines", 0) + lines

    old_best = data.get("best_score", 0)
    is_record = score > old_best
    if is_record:
        data["best_score"] = score

    # Расчет награды в тугриках: 1 тугрик за каждые 25 очков
    potential_coins = min(MAX_COINS_PER_GAME, score // 25)
    earned_today = data.get("daily_coins_earned", 0)
    available_today = max(0, DAILY_COINS_LIMIT - earned_today)
    coins_to_award = min(potential_coins, available_today)

    new_balance = None
    if coins_to_award > 0:
        data["daily_coins_earned"] = earned_today + coins_to_award
        player_record = casino.add_coins(user["id"], coins_to_award)
        if player_record and "balance" in player_record:
            new_balance = player_record["balance"]

    save_user_bb(user["id"], data)

    if new_balance is None:
        rec = casino.load(user["id"])
        new_balance = rec.get("balance", 0)

    return jsonify({
        "ok": True,
        "score": score,
        "best_score": data["best_score"],
        "is_record": is_record,
        "coins_awarded": coins_to_award,
        "balance": new_balance,
        "daily_coins_earned": data["daily_coins_earned"],
        "daily_limit": DAILY_COINS_LIMIT,
    })
