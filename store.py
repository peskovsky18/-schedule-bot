# -*- coding: utf-8 -*-
"""
Хранилище: Redis (Upstash) в проде, память — для тестов и локального запуска.

Вынесено отдельно, потому что теперь им пользуются двое: шахматы и музыка.
Держать это в шахматном модуле и импортировать оттуда музыку было бы
странно — получилась бы зависимость «музыка знает про шахматы».

Upstash говорит по REST, поэтому отдельная библиотека не нужна: хватает
requests. Важное ограничение: размер одного запроса — 10 МБ
(проверено запросом, сверх этого приходит HTTP 413).
"""

import os
import time

import requests


class MemoryStore:
    """
    Хранилище в памяти процесса.

    Годится для тестов и локального запуска. В проде не подходит:
    у Render диск эфемерный, и данные исчезнут при первом же перезапуске.
    """

    def __init__(self):
        self._data = {}
        self._expires = {}

    def get(self, key):
        expires = self._expires.get(key)
        if expires and expires < time.time():
            self._data.pop(key, None)
            self._expires.pop(key, None)
            return None
        return self._data.get(key)

    def set(self, key, value, ttl=None):
        self._data[key] = value
        if ttl:
            self._expires[key] = time.time() + ttl
        else:
            self._expires.pop(key, None)

    def delete(self, key):
        self._data.pop(key, None)
        self._expires.pop(key, None)

    def clear(self):
        self._data.clear()
        self._expires.clear()


class RedisStore:
    """
    Upstash Redis через REST.

    Команда передаётся массивом в теле POST-запроса, ответ приходит
    в поле result. Так работает REST-API Upstash, отдельный клиент
    Redis не нужен.
    """

    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token

        # Пул соединений здесь НЕ используется, и это осознанно.
        # Замер показал: живое соединение отвечает за 40 мс против
        # 175 мс, но чтение снимка расписания через него падало два
        # раза из четырёх — Upstash закрывает соединение после ответа,
        # и повторное использование бьётся в мёртвый сокет. Надёжность
        # важнее скорости: лучше пять предсказуемых запросов, чем
        # один быстрый и три упавших.

    def _command(self, *args, timeout=15):
        response = self.session.post(self.url, json=list(args), timeout=timeout)
        response.raise_for_status()
        return response.json().get("result")

    def get(self, key, timeout=15):
        return self._command("GET", key, timeout=timeout)

    def set(self, key, value, ttl=None):
        if ttl:
            return self._command("SET", key, value, "EX", int(ttl))
        return self._command("SET", key, value)

    def delete(self, key):
        return self._command("DEL", key)


_store = None


def get_store():
    """
    Выбирает хранилище по переменным окружения.

    UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN задаются в панели
    Render. Без них работает память — приложение не падает, просто
    данные не переживут перезапуск.
    """
    global _store

    if _store is not None:
        return _store

    url = (os.getenv("UPSTASH_REDIS_REST_URL") or "").strip()
    token = (os.getenv("UPSTASH_REDIS_REST_TOKEN") or "").strip()

    if url and token:
        print("[STORE] хранение: Upstash Redis")
        _store = RedisStore(url, token)
    else:
        print("[STORE] хранение: память (данные не переживут перезапуск)")
        _store = MemoryStore()

    return _store


def set_store(store):
    """Подменяет хранилище. Нужно тестам и локальным прогонам."""
    global _store
    _store = store
    return store


def build_id(alphabet, length):
    """Случайный идентификатор. Общий для партий и треков."""
    import secrets

    return "".join(secrets.choice(alphabet) for _ in range(length))
