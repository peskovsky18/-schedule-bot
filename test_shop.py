# -*- coding: utf-8 -*-
"""
Тесты ППРСД shop: покупка, проверки, перевод тугриков администратору.

Запуск:

    ../.venv/bin/python test_shop.py
"""

import os
import sys

os.environ.setdefault("TOKEN", "123456:TEST")
os.environ["CHESS_DEV_AUTH"] = "1"

import casino
import shop
import store

failed = 0


def check(name, got, want):
    global failed
    ok = got == want
    if not ok:
        failed += 1
    print(f"  {'✓' if ok else '✗'} {name}" + ("" if ok else f" → получили {got!r}, ждали {want!r}"))


def truthy(name, got, extra=""):
    global failed
    ok = bool(got)
    if not ok:
        failed += 1
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {extra}" if extra else ""))


store.set_store(store.MemoryStore())

ADMIN = 439819918

print("=== Товар ===")
check("товар один", len(shop.PRODUCTS), 1)

item = shop.PRODUCTS[0]
check("название", item["title"], "Подарочная карта «Золотое Яблоко»")
check("номинал в рублях", item["nominal"], 300)
check("цена в тугриках", item["price"], 30000)
truthy("есть пояснение", bool(item["note"]))
check("поиск по идентификатору", shop.product("goldapple300")["id"], "goldapple300")
check("неизвестный товар", shop.product("нет такого"), None)

print("\n=== Витрина ===")
state = shop.get_state(101)
check("товары отданы", len(state["products"]), 1)
check("баланс показан", state["balance"], 0)
check("заказов пока нет", len(state["orders"]), 0)

print("\n=== Наличие ===")
check("товар помечен отсутствующим", shop.PRODUCTS[0].get("available"), False)
check("состояние сообщает о наличии", shop.get_state(101)["products"][0]["available"], False)

casino.add_coins(101, 50000)
check("покупка отклонена", shop.buy(101, "Алиса", "goldapple300", "Алиса", "@alice", ADMIN)[1],
      "Товара нет в наличии")
check("тугрики не списаны", casino.load(101)["balance"], 50000)
check("заказ не создан", len(shop.orders_of(101)), 0)

print("\n=== Проверки перед покупкой (товар вернули в продажу) ===")
# Дальше проверяем остальные правила, поэтому временно включаем продажу
shop.PRODUCTS[0]["available"] = True
casino.save(101, dict(casino.default_record(), balance=0))
check("без тугриков", shop.buy(101, "Алиса", "goldapple300", "Алиса", "@alice", ADMIN)[1],
      "Не хватает тугриков: нужно 30000, на счету 0")

casino.add_coins(101, 30000)

check("без имени", shop.buy(101, "Алиса", "goldapple300", "   ", "@alice", ADMIN)[1],
      "Укажите ваше имя")
check("без контакта", shop.buy(101, "Алиса", "goldapple300", "Алиса", "  ", ADMIN)[1],
      "Укажите ваш ID или ник в Telegram")
check("слишком длинное имя",
      shop.buy(101, "Алиса", "goldapple300", "я" * 61, "@alice", ADMIN)[1],
      "Имя и контакт не длиннее 60 символов")
check("неизвестный товар",
      shop.buy(101, "Алиса", "чего-нет", "Алиса", "@alice", ADMIN)[1],
      "Такого товара нет")
check("ничего не списалось", casino.load(101)["balance"], 30000)

print("\n=== Покупка ===")
order, error = shop.buy(101, "Алиса", "goldapple300", "Алиса Иванова", "@alice", ADMIN)
check("ошибки нет", error, None)
truthy("заказ создан", order is not None)
check("товар в заказе", order["title"], "Подарочная карта «Золотое Яблоко»")
check("номинал записан", order["nominal"], 300)
check("цена записана", order["price"], 30000)
check("имя покупателя", order["name"], "Алиса Иванова")
check("контакт", order["contact"], "@alice")
check("кто купил", order["buyerId"], 101)
truthy("есть идентификатор", len(order["id"]) == shop.ID_LENGTH, order["id"])
truthy("идентификатор из понятных знаков",
       all(c in shop.ID_ALPHABET for c in order["id"]), order["id"])

check("у покупателя списалось", casino.load(101)["balance"], 0)
check("администратору зачислено", casino.load(ADMIN)["balance"], 30000)

print("\n=== Заказ сохранён ===")
state = shop.get_state(101)
check("заказ виден покупателю", len(state["orders"]), 1)
check("и это тот самый", state["orders"][0]["id"], order["id"])
check("чужого заказа не видно", len(shop.orders_of(202)), 0)

print("\n=== Повторная покупка не проходит: тугриков уже нет ===")
check("вторая покупка", shop.buy(101, "Алиса", "goldapple300", "Алиса", "@alice", ADMIN)[1],
      "Не хватает тугриков: нужно 30000, на счету 0")
check("администратору не прибавилось", casino.load(ADMIN)["balance"], 30000)

print("\n=== Общее количество не растёт ===")
before = casino.load(101)["balance"] + casino.load(ADMIN)["balance"]
casino.add_coins(202, 30000)
shop.buy(202, "Боб", "goldapple300", "Боб", "@bob", ADMIN)
after = casino.load(101)["balance"] + casino.load(ADMIN)["balance"] + casino.load(202)["balance"]
check("тугрики переходят, а не создаются", after, before + 30000)

print("\n=== Без администратора покупка всё равно проходит ===")
casino.add_coins(303, 30000)
order, error = shop.buy(303, "Кто-то", "goldapple300", "Имя", "@ник", None)
check("покупка состоялась", error, None)
check("списалось у покупателя", casino.load(303)["balance"], 0)
check("заказ сохранён", len(shop.orders_of(303)), 1)

print("\n=== Через API ===")
import bot

client = bot.app.test_client()
H = {"X-Dev-User-Id": "404", "X-Dev-User-Name": "Покупатель"}

check("витрина без подписи", client.get("/api/shop").status_code, 401)
check("покупка без подписи",
      client.post("/api/shop/buy", json={"productId": "goldapple300"}).status_code, 401)

state = client.get("/api/shop", headers=H).get_json()
check("витрина отдана", state["ok"], True)
check("баланс", state["balance"], 0)

casino.add_coins(404, 30000)

response = client.post("/api/shop/buy", headers=H, json={
    "productId": "goldapple300", "name": "Тест", "contact": "@test",
})
check("покупка принята", response.status_code, 200)
body = response.get_json()
check("ответ ок", body["ok"], True)
check("баланс в ответе", body["player"]["balance"], 0)
check("заказ в ответе", body["order"]["name"], "Тест")
check("администратору ушло", casino.load(bot.ADMIN_ID)["balance"] >= 30000, True)

response = client.post("/api/shop/buy", headers=H, json={
    "productId": "goldapple300", "name": "Тест", "contact": "@test",
})
check("повторно не хватает", response.status_code, 400)
truthy("сказано почему", "тугриков" in response.get_json()["error"],
       response.get_json()["error"])

# Возвращаем товар в исходное состояние, чтобы не влиять на другие проверки
shop.PRODUCTS[0]["available"] = False

print()
if failed:
    print(f"❌ Провалено проверок: {failed}")
    sys.exit(1)
print("✅ Все проверки пройдены")
