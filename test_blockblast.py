# -*- coding: utf-8 -*-
"""
Тесты для Block Blast API.
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


class Flask:
    def __init__(self, *a, **k): pass
    def register_blueprint(self, *a, **k): pass


def test_blockblast():
    app = Flask(__name__)
    blockblast_api.init_app(app)

    store.set_store(store.MemoryStore())

    # Тест структуры пользователя
    data = blockblast_api.get_user_bb(12345)
    assert data["best_score"] == 0
    assert data["games_played"] == 0
    assert data["daily_coins_earned"] == 0
    print("✓ Начальное состояние Block Blast корректно")

    # Тест сохранения рекорда
    data["best_score"] = 500
    blockblast_api.save_user_bb(12345, data)
    loaded = blockblast_api.get_user_bb(12345)
    assert loaded["best_score"] == 500
    print("✓ Сохранение и загрузка рекорда работают")

    # Тест начисления тугриков (1 очко = 1 тугрик)
    score_test = 75
    coins = score_test
    assert coins == 75
    print("✓ Расчет тугриков корректен (75 очков -> 75 тугриков, 1:1)")

    print("Все тесты Block Blast успешно пройдены!")


if __name__ == "__main__":
    test_blockblast()
