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

    # 3. Создаем питомца
    p, err = pet.adopt_pet(user_id, "Стрики")
    assert err is None
    assert p["name"] == "Стрики"
    assert p["health"] == 5
    assert p["alive"] is True
    assert p["equipped"]["hat"] is None

    # Баланс уменьшился на 1000
    rec = casino.load(user_id)
    assert rec["balance"] == 1000
    print("✓ Создание питомца за 1000 тугриков прошло успешно")

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
    assert rec["balance"] == 900
    print("✓ Кормление яблоком (+1 сердце за 100 тугриков) работает")

    # 6. Покупка кепки (300 тугриков)
    p, err = pet.buy_item(user_id, "cap")
    assert err is None
    assert "cap" in p["inventory"]
    assert p["equipped"]["hat"] == "cap"
    rec = casino.load(user_id)
    assert rec["balance"] == 600
    print("✓ Покупка и надевание кепки работают")

    # 7. Снятие кепки
    p, err = pet.equip_item(user_id, "cap")
    assert err is None
    assert p["equipped"]["hat"] is None
    print("✓ Снятие аксессуара работает")

    # 7.1. Проверка уровней питомца и улучшений
    assert p["level"] == 1
    # Попытка улучшить без тугриков (баланс 600, нужно 3000)
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
    assert rec["balance"] == 600
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
    assert rec["balance"] == 600
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

    print("Все тесты питомца успешно пройдены!")

if __name__ == "__main__":
    test_pet_lifecycle()
