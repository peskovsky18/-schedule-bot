# -*- coding: utf-8 -*-
"""
Музыка: добавление треков прямо из мини-приложения.

Мини-приложение статическое, файлы ему хранить негде. Поэтому загруженное
аудио уходит в Redis (Upstash) в base64, а метаданные — отдельным списком.

Ограничение взято из живого замера: Upstash отклоняет запрос длиннее
10 485 760 байт (HTTP 413). Base64 раздувает данные примерно на треть,
поэтому предел файла — 6 МБ: это 8 МБ в base64, с запасом до потолка.
"""

import base64
import json
import time

import store

# Ключи в хранилище
INDEX_KEY = "music:index"
AUDIO_PREFIX = "music:audio:"

# Предел на файл. Считаем по исходному размеру, не по base64.
MAX_UPLOAD_BYTES = 6 * 1024 * 1024

# Что принимаем. Список намеренно короткий: всё, что реально играется
# в браузере телефона.
ALLOWED_TYPES = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
}

ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
ID_LENGTH = 10

# Сколько треков держим. Бесплатный Upstash — 256 МБ, и шесть мегабайт
# на трек при горстке людей упирается в потолок задолго до этого числа.
MAX_TRACKS = 60


# =========================
# СПИСОК
# =========================
def list_tracks():
    """Все добавленные треки. Встроенные живут в config.js и сюда не входят."""
    raw = store.get_store().get(INDEX_KEY)
    if not raw:
        return []

    try:
        tracks = json.loads(raw)
    except (ValueError, TypeError):
        return []

    return tracks if isinstance(tracks, list) else []


def save_tracks(tracks):
    store.get_store().set(INDEX_KEY, json.dumps(tracks, ensure_ascii=False))
    return tracks


def find(track_id):
    for track in list_tracks():
        if track.get("id") == track_id:
            return track
    return None


def total_bytes():
    return sum(int(t.get("size") or 0) for t in list_tracks())


# =========================
# ДОБАВЛЕНИЕ
# =========================
def add_file(player, title, audio_bytes, content_type):
    """
    Добавляет загруженный файл.

    Возвращает (трек, ошибка).
    """
    title = (title or "").strip()

    if not title:
        return None, "Укажите название трека"

    if not audio_bytes:
        return None, "Файл пустой"

    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        limit = MAX_UPLOAD_BYTES // (1024 * 1024)
        return None, f"Файл больше {limit} МБ — выберите поменьше"

    kind = ALLOWED_TYPES.get((content_type or "").split(";")[0].strip().lower())
    if not kind:
        return None, "Это не похоже на аудиофайл. Подойдут mp3, m4a, ogg, wav"

    tracks = list_tracks()

    if len(tracks) >= MAX_TRACKS:
        return None, f"Уже {MAX_TRACKS} треков — больше не поместится"

    track = {
        "id": store.build_id(ID_ALPHABET, ID_LENGTH),
        "title": title[:80],
        "kind": "file",
        "contentType": content_type.split(";")[0].strip().lower(),
        "size": len(audio_bytes),
        "addedBy": player.get("name") or "Кто-то",
        "addedById": player.get("id"),
        "created": int(time.time()),
    }

    # Аудио кладём до записи в список: если сорвётся на большом файле,
    # в списке не останется трека без звука
    store.get_store().set(
        AUDIO_PREFIX + track["id"],
        base64.b64encode(audio_bytes).decode("ascii"),
    )

    tracks.append(track)
    save_tracks(tracks)

    return track, None


def add_link(player, title, url):
    """Добавляет трек ссылкой: файл лежит где-то ещё."""
    title = (title or "").strip()
    url = (url or "").strip()

    if not title:
        return None, "Укажите название трека"

    if not url.lower().startswith(("http://", "https://")):
        return None, "Ссылка должна начинаться с http:// или https://"

    tracks = list_tracks()

    if len(tracks) >= MAX_TRACKS:
        return None, f"Уже {MAX_TRACKS} треков — больше не поместится"

    track = {
        "id": store.build_id(ID_ALPHABET, ID_LENGTH),
        "title": title[:80],
        "kind": "link",
        "url": url[:500],
        "size": 0,
        "addedBy": player.get("name") or "Кто-то",
        "addedById": player.get("id"),
        "created": int(time.time()),
    }

    tracks.append(track)
    save_tracks(tracks)

    return track, None


def remove(track_id, user_id, admin_id=None):
    """
    Удаляет трек.

    Свой трек может удалить автор, любой — администратор. Иначе
    в общем списке можно было бы стереть что угодно чужое.
    """
    tracks = list_tracks()

    for index, track in enumerate(tracks):
        if track.get("id") != track_id:
            continue

        is_author = track.get("addedById") == user_id
        is_admin = admin_id is not None and user_id == admin_id

        if not is_author and not is_admin:
            return None, "Удалять можно только свои треки"

        tracks.pop(index)
        save_tracks(tracks)
        store.get_store().delete(AUDIO_PREFIX + track_id)

        return track, None

    return None, "Трек не найден"


# =========================
# ЧТЕНИЕ АУДИО
# =========================
def audio_of(track_id):
    """
    Возвращает (base64, тип) для отдачи клиенту.

    Отдаём base64 как есть: раскодированием и нарезкой по Range
    занимается HTTP-слой. Здесь только хранилище.
    """
    track = find(track_id)

    if not track or track.get("kind") != "file":
        return None, None

    payload = store.get_store().get(AUDIO_PREFIX + track_id)
    if not payload:
        return None, None

    return payload, track.get("contentType") or "audio/mpeg"


def serialize(track, user_id=None, admin_id=None):
    """
    Трек для клиента.

    src — либо путь на нашем сервере, либо чужая ссылка. Клиент сам
    решает, что подставить впереди: путь начинается с косой черты.
    """
    is_author = user_id is not None and track.get("addedById") == user_id
    is_admin = user_id is not None and admin_id is not None and user_id == admin_id

    return {
        "id": track.get("id"),
        "title": track.get("title"),
        "src": track.get("url") if track.get("kind") == "link" else f"/api/music/{track.get('id')}/audio",
        "custom": True,
        "size": track.get("size") or 0,
        "addedBy": track.get("addedBy"),
        "created": track.get("created"),
        "canDelete": bool(is_author or is_admin),
    }
