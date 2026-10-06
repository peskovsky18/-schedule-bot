# -*- coding: utf-8 -*-
"""
Проверка подписи Telegram WebApp.

Мини-приложение присылает initData в заголовке X-Telegram-Init-Data,
сервер проверяет HMAC-SHA256 секретом из токена бота. Без этого
«я — это я» ничем не подтверждается: ни в шахматах, ни в музыке.

Вынесено отдельно, потому что проверяют двое.
"""

import hashlib
import hmac
import json
import os
import urllib.parse

from flask import request

# Токен бота. Проставляется при настройке приложения.
_bot_token = None

# Режим отладки: разрешает работать без подписи Telegram.
# Нужен только для локального запуска в браузере, где initData пустая.
# В проде быть не должно — тогда личность не проверяется вообще.
DEV_AUTH = os.getenv("CHESS_DEV_AUTH") == "1"


def configure(bot_token):
    global _bot_token
    _bot_token = bot_token

    if DEV_AUTH:
        print("[AUTH] ВНИМАНИЕ: CHESS_DEV_AUTH=1 — подпись Telegram не проверяется")


def verify_init_data(init_data, bot_token):
    """
    Проверяет подпись initData из Telegram WebApp.

    Алгоритм из документации: секрет — HMAC-SHA256 от токена бота
    с ключом «WebAppData», затем HMAC-SHA256 от строки данных.
    """
    if not init_data or not bot_token:
        return None

    try:
        pairs = urllib.parse.parse_qsl(
            init_data, strict_parsing=True, keep_blank_values=True
        )
    except ValueError:
        return None

    data = dict(pairs)
    received = data.pop("hash", None)

    if not received:
        return None

    check_string = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))

    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    calculated = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated, received):
        return None

    try:
        user = json.loads(data.get("user") or "{}")
    except ValueError:
        return None

    if not user.get("id"):
        return None

    return user


def _raw_init_data():
    """initData приходит заголовком, из тела или из строки запроса."""
    value = request.headers.get("X-Telegram-Init-Data")
    if value:
        return value

    payload = request.get_json(silent=True)
    if isinstance(payload, dict) and payload.get("initData"):
        return payload["initData"]

    return request.args.get("initData")


def current_user():
    """
    Возвращает (пользователь, ошибка).

    Пользователь — словарь с id и именем, как его отдаёт Telegram.
    """
    init_data = _raw_init_data()

    if init_data:
        user = verify_init_data(init_data, _bot_token)
        if user:
            return {
                "id": user["id"],
                "name": user.get("first_name") or user.get("username") or "Игрок",
            }, None
        return None, "Подпись Telegram не совпала"

    if DEV_AUTH:
        user_id = request.headers.get("X-Dev-User-Id") or request.args.get("devUserId")
        if user_id:
            try:
                user_id = int(user_id)
            except ValueError:
                return None, "Некорректный X-Dev-User-Id"

            return {
                "id": user_id,
                "name": request.headers.get("X-Dev-User-Name") or f"Игрок {user_id}",
            }, None

    return None, "Нужна авторизация через Telegram"
