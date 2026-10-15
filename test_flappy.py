# -*- coding: utf-8 -*-
"""
Тесты для Flappy Челик API.
Начисление тугриков ТОЛЬКО при побитии личного рекорда (вся сумма нового рекорда).
"""

import sys
from unittest.mock import MagicMock
sys.modules["requests"] = MagicMock()
sys.modules["bs4"] = MagicMock()
if "flask" not in sys.modules:
    sys.modules["flask"] = MagicMock()
    mock_flask = sys.modules["flask"]
    mock_flask.Blueprint = lambda *a, **k: MagicMock()

import flappy_api
import store
import casino


class Flask:
    def __init__(self, *a, **k): pass
    def register_blueprint(self, *a, **k): pass


def test_flappy():
    app = Flask(__name__)
    flappy_api.init_app(app)

    store.set_store(store.MemoryStore())
    uid = 77777

    # 1. Начальное состояние
    data = flappy_api.get_user_flappy(uid)
    assert data["best_score"] == 0
    assert data["games_played"] == 0
    print("✓ Начальное состояние Flappy Челик корректно (best_score = 0)")

    # 2. Игра со счетом 0
    score = 0
    old_best = data.get("best_score", 0)
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert not is_record
    assert coins_to_award == 0
    print("✓ Счет 0 не дает тугриков")

    # 3. Первая игра: пролетел 15 труб
    score = 15
    old_best = data.get("best_score", 0)
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert is_record is True
    assert coins_to_award == 15
    data["best_score"] = score
    data["games_played"] += 1
    flappy_api.save_user_flappy(uid, data)
    casino.add_coins(uid, coins_to_award)

    bal = casino.load(uid)["balance"]
    assert bal == 15
    print("✓ Первая игра со счетом 15: новый рекорд 15, начислено 15 тугриков")

    # 4. Вторая игра: счет 10 (меньше рекорда 15)
    score = 10
    data = flappy_api.get_user_flappy(uid)
    old_best = data.get("best_score", 0)
    assert old_best == 15
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert is_record is False
    assert coins_to_award == 0
    if coins_to_award > 0:
        casino.add_coins(uid, coins_to_award)
    bal = casino.load(uid)["balance"]
    assert bal == 15
    print("✓ Игра со счетом 10 (при рекорде 15): 0 тугриков, баланс 15")

    # 5. Третья игра: побит рекорд, пролетел 42 трубы
    score = 42
    old_best = data.get("best_score", 0)
    is_record = score > old_best
    coins_to_award = score if is_record else 0
    assert is_record is True
    assert coins_to_award == 42
    data["best_score"] = score
    data["games_played"] += 1
    flappy_api.save_user_flappy(uid, data)
    casino.add_coins(uid, coins_to_award)

    bal = casino.load(uid)["balance"]
    assert bal == 15 + 42  # 57
    print("✓ Игра с новым рекордом 42: начислено 42 тугрика, баланс 57")

    print("\nВсе тесты логики Flappy Челик успешно пройдены!")


if __name__ == "__main__":
    test_flappy()
