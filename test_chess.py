# -*- coding: utf-8 -*-
"""
Тесты шахмат: правила, хранение, проверка подписи и HTTP-API.

Запуск (нужен виртуальный интерпретатор проекта):

    ../.venv/bin/python test_chess.py

Flask-часть поднимает приложение в режиме отладочной авторизации,
чтобы не собирать настоящую подпись Telegram на каждый запрос.
"""

import hashlib
import hmac
import json
import os
import sys
import urllib.parse

# Отладочная авторизация нужна ДО импорта bot.py: он читает переменные
# окружения на уровне модуля
os.environ.setdefault("TOKEN", "123456:TEST")
os.environ["CHESS_DEV_AUTH"] = "1"

import chess
import chess_game

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
print("=== Хранилище в памяти ===")
store = chess_game.set_store(chess_game.MemoryStore())

store.set("a", "1")
check("запись и чтение", store.get("a"), "1")
store.delete("a")
check("удаление", store.get("a"), None)
check("несуществующий ключ", store.get("нет"), None)

store.set("t", "v", ttl=1)
check("с TTL сразу доступен", store.get("t"), "v")


# =========================
print("\n=== Создание и присоединение ===")
store.clear()

alice = {"id": 101, "name": "Алиса"}
bob = {"id": 202, "name": "Боб"}
carol = {"id": 303, "name": "Карol"}

game = chess_game.create_game(alice)
check("статус — ждём соперника", game["status"], "waiting")
check("создатель за белых", game["white"]["id"], 101)
check("чёрных пока нет", game["black"], None)
check("ходов нет", game["moves"], [])
check("длина идентификатора", len(game["id"]), chess_game.ID_LENGTH)

reloaded = chess_game.load_game(game["id"])
check("партия читается из хранилища", reloaded["id"], game["id"])
check("несуществующая партия", chess_game.load_game("неттакой"), None)

game, err = chess_game.join_game(game, bob)
check("присоединение без ошибки", err, None)
check("Боб за чёрных", game["black"]["id"], 202)
check("статус — идёт игра", game["status"], "active")

_, err = chess_game.join_game(game, carol)
truthy("третьего не пускаем", err is not None, err)

game, err = chess_game.join_game(game, bob)
check("повторный заход Боба не ломает", err, None)

check("цвет Алисы", chess_game.player_color(game, 101), "white")
check("цвет Боба", chess_game.player_color(game, 202), "black")
check("Карol не участник", chess_game.player_color(game, 303), None)


# =========================
print("\n=== Проверка ходов ===")
_, err = chess_game.apply_move(game, 202, "e7", "e5")
truthy("Боб не может ходить первым", err is not None, err)

_, err = chess_game.apply_move(game, 101, "e2", "e5")
truthy("нелегальный ход отклонён", err is not None, err)

_, err = chess_game.apply_move(game, 303, "e2", "e4")
truthy("посторонний ходить не может", err is not None, err)

game, err = chess_game.apply_move(game, 101, "e2", "e4")
check("легальный ход принят", err, None)
check("ход записан", game["moves"], ["e2e4"])
check("теперь ход чёрных", chess_game.serialize(game, 101)["turn"], "black")

_, err = chess_game.apply_move(game, 101, "d2", "d4")
truthy("два раза подряд нельзя", err is not None, err)


# =========================
print("\n=== Мат: детский мат ===")
store.clear()
fool = chess_game.create_game(alice)
fool, _ = chess_game.join_game(fool, bob)

for who, frm, to in [(101, "f2", "f3"), (202, "e7", "e5"),
                     (101, "g2", "g4"), (202, "d8", "h4")]:
    fool, err = chess_game.apply_move(fool, who, frm, to)
    if err:
        print(f"    неожиданная ошибка на {frm}{to}: {err}")
        failed += 1
        break

check("партия закончена", fool["status"], "finished")
check("результат — победа чёрных", fool["result"], "0-1")
state = chess_game.serialize(fool, 202)
truthy("мат зафиксирован", state["isCheckmate"])


# =========================
print("\n=== Мат в один ход: подсказки ===")
store.clear()
mate = chess_game.create_game(alice)
mate, _ = chess_game.join_game(mate, bob)

# 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# — мат на 4-м ходу белых
line = [(101, "e2", "e4"), (202, "e7", "e5"), (101, "f1", "c4"), (202, "b8", "c6"),
        (101, "d1", "h5"), (202, "g8", "f6"), (101, "h5", "f7")]
for who, frm, to in line:
    mate, err = chess_game.apply_move(mate, who, frm, to)
    if err:
        print(f"    ошибка на {frm}{to}: {err}")
        failed += 1
        break

check("мат распознан", mate["status"], "finished")
check("победа белых", mate["result"], "1-0")


# =========================
print("\n=== Сдача ===")
store.clear()
res = chess_game.create_game(alice)
res, _ = chess_game.join_game(res, bob)
res, err = chess_game.resign(res, 101)
check("сдача принята", err, None)
check("победа чёрных", res["result"], "0-1")
_, err = chess_game.resign(res, 202)
truthy("после конца партии сдаться нельзя", err is not None, err)


# =========================
print("\n=== Подсказки ходов ===")
store.clear()
hints = chess_game.create_game(alice)
hints, _ = chess_game.join_game(hints, bob)

white_view = chess_game.serialize(hints, 101)
black_view = chess_game.serialize(hints, 202)

truthy("белые видят подсказки", len(white_view["legal"]) > 0,
       f"{len(white_view['legal'])} клеток")
check("подсказки у чёрных пусты (не их ход)", black_view["legal"], {})
check("из e2 доступно два хода", sorted(white_view["legal"]["e2"]), ["e3", "e4"])

spectator = chess_game.serialize(hints, 999)
check("зритель не получает подсказок", spectator["legal"], {})


# =========================
print("\n=== Проверка подписи Telegram ===")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chess_api

# Токен должен совпадать с тем, что видит приложение, иначе подпись
# не сойдётся и проверка личности не пройдёт
BOT_TOKEN = os.environ["TOKEN"]


def make_init_data(token, user, extra=None):
    data = {
        "auth_date": "1700000000",
        "query_id": "AAA",
        "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")),
    }
    if extra:
        data.update(extra)

    check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    data["hash"] = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()

    return urllib.parse.urlencode(data)


valid = make_init_data(BOT_TOKEN, {"id": 555, "first_name": "Тест"})
user = chess_api.verify_init_data(valid, BOT_TOKEN)
truthy("правильная подпись принята", user is not None)
check("из подписи достаётся id", user["id"] if user else None, 555)

check("чужой токен не проходит", chess_api.verify_init_data(valid, "другой:ТОКЕН"), None)
check("пустая строка не проходит", chess_api.verify_init_data("", BOT_TOKEN), None)
check("мусор не проходит", chess_api.verify_init_data("не=данные", BOT_TOKEN), None)

tampered = valid.replace("555", "999")
check("подделанный id не проходит", chess_api.verify_init_data(tampered, BOT_TOKEN), None)

stripped = urllib.parse.urlencode(
    {k: v for k, v in urllib.parse.parse_qsl(valid) if k != "hash"}
)
check("без hash не проходит", chess_api.verify_init_data(stripped, BOT_TOKEN), None)


# =========================
print("\n=== HTTP-API ===")
import bot

client = bot.app.test_client()

# Заглушаем отправку сообщений сразу: иначе тестовые ходы будут
# по-настоящему стучаться в Telegram с фиктивным токеном и ждать
# таймаута, а в лог посыпятся 401
stub_messages = []
bot.bot.send_message = lambda chat_id, text, **kw: stub_messages.append(
    {"chat": chat_id, "text": text, "markup": kw.get("reply_markup")}
)

ALICE = {"X-Dev-User-Id": "101", "X-Dev-User-Name": "Алиса"}
BOB = {"X-Dev-User-Id": "202", "X-Dev-User-Name": "Боб"}
CAROL = {"X-Dev-User-Id": "303"}

status = client.get("/api/chess/status").get_json()
check("хранилище в тестах — память", status["storage"], "memory")
check("отладочная авторизация включена", status["devAuth"], True)

response = client.post("/api/chess/new")
check("без авторизации отказ", response.status_code, 401)

response = client.post("/api/chess/new", headers=ALICE)
check("создание партии", response.status_code, 200)
created = response.get_json()["game"]
truthy("идентификатор выдан", bool(created["id"]), created["id"])
check("Алиса за белых", created["you"], "white")

game_id = created["id"]

response = client.post(f"/api/chess/{game_id}/join", headers=BOB)
check("Боб присоединился", response.status_code, 200)
check("Боб за чёрных", response.get_json()["game"]["you"], "black")

response = client.post(f"/api/chess/{game_id}/join", headers=CAROL)
check("третий не пускается", response.status_code, 409)

response = client.get(f"/api/chess/{game_id}")
check("состояние без авторизации доступно", response.status_code, 200)
check("зритель без цвета", response.get_json()["game"]["you"], None)

response = client.post(f"/api/chess/{game_id}/move", headers=BOB,
                       json={"from": "e7", "to": "e5"})
check("ход не в свою очередь", response.status_code, 409)

response = client.post(f"/api/chess/{game_id}/move", headers=ALICE,
                       json={"from": "e2", "to": "e5"})
check("нелегальный ход", response.status_code, 409)

response = client.post(f"/api/chess/{game_id}/move", headers=ALICE,
                       json={"from": "e2", "to": "e4"})
check("легальный ход принят", response.status_code, 200)
check("ход в истории", response.get_json()["game"]["moves"], ["e2e4"])

response = client.post(f"/api/chess/{game_id}/move", headers=ALICE, json={"to": "e5"})
check("без поля from — ошибка запроса", response.status_code, 400)

response = client.post("/api/chess/неттакой/join", headers=BOB)
check("несуществующая партия", response.status_code, 404)

response = client.get(f"/api/chess/{game_id}", headers={"X-Telegram-Init-Data": "мусор"})
check("плохая подпись Telegram", response.status_code, 200)

response = client.post(f"/api/chess/{game_id}/move",
                       headers={"X-Telegram-Init-Data": "мусор"},
                       json={"from": "e7", "to": "e5"})
check("ход с плохой подписью отклонён", response.status_code, 401)

response = client.post(f"/api/chess/{game_id}/move",
                       headers={"X-Telegram-Init-Data": make_init_data(BOT_TOKEN, {"id": 101})},
                       json={"from": "e7", "to": "e5"})
truthy("ход с настоящей подписью проходит проверку личности",
       response.status_code in (200, 409), f"код {response.status_code}")

response = client.options("/api/chess/new",
                          headers={"Origin": "https://pprsd.netlify.app",
                                   "Access-Control-Request-Method": "POST",
                                   "Access-Control-Request-Headers": "X-Telegram-Init-Data"})
allow_headers = response.headers.get("Access-Control-Allow-Headers", "")
truthy("CORS разрешает заголовок авторизации", "X-Telegram-Init-Data" in allow_headers, allow_headers)
truthy("CORS разрешает POST", "POST" in response.headers.get("Access-Control-Allow-Methods", ""))


# =========================
print("\n=== Приглашение через бота ===")

# Перехватываем отправку сообщений, чтобы проверить, что бот отвечает
sent = []
bot.bot.send_message = lambda chat_id, text, **kw: sent.append(
    {"chat": chat_id, "text": text, "markup": kw.get("reply_markup")}
)


class FakeMessage:
    """Мини-заглушка сообщения Telegram: обработчику нужно немного."""

    def __init__(self, user_id, name, text):
        self.from_user = type("U", (), {"id": user_id, "first_name": name})()
        self.chat = type("C", (), {"id": user_id})()
        self.text = text


# Партия, где белые — 101
created = client.post("/api/chess/new", headers=ALICE).get_json()["game"]
invite_id = created["id"]

# 1. MINIAPP_URL не задан — присоединить должны, но кнопки не будет
saved_url = bot.MINIAPP_URL
bot.MINIAPP_URL = ""
sent.clear()
bot.start(FakeMessage(202, "Боб", f"/start {invite_id}"))
truthy("бот ответил на приглашение", len(sent) == 1, f"{len(sent)} сообщений")
truthy("сообщение про ненастроенное приложение",
       "MINIAPP_URL" in (sent[0]["text"] if sent else ""),
       sent[0]["text"][:60] if sent else "")

joined = chess_game.load_game(invite_id)
check("приглашённый всё равно посажен за чёрных", joined["black"]["id"] if joined["black"] else None, 202)

# 2. С настроенным адресом — приходит кнопка с доской
bot.MINIAPP_URL = "https://pprsd.netlify.app"
sent.clear()
bot.start(FakeMessage(202, "Боб", f"/start {invite_id}"))
truthy("бот ответил", len(sent) >= 1)

first = sent[0] if sent else {}
truthy("текст про приглашение", "пригласили" in first.get("text", "").lower() or "ваша" in first.get("text", "").lower(),
       first.get("text", "")[:60])

markup = first.get("markup")
button = markup.keyboard[0][0] if markup and markup.keyboard else None
truthy("есть кнопка", button is not None)
if button:
    check("текст кнопки", button.text, "Открыть доску")
    truthy("кнопка открывает мини-апп с этой партией",
           button.web_app and invite_id in button.web_app.url,
           button.web_app.url if button.web_app else "нет web_app")

# 3. Повторный переход по своей же ссылке не ломает партию
sent.clear()
bot.start(FakeMessage(202, "Боб", f"/start {invite_id}"))
truthy("повторный заход обрабатывается", len(sent) >= 1, sent[0]["text"][:50] if sent else "")

# 4. Несуществующая партия — понятное сообщение, а не приветствие
sent.clear()
bot.start(FakeMessage(202, "Боб", "/start неттакойпартии"))
truthy("несуществующая партия", "недоступна" in (sent[0]["text"] if sent else ""),
       sent[0]["text"][:60] if sent else "")

# 5. Обычный /start без параметра работает как раньше
sent.clear()
bot.start(FakeMessage(303, "Карol", "/start"))
truthy("обычный запуск показывает меню",
       "Бот запущен" in (sent[0]["text"] if sent else ""),
       sent[0]["text"][:40] if sent else "")

bot.MINIAPP_URL = saved_url


# =========================
print("\n=== Тугрики за победу ===")

import casino

# Мат в один ход: побеждают белые
store.clear()
coins = chess_game.create_game(alice)
coins, _ = chess_game.join_game(coins, bob)

for who, frm, to in [(101, "e2", "e4"), (202, "e7", "e5"), (101, "f1", "c4"),
                     (202, "b8", "c6"), (101, "d1", "h5"), (202, "g8", "f6"),
                     (101, "h5", "f7")]:
    coins, err = chess_game.apply_move(coins, who, frm, to)
    if err:
        print("    ошибка:", err)
        break

check("партия кончилась матом", coins["status"], "finished")
check("до начисления у белых пусто", casino.load(101)["balance"], 0)

# Начисляет HTTP-слой, поэтому зовём его так же, как он
winner = chess_api._award_winner(coins)
check("победитель определён", winner, 101)
check("белым начислено", casino.load(101)["balance"], casino.CHESS_WIN_COINS)
check("чёрным ничего", casino.load(202)["balance"], 0)

# Повторный вызов не должен начислить дважды: партия уже закончена,
# но защищаемся и здесь
chess_api._award_winner(coins)
check("дважды не начисляют", casino.load(101)["balance"], casino.CHESS_WIN_COINS)

# Сдача: побеждает соперник
store.clear()
casino.save(101, casino.default_record())
casino.save(202, casino.default_record())

resign_game = chess_game.create_game(alice)
resign_game, _ = chess_game.join_game(resign_game, bob)

# Сдаётся Боб — тугрики Алисе
winner = chess_api._award_winner(resign_game)
check("незаконченная партия никому не даёт тугриков", winner, None)

resign_game, _ = chess_game.resign(resign_game, 202)
winner = chess_api._award_winner(resign_game)
check("при сдаче побеждает соперник", winner, 101)
check("тугрики у победителя", casino.load(101)["balance"], casino.CHESS_WIN_COINS)
check("сдавшийся без тугриков", casino.load(202)["balance"], 0)

# Ничья не даёт никому
store.clear()
casino.save(101, casino.default_record())
casino.save(202, casino.default_record())

draw = chess_game.create_game(alice)
draw, _ = chess_game.join_game(draw, bob)
draw["status"] = "finished"
draw["result"] = "1/2-1/2"

winner = chess_api._award_winner(draw)
check("за ничью тугриков нет", winner, None)
check("белым ничего", casino.load(101)["balance"], 0)
check("чёрным ничего", casino.load(202)["balance"], 0)

# И в ответе API награда указана
store.clear()
state = chess_game.create_game(alice)
serialized = chess_api._state(state, 101)
check("награда указана в состоянии партии",
      serialized["reward"], casino.CHESS_WIN_COINS)


# =========================
print("\n=== Уведомления о ходах ===")

import time as time_module

notified = []
bot.bot.send_message = lambda chat_id, text, **kw: notified.append(
    {"chat": chat_id, "text": text, "markup": kw.get("reply_markup")}
)

# Кнопка «Открыть доску» появляется только при заданном адресе приложения
bot.MINIAPP_URL = "https://pprsd.netlify.app"


def wait_for_notifications(count=1, limit=2.0):
    """Уведомления уходят в отдельном потоке — даём им время."""
    deadline = time_module.time() + limit
    while time_module.time() < deadline and len(notified) < count:
        time_module.sleep(0.05)
    return len(notified)


# Партия 101 (белые) против 202 (чёрные)
notif = client.post("/api/chess/new", headers=ALICE).get_json()["game"]
nid = notif["id"]
client.post(f"/api/chess/{nid}/join", headers=BOB)

notified.clear()
client.post(f"/api/chess/{nid}/move", headers=ALICE, json={"from": "e2", "to": "e4"})
wait_for_notifications()

check("пришло одно уведомление", len(notified), 1)
check("уведомление ушло сопернику (чёрным)", notified[0]["chat"] if notified else None, 202)
truthy("текст про ход", "Ваш ход" in (notified[0]["text"] if notified else ""),
       notified[0]["text"] if notified else "")
truthy("есть кнопка «Открыть доску»",
       bool(notified and notified[0]["markup"] and notified[0]["markup"].keyboard))

# Тот, кто сходил, уведомления получать не должен
notified.clear()
client.post(f"/api/chess/{nid}/move", headers=BOB, json={"from": "e7", "to": "e5"})
wait_for_notifications()
check("белым тоже сообщили", notified[0]["chat"] if notified else None, 101)

# Шах — отдельный текст
notified.clear()
client.post(f"/api/chess/{nid}/move", headers=ALICE, json={"from": "f1", "to": "c4"})
wait_for_notifications()
client.post(f"/api/chess/{nid}/move", headers=BOB, json={"from": "b8", "to": "c6"})
wait_for_notifications(2)
client.post(f"/api/chess/{nid}/move", headers=ALICE, json={"from": "d1", "to": "h5"})
wait_for_notifications(3)
client.post(f"/api/chess/{nid}/move", headers=BOB, json={"from": "g8", "to": "f6"})
wait_for_notifications(4)

notified.clear()
client.post(f"/api/chess/{nid}/move", headers=ALICE, json={"from": "h5", "to": "f7"})
wait_for_notifications()
truthy("о мате сообщается отдельно",
       "Мат" in (notified[0]["text"] if notified else ""),
       notified[0]["text"] if notified else "")
check("партия закончена матом", chess_game.load_game(nid)["status"], "finished")

# Сдача
resign_game = client.post("/api/chess/new", headers=ALICE).get_json()["game"]
rid = resign_game["id"]
client.post(f"/api/chess/{rid}/join", headers=BOB)

notified.clear()
client.post(f"/api/chess/{rid}/resign", headers=ALICE)
wait_for_notifications()
truthy("о сдаче сообщается отдельно",
       "сдался" in (notified[0]["text"] if notified else "").lower(),
       notified[0]["text"] if notified else "")
check("уведомление о сдаче ушло чёрным", notified[0]["chat"] if notified else None, 202)

# Если Telegram недоступен, ход всё равно должен пройти
def broken_send(*args, **kwargs):
    raise RuntimeError("Telegram недоступен")

bot.bot.send_message = broken_send

broken_game = client.post("/api/chess/new", headers=ALICE).get_json()["game"]
bid = broken_game["id"]
client.post(f"/api/chess/{bid}/join", headers=BOB)

response = client.post(f"/api/chess/{bid}/move", headers=ALICE,
                       json={"from": "d2", "to": "d4"})
check("ход проходит, даже если уведомление не ушло", response.status_code, 200)
time_module.sleep(0.3)
check("ход всё равно записан", chess_game.load_game(bid)["moves"], ["d2d4"])

bot.MINIAPP_URL = saved_url


# =========================
print("\n=== Отмена партии, к которой не присоединились ===")

abandoned = client.post("/api/chess/new", headers=ALICE).get_json()["game"]
aid = abandoned["id"]

response = client.post(f"/api/chess/{aid}/cancel", headers=BOB)
check("посторонний отменить не может", response.status_code, 409)

response = client.post(f"/api/chess/{aid}/cancel")
check("без авторизации отменить нельзя", response.status_code, 401)

truthy("партия пока на месте", chess_game.load_game(aid) is not None)

response = client.post(f"/api/chess/{aid}/cancel", headers=ALICE)
check("создатель отменяет свою партию", response.status_code, 200)
check("партия удалена", chess_game.load_game(aid), None)

response = client.post(f"/api/chess/{aid}/cancel", headers=ALICE)
check("повторная отмена — партии уже нет", response.status_code, 404)

# Начавшуюся партию отменять нельзя: для этого есть сдача
started = client.post("/api/chess/new", headers=ALICE).get_json()["game"]
sid = started["id"]
client.post(f"/api/chess/{sid}/join", headers=BOB)

response = client.post(f"/api/chess/{sid}/cancel", headers=ALICE)
check("начатую партию отменить нельзя", response.status_code, 409)
truthy("подсказка про сдачу", "сдава" in response.get_json().get("error", "").lower(),
       response.get_json().get("error", ""))
truthy("партия не удалена", chess_game.load_game(sid) is not None)


# =========================
print("\n=== Не дёргаем того, кто смотрит на доску ===")

# Возвращаем записывающую заглушку: в прошлом разделе send_message
# специально бросал исключение, чтобы проверить поведение при сбое
notified.clear()
bot.bot.send_message = lambda chat_id, text, **kw: notified.append(
    {"chat": chat_id, "text": text, "markup": kw.get("reply_markup")}
)

watch = client.post("/api/chess/new", headers=ALICE).get_json()["game"]
wid = watch["id"]
client.post(f"/api/chess/{wid}/join", headers=BOB)

# Боб открывает доску
client.get(f"/api/chess/{wid}", headers=BOB)
truthy("просмотр доски отмечен", chess_api.seen_recently(wid, 202))

notified.clear()
client.post(f"/api/chess/{wid}/move", headers=ALICE, json={"from": "e2", "to": "e4"})
time_module.sleep(0.4)
check("смотрящему на доску не пишем", len(notified), 0)

# Прошло время — теперь писать нужно
chess_api.SEEN_WINDOW = 0
notified.clear()
client.post(f"/api/chess/{wid}/move", headers=BOB, json={"from": "e7", "to": "e5"})
wait_for_notifications()
check("отвлёкшемуся пишем", len(notified), 1)
check("сообщение ушло белым", notified[0]["chat"] if notified else None, 101)

# Зритель не считается смотрящим: он не участник партии
chess_api.SEEN_WINDOW = 90
chess_api._seen.clear()
client.get(f"/api/chess/{wid}", headers=CAROL)
truthy("посторонний просмотр не отмечается", not chess_api.seen_recently(wid, 303))

# Отметки не растут бесконечно
chess_api._seen.clear()
for i in range(600):
    chess_api._seen[("игра", i)] = 0
chess_api.forget_old_seen()
truthy("старые отметки вычищаются", len(chess_api._seen) < 600, f"осталось {len(chess_api._seen)}")
chess_api._seen.clear()


# =========================
print("\n=== Хранилище Upstash (на локальной заглушке) ===")

import http.server
import threading


class FakeRedis(http.server.BaseHTTPRequestHandler):
    """
    Заглушка REST-API Upstash: команда приходит массивом, ответ — {"result": ...}.

    Настоящий Upstash здесь не нужен: проверяем, что наш клиент правильно
    формирует команды и заголовки. Иначе ошибку в хранилище мы увидим
    только на проде, уже с людьми в партиях.
    """

    data = {}
    auth = []
    commands = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        command = json.loads(self.rfile.read(length) or b"[]")

        FakeRedis.commands.append(command)
        FakeRedis.auth.append(self.headers.get("Authorization"))

        name = str(command[0]).upper()
        result = None

        if name == "SET":
            FakeRedis.data[command[1]] = command[2]
            result = "OK"
        elif name == "GET":
            result = FakeRedis.data.get(command[1])
        elif name == "DEL":
            result = 1 if FakeRedis.data.pop(command[1], None) is not None else 0

        body = json.dumps({"result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), FakeRedis)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

redis = chess_game.RedisStore(f"http://127.0.0.1:{port}", "test-token-abc123")

redis.set("ключ", "значение")
check("запись и чтение через REST", redis.get("ключ"), "значение")
truthy("токен уходит в заголовке Authorization",
       bool(FakeRedis.auth) and FakeRedis.auth[0] == "Bearer test-token-abc123",
       FakeRedis.auth[0] if FakeRedis.auth else "заголовка нет")

redis.set("срок", "в", ttl=60)
truthy("срок жизни передаётся командой EX", "EX" in FakeRedis.commands[-1],
       str(FakeRedis.commands[-1]))

redis.delete("ключ")
check("удаление", redis.get("ключ"), None)
check("несуществующий ключ", redis.get("нет"), None)

# Партия должна переживать «перезапуск»: читаем её через новый объект
chess_game.set_store(redis)
redis_game = chess_game.create_game({"id": 1, "name": "Тест"})
reborn = chess_game.load_game(redis_game["id"])
truthy("партия легла в Redis, а не в память", reborn is not None)
check("идентификатор тот же", reborn["id"] if reborn else None, redis_game["id"])

# И сам выбор хранилища по переменным окружения
os.environ["UPSTASH_REDIS_REST_URL"] = f"http://127.0.0.1:{port}"
os.environ["UPSTASH_REDIS_REST_TOKEN"] = "test-token-abc123"
chess_game.set_store(None)
chosen = chess_game.get_store()
truthy("при заданных переменных выбирается Redis",
       isinstance(chosen, chess_game.RedisStore), type(chosen).__name__)

# Без переменных — снова память, приложение не падает
del os.environ["UPSTASH_REDIS_REST_URL"]
del os.environ["UPSTASH_REDIS_REST_TOKEN"]
chess_game.set_store(None)
fallback = chess_game.get_store()
truthy("без переменных — память", isinstance(fallback, chess_game.MemoryStore),
       type(fallback).__name__)

server.shutdown()


# =========================
print(
    "\n✅ Все проверки пройдены"
    if failed == 0
    else f"\n❌ Провалено проверок: {failed}"
)

sys.exit(0 if failed == 0 else 1)
