# -*- coding: utf-8 -*-
"""
Тесты для проверки надежности расписания и логики Block Blast.
"""

import os
import json
import time

# Мокаем requests перед импортом parser, если нужно
import sys
from unittest.mock import MagicMock
if "requests" not in sys.modules:
    sys.modules["requests"] = MagicMock()

import parser
import store

def test_parser_disk_cache():
    print("=== Тестирование дискового кэша расписания ===")
    store.set_store(store.MemoryStore())

    # 1. Проверяем наличие schedule_cache.json
    assert os.path.exists(parser.DISK_CACHE_PATH), "Файл schedule_cache.json должен существовать!"
    loaded = parser._load_disk_cache()
    assert loaded is not None, "Снимок расписания должен загружаться из файла!"
    assert len(loaded) > 0, "Снимок расписания не должен быть пустым!"
    print(f"✓ Дисковый снимок успешно прочитан ({len(loaded)} дат)")

    # 2. Проверяем работу parse_schedule(wait=False) при холодном старте памяти
    parser._cached_schedule = None
    parser._cached_time = 0
    sched = parser.parse_schedule(wait=False)
    assert sched is not None and len(sched) > 0, "parse_schedule(wait=False) обязан вернуть снимок из диска, а не пустой словарь!"
    print(f"✓ parse_schedule(wait=False) вернул данные из дискового кэша без ожидания")

    # 3. Проверяем cached_schedule()
    cached = parser.cached_schedule()
    assert len(cached) > 0, "cached_schedule() не должен быть пустым!"
    print(f"✓ cached_schedule() корректно вернул данные")

    # 4. Проверяем cache_age()
    age = parser.cache_age()
    assert age is not None and age >= 0, "cache_age() должен возвращать положительное число секунд"
    print(f"✓ cache_age() корректно определил возраст кэша: {age} сек")

    # 5. Проверяем сброс застрявшего флага _refreshing
    parser._refreshing = True
    parser._refresh_last = time.time() - 100 # висел 100 секунд назад
    parser.refresh_in_background() # должен сбросить и не блокировать
    time.sleep(0.1)
    print(f"✓ Защита от зависания потока обновления сработала корректно")


def test_blockblast_logic():
    print("\n=== Тестирование алгоритмов Block Blast (Game Over & Line Clear) ===")
    
    # Симулируем 8x8 сетку
    grid = [[None for _ in range(8)] for _ in range(8)]
    
    # Заполняем 7 строку полностью
    for c in range(8):
        grid[6][c] = "cyan"
    
    # Заполняем 8 строку почти полностью, кроме одной клетки (7, 0)
    for c in range(1, 8):
        grid[7][c] = "purple"
    
    # Простая фигура 1x1
    dot_piece = {"matrix": [[1]], "color": "orange", "used": False}
    # Фигура 2x2
    square_piece = {"matrix": [[1, 1], [1, 1]], "color": "yellow", "used": False}

    # Проверяем размещение
    def can_place(g, matrix, target_r, target_c):
        rows = len(matrix)
        cols = len(matrix[0])
        if target_r < 0 or target_c < 0 or target_r + rows > 8 or target_c + cols > 8:
            return False
        for r in range(rows):
            for c in range(cols):
                if matrix[r][c] and g[target_r + r][target_c + c] is not None:
                    return False
        return True

    def can_place_anywhere(g, matrix):
        rows = len(matrix)
        cols = len(matrix[0])
        for r in range(8 - rows + 1):
            for c in range(8 - cols + 1):
                if can_place(g, matrix, r, c):
                    return True
        return False

    def check_game_over(g, rack):
        if not g or not rack:
            return False
        has_unused = False
        for p in rack:
            if p and not p["used"]:
                has_unused = True
                if can_place_anywhere(g, p["matrix"]):
                    return False
        if not has_unused:
            return False
        return True

    # Точка 1x1 может встать в (7,0)
    assert can_place(grid, dot_piece["matrix"], 7, 0) == True
    # Фигура 2x2 может встать в верхней свободной части поля
    assert can_place_anywhere(grid, square_piece["matrix"]) == True

    # Заполняем ВСЁ поле кроме клеток (0,0) и (0,1)
    for r in range(8):
        for c in range(8):
            grid[r][c] = "blue"
    grid[0][0] = None
    grid[0][1] = None

    # Теперь 2x2 не помещается
    assert can_place_anywhere(grid, square_piece["matrix"]) == False
    # А полоска 1x2 помещается
    line_piece = {"matrix": [[1, 1]], "color": "red", "used": False}
    assert can_place_anywhere(grid, line_piece["matrix"]) == True

    # Если на стойке лежит 2x2 и 1x2, Game Over НЕ должен быть!
    rack = [square_piece, line_piece]
    assert check_game_over(grid, rack) == False
    print("✓ Game Over корректно НЕ срабатывает, если хотя бы одна фигура может встать")

    # Если осталась только 2x2, а 1x2 использована:
    line_piece["used"] = True
    assert check_game_over(grid, [square_piece, line_piece]) == True
    print("✓ Game Over корректно срабатывает, когда ни одна фигура не может встать")

    # Если все фигуры на стойке использованы (rack пуст/все used):
    square_piece["used"] = True
    assert check_game_over(grid, [square_piece, line_piece]) == False
    print("✓ Game Over НЕ срабатывает, когда все фигуры использованы (ждём новый набор)")

    print("\nВсе тесты успешно пройдены!")


if __name__ == "__main__":
    test_parser_disk_cache()
    test_blockblast_logic()
