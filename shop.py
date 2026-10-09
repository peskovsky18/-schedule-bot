# -*- coding: utf-8 -*-
"""
ППРСД shop: покупка за тугрики.

Товар один — подарочная карта в «Золотое Яблоко». Покупка списывает
тугрики у покупателя и зачисляет их администратору: это перевод,
а не создание новых, поэтому общее количество не растёт.

Заказ сохраняется в хранилище. Даже если уведомление в Telegram
не уйдёт, покупка не потеряется — её видно в списке заказов.
"""

import json
import time

import casino
import store

# Что продаётся. Цена в тугриках, номинал в рублях
PRODUCTS = [
    {
        "id": "goldapple300",
        "title": "Подарочная карта «Золотое Яблоко»",
        "nominal": 300,
        "price": 30000,
        "note": "Карта номиналом 300 ₽. После покупки с вами свяжутся.",
    },
]

# Алфавит без похожих друг на друга знаков: по идентификатору
# заказа человек может его называть, и путать 0 с O не хочется
ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
ID_LENGTH = 8

ORDERS_KEY = "shop:orders"
MAX_ORDERS = 200


def product(product_id):
    """Товар по идентификатору или None."""
    for item in PRODUCTS:
        if item["id"] == product_id:
            return item
    return None


def serialize_product(item):
    """Товар для приложения."""
    return {
        "id": item["id"],
        "title": item["title"],
        "nominal": item["nominal"],
        "price": item["price"],
        "note": item["note"],
    }


def load_orders():
    """Все заказы, новые первыми."""
    try:
        raw = store.get_store().get(ORDERS_KEY)
        if not raw:
            return []
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except Exception as e:
        print("[SHOP] не удалось прочитать заказы:", e)
        return []


def save_order(order):
    """Дописывает заказ. Старые вытесняются, чтобы список не рос вечно."""
    try:
        orders = load_orders()
        orders.insert(0, order)
        store.get_store().set(
            ORDERS_KEY,
            json.dumps(orders[:MAX_ORDERS], ensure_ascii=False),
        )
    except Exception as e:
        print("[SHOP] не удалось сохранить заказ:", e)


def orders_of(user_id):
    """Заказы конкретного человека."""
    return [o for o in load_orders() if o.get("buyerId") == user_id]


def get_state(user_id):
    """Состояние магазина для приложения."""
    player = casino.load(user_id)

    return {
        "ok": True,
        "products": [serialize_product(p) for p in PRODUCTS],
        "balance": int(player.get("balance") or 0),
        "orders": orders_of(user_id),
    }


def buy(user_id, buyer_name, product_id, name, contact, admin_id=None):
    """
    Покупка. Возвращает (заказ, ошибка).

    Тугрики списываются у покупателя и зачисляются администратору.
    Если зачисление не удалось, списание всё равно остаётся: заказ
    сохранён, и разобраться можно вручную.
    """
    item = product(product_id)
    if not item:
        return None, "Такого товара нет"

    name = (name or "").strip()
    contact = (contact or "").strip()

    if not name:
        return None, "Укажите ваше имя"
    if not contact:
        return None, "Укажите ваш ID или ник в Telegram"
    if len(name) > 60 or len(contact) > 60:
        return None, "Имя и контакт не длиннее 60 символов"

    record, error = casino.spend(user_id, item["price"])
    if error:
        return None, error

    # Перевод администратору: тугрики не создаются, а переходят
    if admin_id:
        try:
            casino.add_coins(admin_id, item["price"])
        except Exception as e:
            print("[SHOP] не удалось зачислить администратору:", e)

    order = {
        "id": store.build_id(ID_ALPHABET, ID_LENGTH),
        "productId": item["id"],
        "title": item["title"],
        "nominal": item["nominal"],
        "price": item["price"],
        "buyerId": user_id,
        "buyerName": buyer_name or "",
        "name": name,
        "contact": contact,
        "at": int(time.time()),
    }

    save_order(order)
    print(f"[SHOP] {buyer_name} ({user_id}) купил «{item['title']}» за {item['price']}")

    return order, None
