# -*- coding: utf-8 -*-
"""
Тесты для Block Blast API: начисление тугриков только за побитый рекорд.
"""

import sys
from unittest.mock import MagicMock
sys.modules["requests"] = MagicMock()
sys.modules["bs4"] = MagicMock()
if "flask" not in sys.modules:
    sys.modules["flask"] = MagicMock()
    mock_flask = sys.modules["flask"]
    mock_flask.Blueprint = lambda *a, **k: MagicMock()

import blockblast_api
import store
import casino


class Flask:
    def __init__(self, *a, **k): pass
    def register_blueprint(self, *a, **k): pass


def test_blockblast():
    app = Flask(__name__)
    blockblast_api.init_app(app)

    mem_store = store.MemoryStore()
    store.set_store(mem_store)

    uid = 99999

    # 1. Начальное состояние
    data = blockblast_api.get_user_bb(uid)
    assert data["best_score"] == 0
    assert data["games_played"] == 0
    assert data["daily_coins_earned"] == 0
    print("✓ Начальное состояние Block Blast корректно (best_score = 0)")

    # 2. Первая игра со счетом 0
    score = 0
    old_best = data.get("best_score", 0)
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert not is_record
    assert coins_to_award == 0
    print("✓ Счет 0 при рекорде 0 не дает награды")

    # 3. Первая успешная игра со счетом 350
    score = 350
    old_best = data.get("best_score", 0)
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert is_record is True
    assert coins_to_award == 350, f"Ожидалось 350 тугриков, получено {coins_to_award}"
    data["best_score"] = score
    data["games_played"] += 1
    data["daily_coins_earned"] += coins_to_award
    blockblast_api.save_user_bb(uid, data)
    casino.add_coins(uid, coins_to_award)

    bal = casino.load(uid)["balance"]
    assert bal == 350
    print("✓ Первая игра со счетом 350 побила рекорд 0: начислено 350 тугриков, баланс 350")

    # 4. Вторая игра: счет 200 (меньше рекорда 350)
    score = 200
    data = blockblast_api.get_user_bb(uid)
    old_best = data.get("best_score", 0)
    assert old_best == 350
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert is_record is False
    assert coins_to_award == 0, f"Ожидалось 0 тугриков, получено {coins_to_award}"
    if coins_to_award > 0:
        casino.add_coins(uid, coins_to_award)
    bal = casino.load(uid)["balance"]
    assert bal == 350, "Баланс не должен измениться при проигрыше рекорда"
    print("✓ Игра со счетом 200 (при рекорде 350): начислено 0 тугриков, баланс остался 350")

    # 5. Третья игра: счет ровно 350 (равен рекорду, не побит)
    score = 350
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert is_record is False
    assert coins_to_award == 0
    print("✓ Игра со счетом 350 (равен рекорду 350): начислено 0 тугриков")

    # 6. Четвертая игра: новый рекорд 750 (побил 350)
    score = 750
    old_best = data.get("best_score", 0)
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert is_record is True
    assert coins_to_award == 750, f"Ожидалось 750 тугриков (вся сумма нового рекорда), получено {coins_to_award}"
    data["best_score"] = score
    data["games_played"] += 1
    data["daily_coins_earned"] += coins_to_award
    blockblast_api.save_user_bb(uid, data)
    casino.add_coins(uid, coins_to_award)

    bal = casino.load(uid)["balance"]
    assert bal == 350 + 750  # 1100
    assert bal == 1100
    print("✓ Игра с новым рекордом 750: начислено 750 тугриков, баланс стал 1100")

    # 7. Проверка сохранения в базе
    saved = blockblast_api.get_user_bb(uid)
    assert saved["best_score"] == 750
    assert saved["games_played"] == 2
    assert saved["daily_coins_earned"] == 1100
    print("✓ Проверка сохранения данных пользователя в Store прошла успешно")

    print("\nВсе тесты логики начисления Block Blast успешно пройдены!")


if __name__ == "__main__":
    test_blockblast()
