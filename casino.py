# -*- coding: utf-8 -*-
"""
Казино на бесплатные тугрики.

Деньги ненастоящие, но считать их всё равно обязан сервер. Если баланс
и результат прокрута определять в браузере, любой откроет консоль
и нарисует себе сколько угодно тугриков — а смысл игры в том, что выигрыш
случаен.

Монеты начисляются за ежедневный вход, поэтому сутки считаются
по Москве: иначе у человека, зашедшего в 23:50, следующий день
начинался бы через десять минут.
"""

import hashlib
import json
import os
import secrets
import threading
from datetime import datetime, timedelta

from parser import now_msk

# Ключ в хранилище
KEY_PREFIX = "casino:user:"

# Сколько тугриков дают за вход и сколько — за неделю без пропусков
START_BALANCE = 0
DAILY_COINS = 500
SUNDAY_BONUS = 3000
SUNDAY_BONUS_STREAK = 7

# Серия дней, после которой дают бонус в воскресенье:
# семь дней — это понедельник…воскресенье без пропусков

# Награда за победу в шахматах
CHESS_WIN_COINS = 300

# Разовый подарок всем игрокам. Выдаётся один раз: отметка giftTaken
# в записи. Текст уведомления задан отдельно — его показывают на экране
#
# GIFT_ID — это версия подарка. В записи хранится идентификатор
# последнего полученного, поэтому стоит поменять его здесь, и подарок
# выдаётся заново всем: и новым игрокам, и тем, кто брал прошлый.
GIFT_ID = "2009"
GIFT_COINS = 2009
GIFT_TEXT = "Привет, вам две тысячи девять тугриков за мой счет. Спасибо!"

# Секретный пароль из раздела техподдержки: даёт тугрики,
# сколько угодно раз.
# В коде лежит только хеш, а не сам пароль: репозиторий публичный,
# и открытый текст увидел бы любой. Если задать PROMO_PASSWORD
# в переменных окружения, он важнее — тогда пароля нет и в хеше.
#
# Паролей может быть несколько, и каждый даёт свою сумму. Ключ —
# SHA-256 от пароля в нижнем регистре: сам пароль в коде не лежит.
# Чтобы добавить пароль, посчитайте хеш и допишите строку сюда.
PROMOS = {
    # первый пароль
    "6042fca4be818e5b111f48692701b0be083400284fe7ef7a789cf0cc23bd01c0": 100,
    # второй пароль
    "bd730aea139d11b2bc985858a831feb8a4312943eac495ab963100d811a756af": 10000,
}

# Сколько даёт пароль из переменной окружения PROMO_PASSWORD.
# Она важнее списка: так пароль можно держать вне публичного репозитория
PROMO_COINS = 100

# Ставки, доступные игроку
# Готовые ставки: по ним рисуются кнопки быстрого выбора
BETS = [10, 25, 50, 100]

# А можно поставить свою сумму. Границы нужны, чтобы ставка не была
# нулевой или астрономической: остальное ограничит баланс
MIN_BET = 10
MAX_BET = 100000
DEFAULT_BET = 10

# Барабаны. Вес — относительная частота выпадения символа.
#
# Набор шуточный, но порядок сохранён как у настоящих автоматов:
# частые символы платят мало, редкие — много. Иначе джекпот выпадал бы
# так же часто, как пустышка, и смысл редкости пропал.
SYMBOLS = [
    {"key": "potato", "emoji": "🥔", "weight": 30},
    {"key": "cucumber", "emoji": "🥒", "weight": 25},
    {"key": "sock", "emoji": "🧦", "weight": 20},
    {"key": "frog", "emoji": "🐸", "weight": 15},
    {"key": "toilet", "emoji": "🚽", "weight": 7},
    {"key": "poop", "emoji": "💩", "weight": 3},
]

# Выплата за три одинаковых, в ставках
TRIPLE = {
    "potato": 4,
    "cucumber": 6,
    "sock": 10,
    "frog": 18,
    "toilet": 35,
    "poop": 80,
}

# За две одинаковые возвращаем ставку
PAIR = 1

# Замки по пользователю: без них два одновременных прокрута прочитали бы
# один и тот же баланс, и за две игры списалось бы как за одну
_locks = {}
_locks_guard = threading.Lock()


def _lock_for(user_id):
    with _locks_guard:
        lock = _locks.get(user_id)
        if lock is None:
            lock = threading.Lock()
            _locks[user_id] = lock
        return lock


# =========================
# ХРАНИЛИЩЕ
# =========================
def _key(user_id):
    return f"{KEY_PREFIX}{user_id}"


def default_record():
    return {
        "balance": START_BALANCE,
        "streak": 0,
        "best": 0,
        "lastClaim": None,
        "bet": DEFAULT_BET,
        "spins": 0,
        "wins": 0,
        "promoUses": 0,
        "giftTaken": None,
    }


def load(user_id):
    """Запись игрока. Незнакомого заводим с нулём — тугрики дадут за вход."""
    import store

    raw = store.get_store().get(_key(user_id))
    record = default_record()

    if raw:
        try:
            saved = json.loads(raw)
            if isinstance(saved, dict):
                record.update(saved)
        except (ValueError, TypeError):
            pass

    return record


def save(user_id, record):
    import store

    store.get_store().set(_key(user_id), json.dumps(record, ensure_ascii=False))
    return record


# =========================
# ДАТЫ
# =========================
def today_msk():
    return now_msk().strftime("%Y-%m-%d")


def _parse(iso):
    try:
        return datetime.strptime(str(iso), "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def is_sunday(iso):
    day = _parse(iso)
    return day is not None and day.weekday() == 6


def yesterday_of(iso):
    day = _parse(iso)
    if day is None:
        return None
    return (day - timedelta(days=1)).strftime("%Y-%m-%d")


# =========================
# ЕЖЕДНЕВНЫЙ ВХОД
# =========================
def claim(user_id, today=None):
    """
    Начисляет тугрики за сегодняшний вход.

    Возвращает (запись, начислено, бонус, ошибка). Повторный вызов
    в тот же день ничего не начисляет и ошибкой не считается: приложение
    зовёт это при каждом запуске.
    """
    today = today or today_msk()

    with _lock_for(user_id):
        record = load(user_id)

        if record.get("lastClaim") == today:
            return record, 0, 0, None

        # Серия растёт, только если вчера тоже заходили
        if record.get("lastClaim") == yesterday_of(today):
            record["streak"] = int(record.get("streak") or 0) + 1
        else:
            record["streak"] = 1

        bonus = 0
        if is_sunday(today) and record["streak"] >= SUNDAY_BONUS_STREAK:
            bonus = SUNDAY_BONUS

        record["balance"] = int(record.get("balance") or 0) + DAILY_COINS + bonus
        record["lastClaim"] = today
        record["best"] = max(int(record.get("best") or 0), record["balance"])

        save(user_id, record)

        return record, DAILY_COINS, bonus, None


# =========================
# СЕКРЕТНЫЙ ПАРОЛЬ
# =========================
def promo_amount(password):
    """
    Сколько тугриков даёт пароль. None — пароль не подошёл.

    Регистр и лишние пробелы не важны. Сравниваем байтами:
    compare_digest не принимает строки с не-ASCII символами
    и падает с TypeError — а пароли кириллические.
    """
    given = (password or "").strip().lower()

    if not given:
        return None

    from_env = (os.getenv("PROMO_PASSWORD") or "").strip().lower()
    if from_env:
        # Переменная окружения важнее списка: так пароль можно держать
        # вне публичного репозитория. Если она задана, список не действует
        if secrets.compare_digest(given.encode("utf-8"),
                                  from_env.encode("utf-8")):
            return PROMO_COINS
        return None

    digest = hashlib.sha256(given.encode("utf-8")).hexdigest()

    for known, amount in PROMOS.items():
        if secrets.compare_digest(digest, known):
            return amount

    return None


def password_matches(password):
    """Подошёл ли пароль хоть какой-нибудь."""
    return promo_amount(password) is not None


def check_promo(user_id, password):
    """
    Секретный пароль даёт тугрики — сколько угодно раз.

    Ограничения на сутки нет: пароль знают свои, и это шутка. Считаем
    только, сколько раз им воспользовались, — чтобы было видно, что
    им вообще пользуются.

    Возвращает (запись, начислено, ошибка).
    """
    amount = promo_amount(password)
    if amount is None:
        return None, 0, "Неверный пароль"

    with _lock_for(user_id):
        record = load(user_id)
        record["balance"] = int(record.get("balance") or 0) + amount
        record["promoUses"] = int(record.get("promoUses") or 0) + 1
        record["best"] = max(int(record.get("best") or 0), record["balance"])

        save(user_id, record)

        return record, amount, None


# =========================
# НАЧИСЛЕНИЯ СО СТОРОНЫ
# ========================
def add_coins(user_id, amount):
    """
    Начисляет тугрики вне ежедневного входа.

    Нужно шахматам: за победу дают тугрики в казино. Замок тот же, что
    и у прокрута, иначе победа и одновременный прокрут могли бы
    перезаписать друг друга.
    """
    amount = int(amount)

    if amount <= 0:
        return load(user_id)

    with _lock_for(user_id):
        record = load(user_id)
        record["balance"] = int(record.get("balance") or 0) + amount
        record["best"] = max(int(record.get("best") or 0), record["balance"])

        save(user_id, record)

        return record


def grant_gift(user_id):
    """
    Разовый подарок отдельной операцией.

    Приложению он не нужен: там начисление за вход и подарок делаются
    вместе, за одно обращение к хранилищу (claim_with_gift). Эта
    функция остаётся для бота и тестов, где важна раздельность.

    Возвращает описание для уведомления или None, если уже получал.
    """
    with _lock_for(user_id):
        record = load(user_id)

        if record.get("giftTaken") == GIFT_ID:
            return None

        record["giftTaken"] = GIFT_ID
        record["balance"] = int(record.get("balance") or 0) + GIFT_COINS
        record["best"] = max(int(record.get("best") or 0), record["balance"])

        save(user_id, record)

        return {
            "amount": GIFT_COINS,
            "text": GIFT_TEXT,
            "balance": record["balance"],
        }


def claim_with_gift(user_id, today=None):
    """
    Начисляет за вход и выдаёт разовый подарок — за одно обращение.

    Раньше это были две отдельные операции, и каждая читала и писала
    запись: четыре похода в Redis вместо двух. Redis отсюда далеко,
    каждый поход стоит сотни миллисекунд, и запросы копились —
    проверка живости Render не укладывалась в свои пять секунд.

    Возвращает (запись, начислено, бонус, подарок, ошибка).
    Подарок равен None, если уже получали.
    """
    today = today or today_msk()

    with _lock_for(user_id):
        record = load(user_id)
        gained = 0

        if record.get("lastClaim") != today:
            # Серия растёт, только если вчера тоже заходили
            if record.get("lastClaim") == yesterday_of(today):
                record["streak"] = int(record.get("streak") or 0) + 1
            else:
                record["streak"] = 1

            gained = DAILY_COINS
            if is_sunday(today) and record["streak"] >= SUNDAY_BONUS_STREAK:
                gained += SUNDAY_BONUS

            record["lastClaim"] = today

        gift = None
        if record.get("giftTaken") != GIFT_ID:
            record["giftTaken"] = GIFT_ID
            gift = {
                "amount": GIFT_COINS,
                "text": GIFT_TEXT,
            }

        if gained or gift:
            record["balance"] = int(record.get("balance") or 0) + gained
            if gift:
                record["balance"] += GIFT_COINS
            record["best"] = max(int(record.get("best") or 0), record["balance"])
            save(user_id, record)

        if gift:
            gift["balance"] = record["balance"]

        bonus = gained - DAILY_COINS if gained else 0
        return record, gained - bonus, bonus, gift, None


def spend(user_id, amount):
    """
    Списывает тугрики. Возвращает (запись, ошибка).

    Замок тот же, что у начислений: иначе покупка и одновременный
    прокрут могли бы прочитать один баланс и записать разное.
    """
    amount = int(amount)

    with _lock_for(user_id):
        record = load(user_id)
        balance = int(record.get("balance") or 0)

        if amount <= 0:
            return record, None

        if balance < amount:
            return record, f"Не хватает тугриков: нужно {amount}, на счету {balance}"

        record["balance"] = balance - amount
        save(user_id, record)

        return record, None


def award_chess_win(user_id):
    """Победа в шахматах — тугрики в казино."""
    return add_coins(user_id, CHESS_WIN_COINS)


# =========================
# ПРОКРУТ
# ========================
def _total_weight():
    return sum(s["weight"] for s in SYMBOLS)


def pick_symbol():
    """Один символ. Источник случайности — криптографический."""
    total = _total_weight()
    roll = secrets.randbelow(total)

    for symbol in SYMBOLS:
        roll -= symbol["weight"]
        if roll < 0:
            return symbol["key"]

    return SYMBOLS[-1]["key"]


def pick_reels():
    return [pick_symbol(), pick_symbol(), pick_symbol()]


def payout_for(reels):
    """
    Множитель ставки за выпавший набор.

    Три одинаковых — по таблице. Две одинаковые — возврат ставки.
    Иначе ноль.
    """
    if not reels:
        return 0

    counts = {}
    for key in reels:
        counts[key] = counts.get(key, 0) + 1

    for key, count in counts.items():
        if count == 3:
            return TRIPLE.get(key, 0)

    if max(counts.values()) == 2:
        return PAIR

    return 0


def normalize_bet(value):
    """
    Ставка приводится к допустимой.

    Раньше разрешены были только четыре готовые суммы и любая другая
    «прилипала» к ближайшей снизу. Теперь сумму можно задать свою:
    она просто зажимается в границы, а сверх баланса её не пустит
    сам прокрут.
    """
    try:
        number = int(value)
    except (TypeError, ValueError):
        return DEFAULT_BET

    return max(MIN_BET, min(MAX_BET, number))


def spin(user_id, bet=None):
    """
    Крутит барабаны.

    Возвращает (результат, ошибка).
    """
    with _lock_for(user_id):
        record = load(user_id)
        bet = normalize_bet(bet if bet is not None else record.get("bet"))

        balance = int(record.get("balance") or 0)

        if balance < bet:
            return None, f"Не хватает тугриков: нужно {bet}, на счету {balance}"

        reels = pick_reels()
        multiplier = payout_for(reels)
        win = multiplier * bet

        record["balance"] = balance - bet + win
        record["bet"] = bet
        record["spins"] = int(record.get("spins") or 0) + 1

        if win > bet:
            record["wins"] = int(record.get("wins") or 0) + 1

        record["best"] = max(int(record.get("best") or 0), record["balance"])

        save(user_id, record)

        return {
            "reels": reels,
            "multiplier": multiplier,
            "bet": bet,
            "win": win,
            "net": win - bet,
            "balance": record["balance"],
            "spins": record["spins"],
            "wins": record["wins"],
        }, None


# =========================
# ДЛЯ КЛИЕНТА
# =========================
def serialize(user_id, record=None, today=None):
    """
    Состояние игрока для приложения.

    Запись можно передать готовой: после начисления она уже на руках,
    и второй поход в хранилище за ней не нужен.
    """
    today = today or today_msk()

    if record is None:
        record = load(user_id)

    return {
        "balance": int(record.get("balance") or 0),
        "streak": int(record.get("streak") or 0),
        "best": int(record.get("best") or 0),
        "bet": normalize_bet(record.get("bet")),
        "spins": int(record.get("spins") or 0),
        "wins": int(record.get("wins") or 0),
        "lastClaim": record.get("lastClaim"),
        "today": today,
        "claimedToday": record.get("lastClaim") == today,
        "dailyCoins": DAILY_COINS,
        "sundayBonus": SUNDAY_BONUS,
        "giftCoins": GIFT_COINS,
        "giftTaken": record.get("giftTaken") == GIFT_ID,
        "giftId": GIFT_ID,
        "chessWin": CHESS_WIN_COINS,
        "promoCoins": PROMO_COINS,
        "promoUses": int(record.get("promoUses") or 0),
        "streakForBonus": SUNDAY_BONUS_STREAK,
        "bets": BETS,
        "minBet": MIN_BET,
        "maxBet": MAX_BET,
        "symbols": [{"key": s["key"], "emoji": s["emoji"]} for s in SYMBOLS],
        "payouts": TRIPLE,
    }
