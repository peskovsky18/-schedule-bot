# -*- coding: utf-8 -*-
"""
Тамагочи-питомец: создание, здоровье (сердечки), кормление и гардероб.
"""

import json
import time
import casino
import store

ADOPT_COST = 1000
APPLE_COST = 100
MAX_HEALTH = 5
SECONDS_PER_HEART = 86400  # 1 день = 1 сердечко (за 5 дней умирает)

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

    return pet_data


def adopt_pet(user_id, name):
    name = (name or "").strip()
    if not name:
        return None, "Укажите имя для питомца"
    if len(name) > 30:
        return None, "Имя не должно превышать 30 символов"

    # Списываем 1000 тугриков
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
        "created_at": now,
        "last_fed_at": now,
        "inventory": [],
        "equipped": {
            "hat": None,
            "neck": None,
        },
    }

    save_pet_raw(user_id, pet_data)
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
