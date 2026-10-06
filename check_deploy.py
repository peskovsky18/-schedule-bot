# -*- coding: utf-8 -*-
"""
Проверка деплоя бота. Запускается локально, токен никуда не отправляется,
кроме самого Telegram.

    TOKEN=123456:ABC... python check_deploy.py

Что проверяет:
  1. Токен действителен (getMe).
  2. Webhook зарегистрирован и указывает на ваш сервис (getWebhookInfo).
  3. Нет ли ошибок доставки и зависших обновлений.
  4. Отвечает ли /health самого сервиса и разобрано ли расписание.
"""

import os
import sys

import requests

TOKEN = os.getenv("TOKEN")

if not TOKEN:
    sys.exit("Задайте TOKEN: TOKEN=123456:ABC... python check_deploy.py")

API = f"https://api.telegram.org/bot{TOKEN}"


def call(method, **params):
    r = requests.get(f"{API}/{method}", params=params, timeout=25)
    data = r.json()

    if not data.get("ok"):
        sys.exit(f"Telegram ответил ошибкой на {method}: {data.get('description')}")

    return data["result"]


print("=" * 60)
print("1. ТОКЕН")
print("=" * 60)

me = call("getMe")
print(f"  Бот: @{me['username']} — {me.get('first_name', '')}")
print(f"  ID:  {me['id']}")

print()
print("=" * 60)
print("2. WEBHOOK")
print("=" * 60)

info = call("getWebhookInfo")
url = info.get("url") or ""

if not url:
    print("  ❌ Webhook НЕ зарегистрирован — бот не получит ни одного сообщения.")
    print("     Проверьте переменную RENDER_EXTERNAL_URL в настройках сервиса")
    print("     и логи запуска: там должна быть строка «[WEBHOOK] зарегистрирован».")
else:
    print(f"  ✅ URL: {url}")
    print(f"  Ожидает обновлений: {info.get('pending_update_count', 0)}")

    if info.get("last_error_message"):
        print(f"  ⚠️  Последняя ошибка: {info['last_error_message']}")
        print("      Частая причина — сервис спал и не ответил вовремя.")
    else:
        print("  Ошибок доставки нет")

    if info.get("ip_address"):
        print(f"  IP: {info['ip_address']}")

print()
print("=" * 60)
print("3. САМ СЕРВИС")
print("=" * 60)

if not url:
    print("  Пропущено: адрес сервиса неизвестен без webhook.")
else:
    base = "/".join(url.split("/")[:3])

    try:
        r = requests.get(f"{base}/health", timeout=70)
        data = r.json()

        print(f"  GET {base}/health → HTTP {r.status_code}")
        print(f"  статус:    {data.get('status')}")
        print(f"  расписание: {data.get('dates')} дней, {data.get('lessons')} пар")
        print(f"  кэш:       {data.get('cache_age')}")

        if not data.get("ready"):
            print("  ℹ️  Кэш пуст: расписание ещё ни разу не запрашивалось.")
            print("     Проверить принудительно: " + base + "/health?deep=1")

    except Exception as e:
        print(f"  ❌ Не удалось получить /health: {e}")
        print("     Если сервис спал, первая попытка может занять до минуты —")
        print("     просто запустите скрипт ещё раз.")

print()
print("=" * 60)
print("Готово. Отправьте боту /start — он должен ответить меню.")
print("=" * 60)
