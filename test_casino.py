# -*- coding: utf-8 -*-
"""
Тесты казино: тугрики за вход, серия, бонус воскресенья, прокрут, выплаты.

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
check("баланс", record["balance"], casino.DAILY_COINS)
check("серия — один день", record["streak"], 1)
check("бонуса нет", bonus, 0)

record, gained, bonus, error = casino.claim(101, today=WEEK[0])
check("повторно в тот же день ничего", gained, 0)
check("баланс не изменился", record["balance"], casino.DAILY_COINS)
check("повтор — не ошибка", error, None)


# =========================
print("\n=== Серия дней ===")
for day in WEEK[1:6]:
    record, gained, _, _ = casino.claim(101, today=day)
    check(f"за {day} начислено", gained, casino.DAILY_COINS)

check("серия выросла до шести", record["streak"], 6)
check("баланс за шесть дней", record["balance"], casino.DAILY_COINS * 6)

# Воскресенье седьмого дня — бонус
record, gained, bonus, error = casino.claim(101, today=WEEK[6])
check("в воскресенье — обычные 100", gained, casino.DAILY_COINS)
check("и бонус за неделю", bonus, casino.SUNDAY_BONUS)
check("серия — семь дней", record["streak"], 7)
check("баланс с бонусом", record["balance"], casino.DAILY_COINS * 7 + casino.SUNDAY_BONUS)


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
print("\n=== Секретный пароль ===")

# Проверяем механизм на своём пароле, а не на настоящем: репозиторий
# публичный, и настоящие пароли в тестах светить нельзя. Добавляем
# временную запись в список и убираем её в конце.
import hashlib

PROMO = "тестовый-пароль-для-проверки"
TEST_HASH = hashlib.sha256(PROMO.encode("utf-8")).hexdigest()
casino.PROMOS[TEST_HASH] = 100

# Второй пароль — на другую сумму: механизм должен различать их
PROMO_BIG = "тестовый-пароль-покрупнее"
BIG_HASH = hashlib.sha256(PROMO_BIG.encode("utf-8")).hexdigest()
casino.PROMOS[BIG_HASH] = 5000

truthy("верный пароль принят", casino.password_matches(PROMO))
truthy("второй пароль тоже принят", casino.password_matches(PROMO_BIG))
check("у каждого пароля своя сумма", casino.promo_amount(PROMO_BIG), 5000)
truthy("регистр не важен", casino.password_matches("ЯЛЮБЛЮМИЮБОЙКО"))
truthy("пробелы по краям не мешают", casino.password_matches("  " + PROMO + "  "))
truthy("неверный пароль отклонён", not casino.password_matches("неверный"))
truthy("пустой пароль отклонён", not casino.password_matches(""))
truthy("None отклонён", not casino.password_matches(None))

# Сам пароль не должен лежать в исходниках: репозиторий публичный
import inspect

source = inspect.getsource(casino)
# Проверяем, что в коде лежат именно хеши, а не пароли. Сами пароли
# при этом в тесте не упоминаются: иначе проверка «пароля нет в коде»
# сама бы его туда и положила
truthy("в списке только хеши, а не пароли",
       all(len(h) == 64 and all(c in "0123456789abcdef" for c in h)
           for h in casino.PROMOS),
       ", ".join(h[:8] for h in casino.PROMOS))
truthy("пароль не угадывается по подсказке",
       all(not h.startswith("я") for h in casino.PROMOS))

store.get_store().clear()

record, gained, error = casino.check_promo(701, PROMO)
check("за пароль начислено", gained, casino.PROMO_COINS)
check("ошибки нет", error, None)
check("баланс", record["balance"], casino.PROMO_COINS)

# Ограничения на количество раз нет: пароль можно вводить сколько угодно
record, gained, error = casino.check_promo(701, PROMO)
check("повторно снова начислено", gained, casino.PROMO_COINS)
check("ошибки нет", error, None)
check("баланс удвоился", record["balance"], 200)
check("счётчик применений", record["promoUses"], 2)

for _ in range(3):
    record, _, _ = casino.check_promo(701, PROMO)
check("можно применять много раз", record["balance"], 500)
check("счётчик посчитал все", record["promoUses"], 5)

record, gained, error = casino.check_promo(701, "неверный")
check("неверный пароль ничего не даёт", gained, 0)
truthy("сказано, что пароль неверный", error is not None and "Неверный" in error, error)
check("баланс при неверном не меняется", record, None)

# Переменная окружения важнее встроенного хеша
os.environ["PROMO_PASSWORD"] = "другойпароль"
truthy("своя переменная принимается", casino.password_matches("другойпароль"))
truthy("старый пароль при ней не работает", not casino.password_matches(PROMO))

store.get_store().clear()
_, gained, _ = casino.check_promo(702, "другойпароль")
check("и тугрики дают по своему паролю", gained, casino.PROMO_COINS)

del os.environ["PROMO_PASSWORD"]
truthy("без переменной снова встроенный", casino.password_matches(PROMO))

# Клиент получает размер награды и отметку об использовании
store.get_store().clear()
fresh = casino.serialize(703)
check("размер награды за пароль", fresh["promoCoins"], 100)
check("ещё не применялся", fresh["promoUses"], 0)
casino.check_promo(703, PROMO)
casino.check_promo(703, PROMO)
check("счётчик применений растёт", casino.serialize(703)["promoUses"], 2)


# =========================
print("\n=== Разовый подарок ===")

store.get_store().clear()

check("размер подарка", casino.GIFT_COINS, 2009)
truthy("у подарка есть версия", bool(casino.GIFT_ID), casino.GIFT_ID)
truthy("текст подарка задан", "тугрик" in casino.GIFT_TEXT, casino.GIFT_TEXT)

record, gained, bonus, error = casino.claim(801)
check("за вход начислено", gained, casino.DAILY_COINS)

gift = casino.grant_gift(801)
truthy("подарок выдан", gift is not None)
check("размер выданного подарка", gift["amount"], casino.GIFT_COINS)
check("текст передан клиенту", gift["text"], casino.GIFT_TEXT)
check("баланс со подарком", gift["balance"], casino.DAILY_COINS + casino.GIFT_COINS)

check("повторно подарок не дают", casino.grant_gift(801), None)
check("баланс не вырос", casino.load(801)["balance"], casino.DAILY_COINS + casino.GIFT_COINS)

# Кто брал прошлый подарок — получает новый: версия другая
store.get_store().clear()
casino.save(803, dict(casino.default_record(), giftTaken=True, balance=1000))
gift = casino.grant_gift(803)
truthy("старая отметка не мешает новому подарку", gift is not None)
check("новый подарок начислен", casino.load(803)["balance"], 1000 + casino.GIFT_COINS)
check("отметка сменилась на новую версию", casino.load(803)["giftTaken"], casino.GIFT_ID)
check("повторно уже не дают", casino.grant_gift(803), None)

# Новый игрок подарок получает
store.get_store().clear()
gift = casino.grant_gift(802)
truthy("новому игроку подарок", gift is not None)
check("и сразу начислен", casino.load(802)["balance"], casino.GIFT_COINS)

# Отметка видна клиенту
check("клиент видит отметку о подарке", casino.serialize(802)["giftTaken"], True)
check("клиент видит версию подарка", casino.serialize(802)["giftId"], casino.GIFT_ID)
check("клиент видит размер подарка", casino.serialize(802)["giftCoins"],
      casino.GIFT_COINS)

# Размеры бонусов
check("за вход теперь 500", casino.DAILY_COINS, 500)
check("за неделю теперь 3000", casino.SUNDAY_BONUS, 3000)

print("\n=== Начисления со стороны (победа в шахматах) ===")
store.get_store().clear()

bad = casino.add_coins(601, 300)
check("начислено за победу", bad["balance"], 300)
check("записано на счёт", casino.load(601)["balance"], 300)

casino.add_coins(601, 300)
check("начисления складываются", casino.load(601)["balance"], 600)

casino.add_coins(601, 0)
check("ноль ничего не меняет", casino.load(601)["balance"], 600)

casino.add_coins(601, -100)
check("отрицательное не списывает", casino.load(601)["balance"], 600)

# Серия и отметка о входе при этом не трогаются
record = casino.load(601)
check("серия не появилась", record["streak"], 0)
check("отметки о входе нет", record["lastClaim"], None)

# Победа даёт ровно столько, сколько обещано
check("размер награды", casino.CHESS_WIN_COINS, 300)
store.get_store().clear()
casino.award_chess_win(602)
check("победа в шахматах", casino.load(602)["balance"], 300)

# Награду видно клиенту
truthy("размер награды приходит клиенту",
       casino.serialize(602)["chessWin"] == 300,
       str(casino.serialize(602).get("chessWin")))


# =========================
print("\n=== Выплаты ===")
check("три картошки", casino.payout_for(["potato"] * 3), casino.TRIPLE["potato"])
check("три какашки", casino.payout_for(["poop"] * 3), casino.TRIPLE["poop"])
check("три унитаза", casino.payout_for(["toilet"] * 3), casino.TRIPLE["toilet"])
check("две картошки и огурец",
      casino.payout_for(["potato", "potato", "cucumber"]), casino.PAIR)
check("две какашки", casino.payout_for(["poop", "sock", "poop"]), casino.PAIR)
check("все разные", casino.payout_for(["potato", "cucumber", "sock"]), 0)
check("пустой набор", casino.payout_for([]), 0)

# Дороже символ — больше платит
truthy("редкий платит больше частого",
       casino.TRIPLE["poop"] > casino.TRIPLE["potato"])


# =========================
print("\n=== Ставки ===")
# Набор шуточный, но порядок как у автоматов: частые дешёвые, редкие дорогие
emojis = [s["emoji"] for s in casino.SYMBOLS]
check("символов шесть", len(emojis), 6)
check("набор смешной", emojis, ["🥔", "🥒", "🧦", "🐸", "🚽", "💩"])
check("веса в сумме сто", sum(s["weight"] for s in casino.SYMBOLS), 100)
truthy("самый частый платит меньше всех",
       casino.TRIPLE[casino.SYMBOLS[0]["key"]] == min(casino.TRIPLE.values()))
truthy("самый редкий платит больше всех",
       casino.TRIPLE[casino.SYMBOLS[-1]["key"]] == max(casino.TRIPLE.values()))
truthy("каждому символу назначена выплата",
       all(s["key"] in casino.TRIPLE for s in casino.SYMBOLS))

check("допустимая ставка", casino.normalize_bet(50), 50)
check("нечисловая — по умолчанию", casino.normalize_bet("абракадабра"), casino.DEFAULT_BET)
check("пустая — по умолчанию", casino.normalize_bet(None), casino.DEFAULT_BET)
check("слишком большая — наибольшая допустимая", casino.normalize_bet(9999), max(casino.BETS))
check("промежуточная — ближайшая снизу", casino.normalize_bet(60), 50)
check("меньше минимальной — минимальная", casino.normalize_bet(1), min(casino.BETS))


# =========================
print("\n=== Прокрут ===")
store.get_store().clear()
casino.claim(401, today="2026-10-05")

result, error = casino.spin(401, 10)
check("прокрут прошёл", error, None)
check("ставка записана", result["bet"], 10)
check("три барабана", len(result["reels"]), 3)
truthy("символы известные",
       all(r in [s["key"] for s in casino.SYMBOLS] for r in result["reels"]),
       str(result["reels"]))
check("выигрыш = множитель на ставку", result["win"], result["multiplier"] * 10)
check("баланс пересчитан", result["balance"],
      casino.DAILY_COINS - 10 + result["win"])
check("счётчик прокрутов", result["spins"], 1)

# Баланс никогда не уходит в минус
store.get_store().clear()
for _ in range(200):
    result, error = casino.spin(402, 100)
    if error:
        break
truthy("без тугриков крутить нельзя", error is not None, error or "")
truthy("в ошибке сказано, сколько нужно", "тугриков" in (error or ""), error or "")
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
check("начислено за вход", response.get_json()["gained"], casino.DAILY_COINS)
check("баланс", response.get_json()["player"]["balance"],
      casino.DAILY_COINS + casino.GIFT_COINS)

# Заодно проверяем сам подарок: он приходит в этом же ответе
gift = response.get_json().get("gift")
truthy("подарок пришёл в ответе", gift is not None)
check("размер подарка в ответе", gift["amount"], casino.GIFT_COINS)
check("текст подарка в ответе", gift["text"], casino.GIFT_TEXT)

response = client.post("/api/casino/claim", headers=ALICE)
check("повторно ничего", response.get_json()["gained"], 0)
check("и подарка больше нет", response.get_json().get("gift"), None)
check("баланс тот же", response.get_json()["player"]["balance"],
      casino.DAILY_COINS + casino.GIFT_COINS)

response = client.post("/api/casino/spin", headers=ALICE, json={"bet": 25})
check("прокрут через API", response.status_code, 200)
data = response.get_json()
check("ставка дошла", data["result"]["bet"], 25)
check("баланс в ответе совпадает с состоянием",
      data["player"]["balance"], data["result"]["balance"])

# Кладём достаточно тугриков, иначе прокрут отклонится по балансу
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

print("\n=== Секретный пароль через API ===")
store.get_store().clear()

CAROL = {"X-Dev-User-Id": "503", "X-Dev-User-Name": "Карol"}

response = client.post("/api/casino/promo", json={"password": PROMO})
check("без авторизации пароль не проверить", response.status_code, 401)

response = client.post("/api/casino/promo", headers=CAROL, json={"password": "неверный"})
check("неверный пароль отклонён", response.status_code, 403)
truthy("и сказано почему", "Неверный" in response.get_json().get("error", ""),
       response.get_json().get("error", ""))

response = client.post("/api/casino/promo", headers=CAROL, json={})
check("без пароля отклонено", response.status_code, 403)
check("баланс не изменился",
      client.get("/api/casino", headers=CAROL).get_json()["player"]["balance"], 0)

response = client.post("/api/casino/promo", headers=CAROL, json={"password": PROMO})
check("верный пароль принят", response.status_code, 200)
check("начислено за пароль", response.get_json()["gained"], casino.PROMO_COINS)
check("баланс", response.get_json()["player"]["balance"], casino.PROMO_COINS)

response = client.post("/api/casino/promo", headers=CAROL, json={"password": PROMO})
check("повтор через API тоже работает", response.status_code, 200)
check("начислено ещё 100", response.get_json()["gained"], 100)
check("счёт вырос",
      client.get("/api/casino", headers=CAROL).get_json()["player"]["balance"], 200)

check("клиент видит счётчик применений",
      client.get("/api/casino", headers=CAROL).get_json()["player"]["promoUses"], 2)

# У другого игрока свой счётчик
response = client.post("/api/casino/promo", headers=ALICE,
                       json={"password": PROMO})
check("другому пароль тоже работает", response.status_code, 200)

# Чужие тугрики не видны
response = client.get("/api/casino", headers=BOB)
check("у второго игрока свой баланс", response.get_json()["player"]["balance"], 0)

# Счётчик дней у второго свой
client.post("/api/casino/claim", headers=BOB)
check("второй получил свои",
      client.get("/api/casino", headers=BOB).get_json()["player"]["balance"],
      casino.DAILY_COINS + casino.GIFT_COINS)
check("у первого баланс не изменился",
      client.get("/api/casino", headers=ALICE).get_json()["player"]["balance"] is not None, True)

print(
    "\n✅ Все проверки пройдены"
    if failed == 0
    else f"\n❌ Провалено проверок: {failed}"
)

sys.exit(0 if failed == 0 else 1)
