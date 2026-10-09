# -*- coding: utf-8 -*-
"""
HTTP-API магазина: покупка за тугрики.

Всё требует подписи Telegram: покупка списывает тугрики и создаёт
заказ, поэтому без подписи здесь делать нечего.
"""

from flask import Blueprint, jsonify, request

import auth
import casino
import shop

bp = Blueprint("shop", __name__)

# Кому уходит оплата и кого звать при покупке
_admin_id = None
_notify = None


def init_app(app, admin_id=None, notify=None):
    global _admin_id, _notify
    _admin_id = admin_id
    _notify = notify
    app.register_blueprint(bp)


def _buyer():
    """
    Кто покупает. Возвращает (пользователь, готовый ответ об ошибке).

    current_user отдаёт пару: пользователя и причину отказа. Раньше
    я принял её за словарь и получил пятисотую вместо понятного отказа.
    """
    user, error = auth.current_user()

    if error or not user:
        return None, (
            jsonify({"ok": False, "error": error or "Нужна авторизация"}),
            401,
        )

    return user, None


@bp.route("/api/shop", methods=["GET", "OPTIONS"])
def api_shop():
    """Витрина: товары, баланс покупателя и его заказы."""
    if request.method == "OPTIONS":
        return "", 204

    user, failure = _buyer()
    if failure:
        return failure

    return jsonify(shop.get_state(user["id"]))


@bp.route("/api/shop/buy", methods=["POST", "OPTIONS"])
def api_buy():
    """Покупка. Ждём имя и контакт: без них заказ некому передать."""
    if request.method == "OPTIONS":
        return "", 204

    user, failure = _buyer()
    if failure:
        return failure

    payload = request.get_json(silent=True) or {}

    order, error = shop.buy(
        user["id"],
        user.get("name") or "",
        payload.get("productId"),
        payload.get("name"),
        payload.get("contact"),
        admin_id=_admin_id,
    )

    if error:
        return jsonify({"ok": False, "error": error}), 400

    # Уведомление администратору. Ошибка отправки не должна отменять
    # покупку: заказ уже сохранён, деньги списаны, товар обещан
    if _notify:
        try:
            _notify(order)
        except Exception as e:
            print("[SHOP] уведомление не ушло:", e)

    return jsonify({
        "ok": True,
        "order": order,
        "player": casino.serialize(user["id"]),
    })
