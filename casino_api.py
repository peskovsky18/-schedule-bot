# -*- coding: utf-8 -*-
"""
HTTP-API казино.

Все действия требуют подписи Telegram: тугрики привязаны к человеку, и без
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
    Начисляет тугрики за сегодняшний вход.

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

    # Разовый подарок. Отметка ставится на сервере, поэтому второй
    # заход его не повторит, а приложение получит None и промолчит
    gift = casino.grant_gift(user["id"])

    return jsonify({
        "ok": True,
        "gained": gained,
        "bonus": bonus,
        "gift": gift,
        "player": casino.serialize(user["id"]),
    })


@bp.route("/api/casino/promo", methods=["POST"])
def api_promo():
    """
    Секретный пароль из раздела техподдержки.

    Проверка только здесь: если сверять пароль в браузере, любой
    посмотрит исходники и получит тугрики без него. Ограничения
    на количество раз нет — сколько введёте, столько и начислим.
    """
    user, failure = _player()
    if failure:
        return failure

    payload = request.get_json(silent=True) or {}
    record, gained, error = casino.check_promo(user["id"], payload.get("password"))

    if error:
        return jsonify({"ok": False, "error": error}), 403

    return jsonify({
        "ok": True,
        "gained": gained,
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
