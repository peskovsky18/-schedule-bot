# -*- coding: utf-8 -*-
"""
Казино на бесплатные монеты.

Деньги ненастоящие, но считать их всё равно обязан сервер. Если баланс
и результат прокрута определять в браузере, любой откроет консоль
и нарисует себе сколько угодно монет — а смысл игры в том, что выигрыш
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

# Сколько монет дают за вход и сколько — за неделю без пропусков
START_BALANCE = 0
DAILY_COINS = 100
SUNDAY_BONUS = 300
SUNDAY_BONUS_STREAK = 7

# Серия дней, после которой дают бонус в воскресенье:
# семь дней — это понедельник…воскресенье без пропусков

# Награда за победу в шахматах
CHESS_WIN_COINS = 300

# Секретный пароль из раздела техподдержки: даёт монеты раз в сутки.
# В коде лежит только хеш, а не сам пароль: репозиторий публичный,
# и открытый текст увидел бы любой. Если задать PROMO_PASSWORD
# в переменных окружения, он важнее — тогда пароля нет и в хеше.
PROMO_HASH = "6042fca4be818e5b111f48692701b0be083400284fe7ef7a789cf0cc23bd01c0"
PROMO_COINS = 100

# Ставки, доступные игроку
BETS = [10, 25, 50, 100]
DEFAULT_BET = 10

# Барабаны. Вес — относительная частота выпадения символа.
SYMBOLS = [
    {"key": "cherry", "emoji": "🍒", "weight": 30},
    {"key": "lemon", "emoji": "🍋", "weight": 25},
    {"key": "bell", "emoji": "🔔", "weight": 20},
    {"key": "star", "emoji": "⭐", "weight": 15},
    {"key": "diamond", "emoji": "💎", "weight": 7},
    {"key": "seven", "emoji": "7️⃣", "weight": 3},
]

# Выплата за три одинаковых, в ставках
TRIPLE = {
    "cherry": 4,
    "lemon": 6,
    "bell": 10,
    "star": 18,
    "diamond": 35,
    "seven": 80,
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
    }


def load(user_id):
    """Запись игрока. Незнакомого заводим с нулём — монеты дадут за вход."""
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
    Начисляет монеты за сегодняшний вход.

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
def password_matches(password):
    """Сверяет пароль. Регистр и лишние пробелы не важны."""
    given = (password or "").strip().lower()

    if not given:
        return False

    from_env = (os.getenv("PROMO_PASSWORD") or "").strip().lower()
    if from_env:
        # Сравниваем байтами: compare_digest не принимает строки
        # с не-ASCII символами и падает с TypeError — а пароль
        # кириллический
        return secrets.compare_digest(given.encode("utf-8"), from_env.encode("utf-8"))

    digest = hashlib.sha256(given.encode("utf-8")).hexdigest()
    return secrets.compare_digest(digest, PROMO_HASH)


def check_promo(user_id, password, today=None):
    """
    Секретный пароль: раз в сутки даёт монеты.

    Возвращает (запись, начислено, ошибка). Ограничение на сутки нужно
    не из вредности: без него пароль, который знают несколько человек,
    превращается в бесконечный источник монет.
    """
    today = today or today_msk()

    if not password_matches(password):
        return None, 0, "Неверный пароль"

    with _lock_for(user_id):
        record = load(user_id)

        if record.get("lastPromo") == today:
            return record, 0, "Сегодня по паролю уже получали"

        record["balance"] = int(record.get("balance") or 0) + PROMO_COINS
        record["lastPromo"] = today
        record["best"] = max(int(record.get("best") or 0), record["balance"])

        save(user_id, record)

        return record, PROMO_COINS, None


# =========================
# НАЧИСЛЕНИЯ СО СТОРОНЫ
# ========================
def add_coins(user_id, amount):
    """
    Начисляет монеты вне ежедневного входа.

    Нужно шахматам: за победу дают монеты в казино. Замок тот же, что
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


def award_chess_win(user_id):
    """Победа в шахматах — монеты в казино."""
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
    """Ставка приводится к одной из разрешённых."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return DEFAULT_BET

    if number in BETS:
        return number

    # Ближайшая допустимая снизу, чтобы не списать лишнего
    suitable = [b for b in BETS if b <= number]
    return max(suitable) if suitable else BETS[0]


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
            return None, f"Не хватает монет: нужно {bet}, на счету {balance}"

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
def serialize(user_id, today=None):
    """Состояние игрока для приложения."""
    today = today or today_msk()
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
        "chessWin": CHESS_WIN_COINS,
        "promoCoins": PROMO_COINS,
        "promoUsedToday": record.get("lastPromo") == today,
        "streakForBonus": SUNDAY_BONUS_STREAK,
        "bets": BETS,
        "symbols": [{"key": s["key"], "emoji": s["emoji"]} for s in SYMBOLS],
        "payouts": TRIPLE,
    }
