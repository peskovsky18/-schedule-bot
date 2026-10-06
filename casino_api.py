# -*- coding: utf-8 -*-
"""
HTTP-API казино.

Все действия требуют подписи Telegram: монеты привязаны к человеку, и без
проверки личности любой мог бы крутить за чужой счёт. Результат прокрута
тоже считает сервер — клиент только показывает то, что ему вернули.
"""

from flask import Blueprint, jsonify, request

import auth
import casino

bp = Blueprint("casino", __name__)


def init_app(app):
    app.register_blueprint(bp)


def _player():
    user, error = auth.current_user()
    if error:
        return None, (jsonify({"ok": False, "error": error}), 401)
    return user, None


@bp.route("/api/casino", methods=["GET"])
def api_state():
    """Баланс, серия входов и настройки автомата."""
    user, failure = _player()
    if failure:
        return failure

    return jsonify({"ok": True, "player": casino.serialize(user["id"])})


@bp.route("/api/casino/claim", methods=["POST"])
def api_claim():
    """
    Начисляет монеты за сегодняшний вход.

    Приложение зовёт это при каждом запуске, поэтому повторный вызов
    в тот же день — не ошибка, а обычная ситуация: вернём состояние
    и ноль начислений.
    """
    user, failure = _player()
    if failure:
        return failure

    record, gained, bonus, error = casino.claim(user["id"])
    if error:
        return jsonify({"ok": False, "error": error}), 400

    return jsonify({
        "ok": True,
        "gained": gained,
        "bonus": bonus,
        "player": casino.serialize(user["id"]),
    })


@bp.route("/api/casino/spin", methods=["POST"])
def api_spin():
    """Прокрут барабанов."""
    user, failure = _player()
    if failure:
        return failure

    payload = request.get_json(silent=True) or {}
    result, error = casino.spin(user["id"], payload.get("bet"))

    if error:
        return jsonify({"ok": False, "error": error}), 400

    return jsonify({
        "ok": True,
        "result": result,
        "player": casino.serialize(user["id"]),
    })
