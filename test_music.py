# -*- coding: utf-8 -*-
"""
Тесты музыки: добавление файлом и ссылкой, удаление, отдача звука.

Запуск (нужен виртуальный интерпретатор проекта):

    ../.venv/bin/python test_music.py

Flask-часть поднимается в режиме отладочной авторизации, чтобы
не собирать подпись Telegram на каждый запрос.
"""

import io
import os
import sys

os.environ.setdefault("TOKEN", "123456:TEST")
os.environ["CHESS_DEV_AUTH"] = "1"

import music

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


# =========================
print("=== Подготовка ===")
import store

store.set_store(store.MemoryStore())

ALICE = {"id": 101, "name": "Алиса"}
BOB = {"id": 202, "name": "Боб"}
ADMIN = 999

# Небольшой «mp3»: содержимое неважно, важен размер и тип
def fake_audio(size_kb=64):
    return bytes(range(256)) * (size_kb * 4)


print("\n=== Добавление файлом ===")
track, error = music.add_file(ALICE, "  Мой трек  ", fake_audio(64), "audio/mpeg")
check("файл принят", error, None)
truthy("идентификатор выдан", bool(track["id"]), track["id"] if track else "")
check("название обрезано по краям", track["title"], "Мой трек")
check("тип — файл", track["kind"], "file")
check("размер записан", track["size"], 64 * 1024)
check("автор записан", track["addedBy"], "Алиса")
check("список содержит трек", len(music.list_tracks()), 1)
check("занято байт", music.total_bytes(), 64 * 1024)

payload, content_type = music.audio_of(track["id"])
truthy("звук лежит в хранилище", bool(payload))
check("тип содержимого сохранён", content_type, "audio/mpeg")

import base64

check("звук не испорчен", base64.b64decode(payload), fake_audio(64))

print("\n=== Что не принимаем ===")
_, error = music.add_file(ALICE, "", fake_audio(1), "audio/mpeg")
truthy("пустое название отклонено", error is not None, error)

_, error = music.add_file(ALICE, "Трек", b"", "audio/mpeg")
truthy("пустой файл отклонён", error is not None, error)

_, error = music.add_file(ALICE, "Трек", fake_audio(1), "image/jpeg")
truthy("не аудио отклонено", error is not None, error)

_, error = music.add_file(ALICE, "Трек", fake_audio(1), None)
truthy("без типа отклонено", error is not None, error)

# Предел из живого замера: Upstash режет запрос на 10 МБ, base64
# раздувает на треть, поэтому файл ограничен шестью мегабайтами
big = b"x" * (music.MAX_UPLOAD_BYTES + 1)
_, error = music.add_file(ALICE, "Огромный", big, "audio/mpeg")
truthy("слишком большой файл отклонён", error is not None, error)
truthy("в ошибке сказано про размер", "МБ" in (error or ""), error)

print("\n=== Определение типа файла ===")

# Телефон нередко отдаёт вместо типа общий application/octet-stream —
# по одному MIME такие файлы не принять, спасает расширение
check("обычный MIME", music.guess_type("audio/mpeg"), "audio/mpeg")
check("MIME с параметрами", music.guess_type("audio/mpeg; charset=binary"), "audio/mpeg")
check("MIME с регистром", music.guess_type("AUDIO/MPEG"), "audio/mpeg")

check("общий тип + mp3", music.guess_type("application/octet-stream", "song.mp3"), "audio/mpeg")
check("пустой тип + m4a", music.guess_type("", "track.m4a"), "audio/mp4")
check("пустой тип + wav", music.guess_type(None, "sound.wav"), "audio/wav")
check("расширение в верхнем регистре", music.guess_type("", "TRACK.MP3"), "audio/mpeg")
check("путь целиком", music.guess_type("", "/storage/emulated/0/Download/Песня.mp3"), "audio/mpeg")

check("картинка отклонена", music.guess_type("image/jpeg", "photo.jpg"), None)
check("видео отклонено", music.guess_type("video/mp4", "clip.mp4"), None)
check("неизвестное расширение", music.guess_type("", "file.xyz"), None)
check("мусор", music.guess_type("чепуха", "файл"), None)

truthy("is_audio согласован", music.is_audio("application/octet-stream", "a.mp3"))
truthy("is_audio для картинки ложь", not music.is_audio("image/png", "a.png"))

# Файл с общим типом, но правильным расширением должен приниматься.
# Чистить хранилище целиком нельзя: выше уже лежит трек, и дальше
# проверки считают его в списке — убираем только то, что добавили здесь.
odd, error = music.add_file(
    {"id": 900, "name": "Телефон"}, "С телефона", fake_audio(16),
    "application/octet-stream", "track.mp3",
)
check("файл с общим типом принят", error, None)
check("тип определён по расширению", odd["contentType"] if odd else None, "audio/mpeg")

# А теперь настоящая картинка — отказ
_, error = music.add_file(
    {"id": 901, "name": "Телефон"}, "Картинка", fake_audio(4), "image/jpeg", "photo.jpg",
)
truthy("картинка отклонена", error is not None, error)

music.remove(odd["id"], 900, None)

print("\n=== Добавление ссылкой ===")
link, error = music.add_link(BOB, "Трек по ссылке", "https://example.com/song.mp3")
check("ссылка принята", error, None)
check("тип — ссылка", link["kind"], "link")
check("ссылка сохранена", link["url"], "https://example.com/song.mp3")
check("размер нулевой (файл не у нас)", link["size"], 0)

_, error = music.add_link(BOB, "Плохая", "ftp://example.com/song.mp3")
truthy("не http отклонено", error is not None, error)

_, error = music.add_link(BOB, "", "https://example.com/song.mp3")
truthy("пустое название отклонено", error is not None, error)

print("\n=== Что видит клиент ===")
alice_view = music.serialize(track, ALICE["id"], ADMIN)
check("свой трек можно удалить", alice_view["canDelete"], True)
check("путь к звуку", alice_view["src"], f"/api/music/{track['id']}/audio")
check("пометка «свой»", alice_view["custom"], True)

bob_view = music.serialize(track, BOB["id"], ADMIN)
check("чужой трек удалить нельзя", bob_view["canDelete"], False)

admin_view = music.serialize(track, ADMIN, ADMIN)
check("администратор может удалить любой", admin_view["canDelete"], True)

guest_view = music.serialize(track, None, ADMIN)
check("без авторизации удалять нельзя", guest_view["canDelete"], False)

link_view = music.serialize(link, BOB["id"], ADMIN)
check("у ссылки src — сама ссылка", link_view["src"], "https://example.com/song.mp3")

print("\n=== Удаление ===")
_, error = music.remove(track["id"], BOB["id"], ADMIN)
truthy("чужой трек удалить нельзя", error is not None, error)
check("трек на месте", len(music.list_tracks()), 2)

_, error = music.remove(track["id"], ADMIN, ADMIN)
check("администратор удаляет чужой", error, None)
check("осталось два трека", len(music.list_tracks()), 1)
check("звук удалён вместе с треком", music.audio_of(track["id"]), (None, None))

_, error = music.remove("неттакого", ALICE["id"], ADMIN)
truthy("несуществующий трек", error is not None, error)

_, error = music.remove(link["id"], BOB["id"], ADMIN)
check("автор удаляет свой", error, None)
check("список пуст", music.list_tracks(), [])

print("\n=== Предел на число треков ===")
store.get_store().clear()
for i in range(music.MAX_TRACKS):
    music.add_link(ALICE, f"Трек {i}", "https://example.com/a.mp3")
check("набралось до предела", len(music.list_tracks()), music.MAX_TRACKS)
_, error = music.add_link(ALICE, "Лишний", "https://example.com/b.mp3")
truthy("сверх предела не добавляется", error is not None, error)

store.get_store().clear()


# =========================
print("\n=== HTTP-API ===")
import bot

client = bot.app.test_client()

ALICE_HEADERS = {"X-Dev-User-Id": "101", "X-Dev-User-Name": "Алиса"}
BOB_HEADERS = {"X-Dev-User-Id": "202", "X-Dev-User-Name": "Боб"}

response = client.get("/api/music")
check("список доступен без авторизации", response.status_code, 200)
check("список пуст", response.get_json()["tracks"], [])
truthy("предел размера сообщается клиенту",
       response.get_json()["maxUploadBytes"] == music.MAX_UPLOAD_BYTES)

response = client.post("/api/music")
check("без авторизации загрузка отклонена", response.status_code, 401)

# Файлом — так делает мини-приложение
response = client.post(
    "/api/music",
    headers=ALICE_HEADERS,
    data={
        "title": "Загруженный трек",
        "audio": (io.BytesIO(fake_audio(32)), "song.mp3"),
    },
    content_type="multipart/form-data",
)
check("загрузка файлом", response.status_code, 200)
uploaded = response.get_json()["track"]
check("название дошло", uploaded["title"], "Загруженный трек")
truthy("размер посчитан", response.get_json()["usedBytes"] > 0)

response = client.get("/api/music", headers=BOB_HEADERS)
check("трек виден другому", len(response.get_json()["tracks"]), 1)
check("чужой трек помечен как неудаляемый",
      response.get_json()["tracks"][0]["canDelete"], False)

# Ссылкой
response = client.post(
    "/api/music",
    headers=BOB_HEADERS,
    json={"title": "Ссылкой", "url": "https://example.com/b.mp3"},
)
check("загрузка ссылкой", response.status_code, 200)
check("список вырос", len(client.get("/api/music").get_json()["tracks"]), 2)

response = client.post(
    "/api/music",
    headers=BOB_HEADERS,
    json={"title": "Плохая", "url": "не ссылка"},
)
check("плохая ссылка отклонена", response.status_code, 400)

print("\n=== Звук по HTTP ===")
audio_url = uploaded["src"]
check("путь из ответа", audio_url, f"/api/music/{uploaded['id']}/audio")

response = client.get(audio_url)
check("звук отдаётся", response.status_code, 200)
check("тип содержимого", response.headers["Content-Type"], "audio/mpeg")
check("размер совпадает", len(response.data), 32 * 1024)
check("заявлена поддержка Range", response.headers.get("Accept-Ranges"), "bytes")
check("содержимое не испорчено", response.data, fake_audio(32))

# Range нужен, чтобы работала перемотка в плеере
response = client.get(audio_url, headers={"Range": "bytes=0-1023"})
check("частичный запрос", response.status_code, 206)
check("отдано ровно 1024 байта", len(response.data), 1024)
check("заголовок Content-Range", response.headers.get("Content-Range"),
      f"bytes 0-1023/{32 * 1024}")
check("кусок совпадает", response.data, fake_audio(32)[:1024])

response = client.get(audio_url, headers={"Range": "bytes=1000-"})
check("открытый конец диапазона", response.status_code, 206)
check("отдано до конца", len(response.data), 32 * 1024 - 1000)

response = client.get("/api/music/неттакого/audio")
check("несуществующий трек", response.status_code, 404)

print("\n=== Удаление по HTTP ===")
response = client.post(f"/api/music/{uploaded['id']}/delete", headers=BOB_HEADERS)
check("чужой трек не удалить", response.status_code, 403)

response = client.post(f"/api/music/{uploaded['id']}/delete", headers=ALICE_HEADERS)
check("автор удаляет", response.status_code, 200)
check("список уменьшился", len(client.get("/api/music").get_json()["tracks"]), 1)
check("звук больше не отдаётся", client.get(audio_url).status_code, 404)

print("\n=== Подпись Telegram обязательна ===")
response = client.post(
    "/api/music",
    headers={"X-Telegram-Init-Data": "мусор"},
    json={"title": "Хакер", "url": "https://example.com/x.mp3"},
)
check("с плохой подписью не пройдёт", response.status_code, 401)

print("\n=== CORS ===")
response = client.options(
    "/api/music",
    headers={
        "Origin": "https://peskovsky18.github.io",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "X-Telegram-Init-Data",
    },
)
truthy("POST разрешён",
       "POST" in response.headers.get("Access-Control-Allow-Methods", ""))
truthy("заголовок подписи разрешён",
       "X-Telegram-Init-Data" in response.headers.get("Access-Control-Allow-Headers", ""))

print(
    "\n✅ Все проверки пройдены"
    if failed == 0
    else f"\n❌ Провалено проверок: {failed}"
)

sys.exit(0 if failed == 0 else 1)
