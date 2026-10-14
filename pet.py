# -*- coding: utf-8 -*-
"""
Тамагочи-питомец: создание, здоровье (сердечки), кормление и гардероб.
"""

import json
import time
import casino
import store

ADOPT_COST = 10  # Скидка: теперь завести питомца стоит всего 10 тугриков!
APPLE_COST = 100
MAX_HEALTH = 5
SECONDS_PER_HEART = 86400  # 1 день = 1 сердечко (за 5 дней умирает)

# Добыча тугриков в шахте
WORK_SHIFT_SECONDS = 3600  # 1 смена = 1 час работы
MAX_WORK_SHIFTS_PER_DAY = 3  # Максимум 3 часа (3 смены) в день

# Доходность за 1 час работы в шахте в зависимости от уровня
WORK_REWARDS = {
    1: 100,
    2: 200,
    3: 300,
}

MAX_LEVEL = 3
UPGRADE_COSTS = {
    2: 3000,
    3: 6000,
}

LEVEL_TITLES = {
    1: {"name": "Малыш", "badge": "⭐ Ур. 1", "desc": "Милый пушистый малыш"},
    2: {"name": "Хранитель", "badge": "⭐⭐ Ур. 2", "desc": "Окрепший магический лис-хранитель"},
    3: {"name": "Легенда", "badge": "⭐⭐⭐ Ур. 3", "desc": "Величественный космический хранитель"},
}

PET_ITEMS = [
    {
        "id": "cap",
        "name": "Кепка",
        "emoji": "🧢",
        "type": "hat",
        "price": 300,
        "description": "Стильная бейсболка на бок",
    },
    {
        "id": "shades",
        "name": "Крутые очки",
        "emoji": "🕶",
        "type": "hat",
        "price": 400,
        "description": "Тёмные очки для важных переговоров",
    },
    {
        "id": "grad",
        "name": "Шапка выпускника",
        "emoji": "🎓",
        "type": "hat",
        "price": 500,
        "description": "Конфедератка отличника",
    },
    {
        "id": "crown",
        "name": "Золотая корона",
        "emoji": "👑",
        "type": "hat",
        "price": 1500,
        "description": "Настоящее королевское величие",
    },
    {
        "id": "headphones",
        "name": "Наушники",
        "emoji": "🎧",
        "type": "hat",
        "price": 600,
        "description": "Геймерские неоновые наушники",
    },
    {
        "id": "bow",
        "name": "Бантик",
        "emoji": "🎀",
        "type": "neck",
        "price": 200,
        "description": "Милый розовый бантик",
    },
    {
        "id": "tie",
        "name": "Галстук",
        "emoji": "👔",
        "type": "neck",
        "price": 450,
        "description": "Деловой красный галстук",
    },
    {
        "id": "scarf",
        "name": "Тёплый шарф",
        "emoji": "🧣",
        "type": "neck",
        "price": 350,
        "description": "Согревает на зимней сессии",
    },
]

ITEMS_BY_ID = {item["id"]: item for item in PET_ITEMS}


def _key(user_id):
    return f"pet:user:{user_id}"


def get_pet_raw(user_id):
    s = store.get_store()
    raw = s.get(_key(user_id))
    if not raw:
        return None
    try:
        if isinstance(raw, str):
            return json.loads(raw)
        return raw
    except Exception:
        return None


def save_pet_raw(user_id, pet_data):
    s = store.get_store()
    s.set(_key(user_id), json.dumps(pet_data, ensure_ascii=False))


def calculate_health(pet_data):
    """
    Рассчитывает текущее здоровье питомца по времени с последнего кормления.
    1 сердечко теряется каждые 24 часа без еды.
    Через 5 дней (5 сердец) питомец погибает.
    """
    if not pet_data or not pet_data.get("alive", True):
        return 0, False

    now = int(time.time())
    last_fed = int(pet_data.get("last_fed_at", now))
    elapsed = max(0, now - last_fed)

    hearts_lost = elapsed // SECONDS_PER_HEART
    health = max(0, MAX_HEALTH - hearts_lost)
    alive = health > 0

    return health, alive


def _moscow_date(ts=None):
    if ts is None:
        ts = time.time()
    t = time.gmtime(ts + 3 * 3600)
    return time.strftime("%Y-%m-%d", t)


def get_work_status(pet_data):
    if not pet_data:
        return None

    now = int(time.time())
    today_str = _moscow_date(now)
    work = pet_data.get("work") or {}

    # Сброс счетчика дня, если наступили новые сутки
    if work.get("day_date") != today_str:
        work["day_date"] = today_str
        work["shifts_today"] = 0
        work["heart_lost_today"] = False

    started_at = work.get("started_at")
    shift_seconds = WORK_SHIFT_SECONDS
    lvl = max(1, min(MAX_LEVEL, int(pet_data.get("level") or 1)))
    base_reward = WORK_REWARDS.get(lvl, 100)

    if started_at:
        elapsed = now - started_at
        if elapsed >= shift_seconds:
            status = "ready"
            remaining_seconds = 0
        else:
            status = "working"
            remaining_seconds = shift_seconds - elapsed
    else:
        status = "idle"
        remaining_seconds = 0

    shifts_today = int(work.get("shifts_today") or 0)
    alive = bool(pet_data.get("alive", True))
    health = int(pet_data.get("health") or 0)
    heart_lost_today = bool(work.get("heart_lost_today"))

    can_work = (
        alive
        and status == "idle"
        and shifts_today < MAX_WORK_SHIFTS_PER_DAY
        and (health >= 2 or heart_lost_today)
    )

    return {
        "status": status,  # "idle" | "working" | "ready"
        "started_at": started_at,
        "remaining_seconds": remaining_seconds,
        "shift_seconds": shift_seconds,
        "reward": base_reward,
        "shifts_today": shifts_today,
        "max_shifts": MAX_WORK_SHIFTS_PER_DAY,
        "can_work": can_work,
        "heart_lost_today": heart_lost_today,
        "day_date": work.get("day_date") or today_str,
    }


def get_pet(user_id):
    pet_data = get_pet_raw(user_id)
    if not pet_data:
        return None

    health, alive = calculate_health(pet_data)
    pet_data["health"] = health
    pet_data["alive"] = alive
    pet_data["max_health"] = MAX_HEALTH

    # Время до потери следующего сердечка в секундах
    now = int(time.time())
    last_fed = int(pet_data.get("last_fed_at", now))
    elapsed = max(0, now - last_fed)
    if alive:
        seconds_to_next = SECONDS_PER_HEART - (elapsed % SECONDS_PER_HEART)
    else:
        seconds_to_next = 0
    pet_data["seconds_to_heart_loss"] = seconds_to_next
    pet_data["dead"] = not alive
    pet_data["adopted_at"] = pet_data.get("created_at")
    pet_data["items"] = pet_data.get("inventory") or []
    eq = pet_data.get("equipped") or {"hat": None, "neck": None}
    pet_data["equipped_list"] = [v for v in eq.values() if v]

    lvl = int(pet_data.get("level") or 1)
    lvl = max(1, min(MAX_LEVEL, lvl))
    pet_data["level"] = lvl
    pet_data["max_level"] = MAX_LEVEL
    next_lvl = (lvl + 1) if lvl < MAX_LEVEL else None
    pet_data["next_level"] = next_lvl
    pet_data["upgrade_cost"] = UPGRADE_COSTS.get(next_lvl) if next_lvl else None
    lvl_info = LEVEL_TITLES.get(lvl, LEVEL_TITLES[1])
    pet_data["level_title"] = lvl_info["name"]
    pet_data["level_badge"] = lvl_info["badge"]
    pet_data["level_desc"] = lvl_info["desc"]

    # Статус работы в шахте
    pet_data["work"] = get_work_status(pet_data)

    return pet_data


def adopt_pet(user_id, name):
    name = (name or "").strip()
    if not name:
        return None, "Укажите имя для питомца"
    if len(name) > 30:
        return None, "Имя не должно превышать 30 символов"

    # Списываем стоимость создания (10 тугриков)
    record, error = casino.spend(user_id, ADOPT_COST)
    if error:
        return None, error

    now = int(time.time())
    pet_data = {
        "user_id": user_id,
        "name": name,
        "alive": True,
        "health": MAX_HEALTH,
        "max_health": MAX_HEALTH,
        "level": 1,
        "created_at": now,
        "last_fed_at": now,
        "inventory": [],
        "equipped": {
            "hat": None,
            "neck": None,
        },
        "work": {
            "status": "idle",
            "started_at": None,
            "day_date": _moscow_date(now),
            "shifts_today": 0,
            "heart_lost_today": False,
        },
    }

    save_pet_raw(user_id, pet_data)
    return get_pet(user_id), None


def upgrade_pet(user_id):
    pet_info = get_pet(user_id)
    if not pet_info:
        return None, "У вас ещё нет питомца"
    if not pet_info.get("alive"):
        return None, "Питомец погиб. Сначала заведите нового"

    cur_lvl = pet_info.get("level", 1)
    if cur_lvl >= MAX_LEVEL:
        return None, "Питомец уже достиг максимального уровня"

    next_lvl = cur_lvl + 1
    cost = UPGRADE_COSTS.get(next_lvl)
    if cost is None:
        return None, "Неизвестный уровень для улучшения"

    record, error = casino.spend(user_id, cost)
    if error:
        return None, error

    pet_info["level"] = next_lvl
    save_pet_raw(user_id, pet_info)
    return get_pet(user_id), None


def feed_pet(user_id):
    pet = get_pet(user_id)
    if not pet:
        return None, "У вас ещё нет питомца"
    if not pet.get("alive"):
        return None, "К сожалению, питомец погиб. Вы можете завести нового"

    # Списываем 100 тугриков за яблоко
    record, error = casino.spend(user_id, APPLE_COST)
    if error:
        return None, error

    now = int(time.time())
    # Кормление восстанавливает 1 сердечко и обновляет таймер
    new_health = min(MAX_HEALTH, pet["health"] + 1)
    # Корректируем last_fed_at, чтобы соответствовать новому уровню здоровья
    # Здоровье = MAX_HEALTH - (now - last_fed)/86400  =>  now - last_fed = (MAX_HEALTH - new_health)*86400
    hearts_missing = MAX_HEALTH - new_health
    pet["last_fed_at"] = now - (hearts_missing * SECONDS_PER_HEART)
    pet["health"] = new_health
    pet["alive"] = True

    save_pet_raw(user_id, pet)
    return get_pet(user_id), None


def buy_item(user_id, item_id):
    pet = get_pet(user_id)
    if not pet:
        return None, "У вас ещё нет питомца"
    if not pet.get("alive"):
        return None, "Питомец погиб"

    item = ITEMS_BY_ID.get(item_id)
    if not item:
        return None, "Товар не найден"

    inventory = pet.get("inventory") or []
    if item_id in inventory:
        return None, "Этот предмет уже куплен"

    record, error = casino.spend(user_id, item["price"])
    if error:
        return None, error

    inventory.append(item_id)
    pet["inventory"] = inventory

    # Автоматически надеваем купленный предмет
    equipped = pet.get("equipped") or {"hat": None, "neck": None}
    item_type = item.get("type", "hat")
    equipped[item_type] = item_id
    pet["equipped"] = equipped

    save_pet_raw(user_id, pet)
    return get_pet(user_id), None


def equip_item(user_id, item_id):
    pet = get_pet(user_id)
    if not pet:
        return None, "У вас ещё нет питомца"
    if not pet.get("alive"):
        return None, "Питомец погиб"

    inventory = pet.get("inventory") or []
    equipped = pet.get("equipped") or {"hat": None, "neck": None}

    if item_id:
        if item_id not in inventory:
            return None, "Предмет не куплен"
        item = ITEMS_BY_ID.get(item_id)
        if not item:
            return None, "Неизвестный предмет"
        item_type = item.get("type", "hat")

        # Если уже надет — снимаем, иначе надеваем
        if equipped.get(item_type) == item_id:
            equipped[item_type] = None
        else:
            equipped[item_type] = item_id
    else:
        equipped = {"hat": None, "neck": None}

    pet["equipped"] = equipped
    save_pet_raw(user_id, pet)
    return get_pet(user_id), None


def start_work(user_id):
    pet_info = get_pet(user_id)
    if not pet_info:
        return None, "У вас ещё нет питомца"
    if not pet_info.get("alive"):
        return None, "Питомец погиб. Сначала заведите нового"

    work_info = get_work_status(pet_info)
    if work_info["status"] == "working":
        return None, "ЧЕЛИК уже работает в шахте"
    if work_info["status"] == "ready":
        return None, "Сначала заберите добычу за прошлую смену"
    if work_info["shifts_today"] >= MAX_WORK_SHIFTS_PER_DAY:
        return None, "На сегодня рабочий день окончен (максимум 3 смены в день)"

    # Проверка здоровья: нужно минимум 2 сердца, если сердечко за день еще не списывалось
    if pet_info.get("health", 0) < 2 and not work_info.get("heart_lost_today"):
        return None, "ЧЕЛИК слишком устал (нужно хотя бы 2 ❤️). Покормите его яблоком перед сменой!"

    now = int(time.time())
    work = pet_info.get("work") or {}
    today_str = _moscow_date(now)
    if work.get("day_date") != today_str:
        work["day_date"] = today_str
        work["shifts_today"] = 0
        work["heart_lost_today"] = False

    work["started_at"] = now
    work["day_date"] = today_str
    pet_info["work"] = work

    save_pet_raw(user_id, pet_info)
    return get_pet(user_id), None


def claim_work(user_id):
    pet_info = get_pet_raw(user_id)
    if not pet_info:
        return None, "У вас ещё нет питомца"

    health, alive = calculate_health(pet_info)
    pet_info["health"] = health
    pet_info["alive"] = alive
    if not alive:
        return None, "Питомец погиб"

    work_info = get_work_status(pet_info)
    if work_info["status"] != "ready":
        if work_info["status"] == "working":
            mins = max(1, (work_info["remaining_seconds"] + 59) // 60)
            return None, f"Смена ещё не окончена (осталось {mins} мин)"
        return None, "Нет готовой добычи. Сначала отправьте ЧЕЛИКА в шахту"

    now = int(time.time())
    work = pet_info.get("work") or {}
    today_str = _moscow_date(now)
    if work.get("day_date") != today_str:
        work["day_date"] = today_str
        work["shifts_today"] = 0
        work["heart_lost_today"] = False

    lvl = max(1, min(MAX_LEVEL, int(pet_info.get("level") or 1)))
    base_reward = WORK_REWARDS.get(lvl, 100)

    # Lucky drop (~10% шанс)
    import random
    rnd = random.random()
    total_reward = base_reward
    lucky_drop = None

    if rnd < 0.05:
        # Самоцвет +50 тугриков
        bonus = 50
        total_reward += bonus
        lucky_drop = {
            "type": "gem",
            "name": "💎 Драгоценный самоцвет",
            "bonus": bonus,
            "text": f"💎 Вау! ЧЕЛИК откопал редкий самоцвет (+{bonus} 💰 бонусом)!",
        }
    elif rnd < 0.10 and pet_info.get("health", 0) < MAX_HEALTH:
        # Шахтерское яблоко +1 сердечко
        lucky_drop = {
            "type": "apple",
            "name": "🍏 Шахтёрское яблоко",
            "text": "🍏 ЧЕЛИК нашёл в пещере подземное яблоко (+1 ❤️)!",
        }

    # Начисляем тугрики игроку
    rec = casino.add_coins(user_id, total_reward)

    # Списываем сердечко, если это первая смена за сегодня
    health_lost = False
    if not work.get("heart_lost_today"):
        cur_health = pet_info.get("health", MAX_HEALTH)
        new_health = max(1, cur_health - 1)
        hearts_missing = MAX_HEALTH - new_health
        pet_info["last_fed_at"] = now - (hearts_missing * SECONDS_PER_HEART)
        pet_info["health"] = new_health
        work["heart_lost_today"] = True
        health_lost = True

    # Если выпало яблоко в lucky_drop, восстанавливаем сердечко
    if lucky_drop and lucky_drop.get("type") == "apple":
        cur_health = pet_info.get("health", 1)
        new_health = min(MAX_HEALTH, cur_health + 1)
        hearts_missing = MAX_HEALTH - new_health
        pet_info["last_fed_at"] = now - (hearts_missing * SECONDS_PER_HEART)
        pet_info["health"] = new_health

    # Фиксируем отработанную смену
    work["started_at"] = None
    work["shifts_today"] = int(work.get("shifts_today") or 0) + 1
    work["day_date"] = _moscow_date(now)
    pet_info["work"] = work

    save_pet_raw(user_id, pet_info)
    updated_pet = get_pet(user_id)
    return {
        "pet": updated_pet,
        "reward": total_reward,
        "base_reward": base_reward,
        "balance": rec.get("balance"),
        "lucky_drop": lucky_drop,
        "health_lost": health_lost,
    }, None
