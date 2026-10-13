# -*- coding: utf-8 -*-
"""
HTTP-API для питомца-тамагочи.
"""

from flask import Blueprint, jsonify, request

import auth
import casino
import pet

bp = Blueprint("pet", __name__, url_prefix="/api/pet")


def init_app(app):
    app.register_blueprint(bp)


def _user_and_error():
    user, error = auth.current_user()
    if error or not user:
        return None, (jsonify({"ok": False, "error": error or "Нужна авторизация"}), 401)
    return user, None


@bp.route("", methods=["GET", "OPTIONS"])
def get_pet_state():
    if request.method == "OPTIONS":
        return "", 204

    user, failure = _user_and_error()
    if failure:
        return failure

    pet_data = pet.get_pet(user["id"])
    player = casino.load(user["id"])
    balance = int(player.get("balance") or 0)

    return jsonify({
        "ok": True,
        "pet": pet_data,
        "balance": balance,
        "adoptCost": pet.ADOPT_COST,
        "appleCost": pet.APPLE_COST,
        "catalog": pet.PET_ITEMS,
    })


@bp.route("/adopt", methods=["POST", "OPTIONS"])
def adopt():
    if request.method == "OPTIONS":
        return "", 204

    user, failure = _user_and_error()
    if failure:
        return failure

    data = request.get_json(silent=True) or {}
    name = data.get("name")

    pet_data, error = pet.adopt_pet(user["id"], name)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    player = casino.load(user["id"])
    return jsonify({
        "ok": True,
        "pet": pet_data,
        "balance": int(player.get("balance") or 0),
    })


@bp.route("/feed", methods=["POST", "OPTIONS"])
def feed():
    if request.method == "OPTIONS":
        return "", 204

    user, failure = _user_and_error()
    if failure:
        return failure

    pet_data, error = pet.feed_pet(user["id"])
    if error:
        return jsonify({"ok": False, "error": error}), 400

    player = casino.load(user["id"])
    return jsonify({
        "ok": True,
        "pet": pet_data,
        "balance": int(player.get("balance") or 0),
    })


@bp.route("/buy", methods=["POST", "OPTIONS"])
def buy_item():
    if request.method == "OPTIONS":
        return "", 204

    user, failure = _user_and_error()
    if failure:
        return failure

    data = request.get_json(silent=True) or {}
    item_id = data.get("itemId")

    pet_data, error = pet.buy_item(user["id"], item_id)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    player = casino.load(user["id"])
    return jsonify({
        "ok": True,
        "pet": pet_data,
        "balance": int(player.get("balance") or 0),
    })


@bp.route("/equip", methods=["POST", "OPTIONS"])
def equip_item():
    if request.method == "OPTIONS":
        return "", 204

    user, failure = _user_and_error()
    if failure:
        return failure

    data = request.get_json(silent=True) or {}
    item_id = data.get("itemId")

    pet_data, error = pet.equip_item(user["id"], item_id)
    if error:
        return jsonify({"ok": False, "error": error}), 400

    return jsonify({
        "ok": True,
        "pet": pet_data,
    })
