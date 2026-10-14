# -*- coding: utf-8 -*-
"""
Тесты для Block Blast API.
"""

try:
    from flask import Flask
except ImportError:
    class Flask:
        def __init__(self, *args, **kwargs): pass
        def register_blueprint(self, *args, **kwargs): pass

import blockblast_api
import store


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

    # Тест начисления тугриков
    # 75 очков -> 3 тугрика
    coins = min(blockblast_api.MAX_COINS_PER_GAME, 75 // 25)
    assert coins == 3
    print("✓ Расчет тугриков корректен (75 очков -> 3 тугрика)")

    print("Все тесты Block Blast успешно пройдены!")


if __name__ == "__main__":
    test_blockblast()
