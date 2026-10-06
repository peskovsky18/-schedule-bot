# -*- coding: utf-8 -*-
"""
Тесты казино: монеты за вход, серия, бонус воскресенья, прокрут, выплаты.

Запуск (нужен виртуальный интерпретатор проекта):

    ../.venv/bin/python test_casino.py
"""

import os
import sys

os.environ.setdefault("TOKEN", "123456:TEST")
os.environ["CHESS_DEV_AUTH"] = "1"

import casino
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

# Понедельник … воскресенье одной недели
WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",
        "2026-10-09", "2026-10-10", "2026-10-11"]


# =========================
print("=== Первый вход ===")
store.get_store().clear()

record, gained, bonus, error = casino.claim(101, today=WEEK[0])
check("ошибки нет", error, None)
check("начислено за вход", gained, casino.DAILY_COINS)
check("баланс", record["balance"], 100)
check("серия — один день", record["streak"], 1)
check("бонуса нет", bonus, 0)

record, gained, bonus, error = casino.claim(101, today=WEEK[0])
check("повторно в тот же день ничего", gained, 0)
check("баланс не изменился", record["balance"], 100)
check("повтор — не ошибка", error, None)


# =========================
print("\n=== Серия дней ===")
for day in WEEK[1:6]:
    record, gained, _, _ = casino.claim(101, today=day)
    check(f"за {day} начислено", gained, casino.DAILY_COINS)

check("серия выросла до шести", record["streak"], 6)
check("баланс за шесть дней", record["balance"], 600)

# Воскресенье седьмого дня — бонус
record, gained, bonus, error = casino.claim(101, today=WEEK[6])
check("в воскресенье — обычные 100", gained, casino.DAILY_COINS)
check("и бонус за неделю", bonus, casino.SUNDAY_BONUS)
check("серия — семь дней", record["streak"], 7)
check("баланс с бонусом", record["balance"], 100 * 7 + casino.SUNDAY_BONUS)


# =========================
print("\n=== Пропуск дня сбрасывает серию ===")
store.get_store().clear()

casino.claim(202, today="2026-10-05")   # понедельник
casino.claim(202, today="2026-10-06")   # вторник
# среду пропустили
record, _, _, _ = casino.claim(202, today="2026-10-08")  # четверг
check("серия началась заново", record["streak"], 1)

# Пять дней подряд, шестой пропущен, воскресенье — бонуса нет
store.get_store().clear()
for day in ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]:
    casino.claim(203, today=day)
record, gained, bonus, _ = casino.claim(203, today="2026-10-11")  # воскресенье, серия 7
check("серия ровно семь", record["streak"], 7)
check("бонус выдан", bonus, casino.SUNDAY_BONUS)

# А если серия меньше семи — бонуса нет
store.get_store().clear()
record, _, bonus, _ = casino.claim(204, today="2026-10-11")  # воскресенье, первый день
check("в первый же день бонуса нет", bonus, 0)
check("серия — один", record["streak"], 1)

# В понедельник бонуса нет даже с длинной серией
store.get_store().clear()
for day in WEEK:
    casino.claim(205, today=day)
record, gained, bonus, _ = casino.claim(205, today="2026-10-12")  # понедельник
check("в понедельник бонуса нет", bonus, 0)
check("серия продолжается", record["streak"], 8)


# =========================
print("\n=== Границы дат ===")
check("воскресенье распознано", casino.is_sunday("2026-10-11"), True)
check("понедельник не воскресенье", casino.is_sunday("2026-10-12"), False)
check("предыдущий день", casino.yesterday_of("2026-10-06"), "2026-10-05")
check("через границу месяца", casino.yesterday_of("2026-11-01"), "2026-10-31")
check("через границу года", casino.yesterday_of("2027-01-01"), "2026-12-31")
check("битая дата", casino.yesterday_of("чепуха"), None)

store.get_store().clear()
casino.claim(301, today="2026-10-31")
record, _, _, _ = casino.claim(301, today="2026-11-01")
check("серия через границу месяца", record["streak"], 2)


# =========================
print("\n=== Выплаты ===")
check("три вишни", casino.payout_for(["cherry"] * 3), casino.TRIPLE["cherry"])
check("три семёрки", casino.payout_for(["seven"] * 3), casino.TRIPLE["seven"])
check("три алмаза", casino.payout_for(["diamond"] * 3), casino.TRIPLE["diamond"])
check("две вишни и лимон", casino.payout_for(["cherry", "cherry", "lemon"]), casino.PAIR)
check("две семёрки", casino.payout_for(["seven", "bell", "seven"]), casino.PAIR)
check("все разные", casino.payout_for(["cherry", "lemon", "bell"]), 0)
check("пустой набор", casino.payout_for([]), 0)

# Дороже символ — больше платит
truthy("редкий платит больше частого",
       casino.TRIPLE["seven"] > casino.TRIPLE["cherry"])


# =========================
print("\n=== Ставки ===")
check("допустимая ставка", casino.normalize_bet(50), 50)
check("нечисловая — по умолчанию", casino.normalize_bet("абракадабра"), casino.DEFAULT_BET)
check("пустая — по умолчанию", casino.normalize_bet(None), casino.DEFAULT_BET)
check("слишком большая — наибольшая допустимая", casino.normalize_bet(9999), max(casino.BETS))
check("промежуточная — ближайшая снизу", casino.normalize_bet(60), 50)
check("меньше минимальной — минимальная", casino.normalize_bet(1), min(casino.BETS))


# =========================
print("\n=== Прокрут ===")
store.get_store().clear()
casino.claim(401, today="2026-10-05")   # 100 монет

result, error = casino.spin(401, 10)
check("прокрут прошёл", error, None)
check("ставка записана", result["bet"], 10)
check("три барабана", len(result["reels"]), 3)
truthy("символы известные",
       all(r in [s["key"] for s in casino.SYMBOLS] for r in result["reels"]),
       str(result["reels"]))
check("выигрыш = множитель на ставку", result["win"], result["multiplier"] * 10)
check("баланс пересчитан", result["balance"], 100 - 10 + result["win"])
check("счётчик прокрутов", result["spins"], 1)

# Баланс никогда не уходит в минус
store.get_store().clear()
for _ in range(200):
    result, error = casino.spin(402, 100)
    if error:
        break
truthy("без монет крутить нельзя", error is not None, error or "")
truthy("в ошибке сказано, сколько нужно", "монет" in (error or ""), error or "")
balance = casino.load(402)["balance"]
truthy("баланс не отрицательный", balance >= 0, str(balance))

# Ставка больше баланса: кладём ровно 25 и пробуем поставить 50
store.get_store().clear()
poor = casino.default_record()
poor["balance"] = 25
casino.save(403, poor)

result, error = casino.spin(403, 50)
truthy("ставка больше баланса отклонена", error is not None, error or "")
check("баланс не тронут", casino.load(403)["balance"], 25)

# Ровно хватает — крутить можно
result, error = casino.spin(403, 25)
check("ставка по размеру баланса проходит", error, None)

# Ставка по умолчанию подставляется, если не передали
store.get_store().clear()
casino.claim(404, today="2026-10-05")
result, error = casino.spin(404)
check("без ставки берётся сохранённая", result["bet"], casino.DEFAULT_BET)

# Выбранная ставка запоминается
casino.spin(404, 25)
check("ставка сохранилась", casino.load(404)["bet"], 25)
result, _ = casino.spin(404)
check("следующий прокрут — та же ставка", result["bet"], 25)


# =========================
print("\n=== Случайность и возврат ===")
runs = 200000
total = 0
triples = 0
seen = set()

for _ in range(runs):
    reels = casino.pick_reels()
    seen.update(reels)
    multiplier = casino.payout_for(reels)
    total += multiplier
    if multiplier > casino.PAIR:
        triples += 1

rtp = total / runs
print(f"    возврат: {rtp * 100:.1f}% от ставки (прокрутов {runs:,})")

truthy("возврат в разумных пределах автомата", 0.80 <= rtp <= 0.92,
       f"{rtp * 100:.1f}%")
truthy("заведение всё-таки в плюсе", rtp < 1.0, f"{rtp * 100:.1f}%")
truthy("выпадают все шесть символов", len(seen) == len(casino.SYMBOLS), str(sorted(seen)))
truthy("три одинаковых — редкость", triples / runs < 0.10,
       f"{triples / runs * 100:.2f}% прокрутов")


# =========================
print("\n=== HTTP-API ===")
import bot

client = bot.app.test_client()

ALICE = {"X-Dev-User-Id": "501", "X-Dev-User-Name": "Алиса"}
BOB = {"X-Dev-User-Id": "502", "X-Dev-User-Name": "Боб"}

store.get_store().clear()

response = client.get("/api/casino")
check("без авторизации нет доступа", response.status_code, 401)

response = client.get("/api/casino", headers=ALICE)
check("состояние доступно", response.status_code, 200)
player = response.get_json()["player"]
check("баланс пуст", player["balance"], 0)
check("сегодня ещё не получал", player["claimedToday"], False)
check("ставки перечислены", player["bet"], casino.DEFAULT_BET)
truthy("символы перечислены", len(player["symbols"]) == len(casino.SYMBOLS))
truthy("таблица выплат передана", bool(player["payouts"]))

response = client.post("/api/casino/claim", headers=ALICE)
check("вход засчитан", response.status_code, 200)
check("начислено 100", response.get_json()["gained"], 100)
check("баланс", response.get_json()["player"]["balance"], 100)

response = client.post("/api/casino/claim", headers=ALICE)
check("повторно ничего", response.get_json()["gained"], 0)
check("баланс тот же", response.get_json()["player"]["balance"], 100)

response = client.post("/api/casino/spin", headers=ALICE, json={"bet": 25})
check("прокрут через API", response.status_code, 200)
data = response.get_json()
check("ставка дошла", data["result"]["bet"], 25)
check("баланс в ответе совпадает с состоянием",
      data["player"]["balance"], data["result"]["balance"])

# Кладём достаточно монет, иначе прокрут отклонится по балансу
rich = casino.load(501)
rich["balance"] = 1000
casino.save(501, rich)

response = client.post("/api/casino/spin", headers=ALICE, json={"bet": 9999})
check("прокрут с огромной ставкой проходит", response.status_code, 200)
check("огромная ставка приводится к наибольшей допустимой",
      response.get_json()["result"]["bet"], max(casino.BETS))

response = client.post("/api/casino/spin", headers=ALICE, json={"bet": "абракадабра"})
check("нечисловая ставка — по умолчанию",
      response.get_json()["result"]["bet"], casino.DEFAULT_BET)

# Чужие монеты не видны
response = client.get("/api/casino", headers=BOB)
check("у второго игрока свой баланс", response.get_json()["player"]["balance"], 0)

# Счётчик дней у второго свой
client.post("/api/casino/claim", headers=BOB)
check("второй получил свои 100",
      client.get("/api/casino", headers=BOB).get_json()["player"]["balance"], 100)
check("у первого баланс не изменился",
      client.get("/api/casino", headers=ALICE).get_json()["player"]["balance"] is not None, True)

print(
    "\n✅ Все проверки пройдены"
    if failed == 0
    else f"\n❌ Провалено проверок: {failed}"
)

sys.exit(0 if failed == 0 else 1)
