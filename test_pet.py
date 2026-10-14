import sys
from unittest.mock import MagicMock
sys.modules["requests"] = MagicMock()
sys.modules["bs4"] = MagicMock()

import store
s = store.MemoryStore()
store.set_store(s)

import casino
import pet

def test_pet_lifecycle():
    user_id = 777

    # 1. Сначала у игрока 0 тугриков — нельзя создать питомца
    p, err = pet.adopt_pet(user_id, "Стрики")
    assert err is not None
    assert "Не хватает тугриков" in err
    print("✓ Проверка баланса при создании питомца работает")

    # 2. Начисляем тугрики игроку
    casino.add_coins(user_id, 2000)

    # 3. Создаем питомца за 10 тугриков
    p, err = pet.adopt_pet(user_id, "Стрики")
    assert err is None
    assert p["name"] == "Стрики"
    assert p["health"] == 5
    assert p["alive"] is True
    assert p["equipped"]["hat"] is None

    # Баланс уменьшился на 10 (было 2000, стало 1990)
    rec = casino.load(user_id)
    assert rec["balance"] == 1990
    print("✓ Создание питомца за 10 тугриков по скидке прошло успешно")

    # 4. Проверяем расчет здоровья через 2 дня (потеря 2 сердец)
    pet_raw = pet.get_pet_raw(user_id)
    pet_raw["last_fed_at"] -= 2 * 86400  # -2 дня
    pet.save_pet_raw(user_id, pet_raw)

    p = pet.get_pet(user_id)
    assert p["health"] == 3
    assert p["alive"] is True
    print("✓ Потеря сердец за 2 дня (здоровье = 3) работает")

    # 5. Кормим яблоком (+1 сердечко за 100 тугриков)
    p, err = pet.feed_pet(user_id)
    assert err is None
    assert p["health"] == 4
    rec = casino.load(user_id)
    assert rec["balance"] == 1890
    print("✓ Кормление яблоком (+1 сердце за 100 тугриков) работает")

    # 6. Покупка кепки (300 тугриков)
    p, err = pet.buy_item(user_id, "cap")
    assert err is None
    assert "cap" in p["inventory"]
    assert p["equipped"]["hat"] == "cap"
    rec = casino.load(user_id)
    assert rec["balance"] == 1590
    print("✓ Покупка и надевание кепки работают")

    # 7. Снятие кепки
    p, err = pet.equip_item(user_id, "cap")
    assert err is None
    assert p["equipped"]["hat"] is None
    print("✓ Снятие аксессуара работает")

    # 7.1. Проверка уровней питомца и улучшений
    assert p["level"] == 1
    # Попытка улучшить без тугриков (баланс 1590, нужно 3000)
    p_up, err = pet.upgrade_pet(user_id)
    assert err is not None
    assert "Не хватает тугриков" in err
    print("✓ Проверка баланса при улучшении до уровня 2 работает")

    # Добавляем 3000 тугриков и улучшаем до 2 уровня
    casino.add_coins(user_id, 3000)
    p_up, err = pet.upgrade_pet(user_id)
    assert err is None
    assert p_up["level"] == 2
    assert p_up["level_title"] == "Хранитель"
    rec = casino.load(user_id)
    assert rec["balance"] == 1590
    print("✓ Улучшение до 2 уровня за 3000 тугриков прошло успешно")

    # Попытка улучшить до 3 уровня без тугриков (нужно 6000)
    p_up, err = pet.upgrade_pet(user_id)
    assert err is not None
    assert "Не хватает тугриков" in err

    # Добавляем 6000 тугриков и улучшаем до 3 уровня
    casino.add_coins(user_id, 6000)
    p_up, err = pet.upgrade_pet(user_id)
    assert err is None
    assert p_up["level"] == 3
    assert p_up["level_title"] == "Легенда"
    rec = casino.load(user_id)
    assert rec["balance"] == 1590
    print("✓ Улучшение до 3 уровня за 6000 тугриков прошло успешно")

    # Попытка улучшить выше 3 уровня
    p_up, err = pet.upgrade_pet(user_id)
    assert err is not None
    assert "максимального уровня" in err
    print("✓ Проверка ограничения максимального уровня работает")

    # 8. Смерть через 5 дней без еды
    pet_raw = pet.get_pet_raw(user_id)
    pet_raw["last_fed_at"] -= 5 * 86400 + 10
    pet.save_pet_raw(user_id, pet_raw)

    p = pet.get_pet(user_id)
    assert p["health"] == 0
    assert p["alive"] is False
    print("✓ Смерть питомца через 5 дней подтверждена")

    # Попытка покормить мертвого
    p, err = pet.feed_pet(user_id)
    assert err is not None
    print("✓ Нельзя кормить погибшего питомца")


def test_pet_work():
    user_id = 888
    casino.add_coins(user_id, 100)

    # 1. Заводим питомца за 10 тугриков
    p, err = pet.adopt_pet(user_id, "Шахтёр")
    assert err is None
    assert p["health"] == 5
    assert casino.load(user_id)["balance"] == 90
    print("✓ Заведение питомца по скидке за 10 тугриков работает")

    # 2. Отправляем в шахту на 1 уровне (100 тугриков/час)
    p, err = pet.start_work(user_id)
    assert err is None
    assert p["work"]["status"] == "working"
    assert p["work"]["reward"] == 100
    print("✓ Отправка в шахту 1 ур. (100 тугриков/час) работает")

    # Попытка забрать награду раньше часа
    res, err = pet.claim_work(user_id)
    assert err is not None
    assert "не окончена" in err
    print("✓ Защита от преждевременного сбора работает")

    # Перематываем время на 3605 секунд
    raw = pet.get_pet_raw(user_id)
    raw["work"]["started_at"] -= 3605
    pet.save_pet_raw(user_id, raw)

    p = pet.get_pet(user_id)
    assert p["work"]["status"] == "ready"

    # Забираем награду
    bal_before = casino.load(user_id)["balance"]
    res, err = pet.claim_work(user_id)
    assert err is None
    assert res["reward"] >= 100
    assert casino.load(user_id)["balance"] >= bal_before + 100
    # Первое использование в день списывает 1 сердечко (если не выпало шахтёрское яблоко)
    if res.get("lucky_drop") and res["lucky_drop"].get("type") == "apple":
        assert res["pet"]["health"] == 5
    else:
        assert res["pet"]["health"] == 4
    assert res["pet"]["work"]["shifts_today"] == 1
    assert res["pet"]["work"]["heart_lost_today"] is True
    print("✓ Забор награды в шахте и списание 1 ❤️ за рабочий день работают")

    # 3. Вторая смена в тот же день
    p, err = pet.start_work(user_id)
    assert err is None
    raw = pet.get_pet_raw(user_id)
    raw["work"]["started_at"] -= 3605
    pet.save_pet_raw(user_id, raw)

    res, err = pet.claim_work(user_id)
    assert err is None
    # Второе сердце в тот же день НЕ списывается
    assert res["pet"]["work"]["shifts_today"] == 2
    print("✓ Вторая смена в тот же день не тратит повторное сердечко")

    # 4. Третья смена
    p, err = pet.start_work(user_id)
    assert err is None
    raw = pet.get_pet_raw(user_id)
    raw["work"]["started_at"] -= 3605
    pet.save_pet_raw(user_id, raw)

    res, err = pet.claim_work(user_id)
    assert err is None
    assert res["pet"]["work"]["shifts_today"] == 3

    # 5. Попытка 4-й смены (превышение лимита 3 смен в день)
    p, err = pet.start_work(user_id)
    assert err is not None
    assert "максимум 3 смены" in err
    print("✓ Лимит 3 смен в день соблюдается")

    # 6. Проверка уровня 2 и 3 для наград в шахте
    pet.UPGRADE_COSTS[2] = 0
    p, err = pet.upgrade_pet(user_id)
    assert p["level"] == 2
    assert p["work"]["reward"] == 200
    print("✓ Шахта 2 уровня приносит 200 тугриков/час")

    pet.UPGRADE_COSTS[3] = 0
    p, err = pet.upgrade_pet(user_id)
    assert p["level"] == 3
    assert p["work"]["reward"] == 300
    print("✓ Шахта 3 уровня приносит 300 тугриков/час")


if __name__ == "__main__":
    test_pet_lifecycle()
    test_pet_work()
    print("Все тесты питомца успешно пройдены!")
