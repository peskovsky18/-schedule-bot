import sys
from unittest.mock import MagicMock
sys.modules["requests"] = MagicMock()
sys.modules["bs4"] = MagicMock()

import casino
import store
import ttt_game

# Используем MemoryStore для тестов
s = store.MemoryStore()
store.set_store(s)

ALICE = {"id": 101, "name": "Алиса"}
BOB = {"id": 202, "name": "Боб"}

# 1. Тест создания партии
game = ttt_game.create_game(ALICE)
assert game["status"] == "waiting"
assert game["x"]["id"] == 101
assert game["turn"] == "X"
print("✓ Создание партии прошло успешно")

# 2. Тест присоединения соперника
game, error = ttt_game.join_game(game, BOB)
assert error is None
assert game["status"] == "active"
assert game["o"]["id"] == 202
print("✓ Присоединение прошло успешно")

# 3. Тест ходов: X ходит в клетку 0
game, error, _ = ttt_game.make_move(game, ALICE["id"], 0)
assert error is None
assert game["board"][0] == "X"
assert game["turn"] == "O"

# O ходит в клетку 10
game, error, _ = ttt_game.make_move(game, BOB["id"], 10)
assert error is None
assert game["board"][10] == "O"
assert game["turn"] == "X"

# Попытка сходить в занятую клетку
_, error, _ = ttt_game.make_move(game, ALICE["id"], 0)
assert error is not None
print("✓ Проверка занятой клетки работает")

# Попытка сходить не в свою очередь
_, error, _ = ttt_game.make_move(game, BOB["id"], 1)
assert error is not None
print("✓ Проверка очередности хода работает")

# X ходит в 1, O в 5, X в 2, O в 6, X в 3 (победа первой строки 0, 1, 2, 3)
game, error, _ = ttt_game.make_move(game, ALICE["id"], 1)
game, error, _ = ttt_game.make_move(game, BOB["id"], 5)
game, error, _ = ttt_game.make_move(game, ALICE["id"], 2)
game, error, _ = ttt_game.make_move(game, BOB["id"], 6)
game, error, reward_id = ttt_game.make_move(game, ALICE["id"], 3)

assert error is None
assert game["status"] == "finished"
assert game["winner"] == "X"
assert game["winning_line"] == [0, 1, 2, 3]
assert reward_id == ALICE["id"]
print("✓ Победа по горизонтали зафиксирована, награда выдана")

# Проверяем, что Алисе начислены тугрики
alice_rec = casino.load(ALICE["id"])
assert alice_rec["balance"] >= ttt_game.TTT_WIN_COINS
print("✓ Баланс победителя пополнен")

# 4. Тест ничьей на поле 5х5
# Заполняем поле до ничьей
game2 = ttt_game.create_game(ALICE)
game2, _ = ttt_game.join_game(game2, BOB)

# Шахматный паттерн без 4 в ряд
# X X O O X
# O O X X O
# X X O O X
# O O X X O
# X X O O X
draw_pattern = [
    "X", "X", "O", "O", "X",
    "O", "O", "X", "X", "O",
    "X", "X", "O", "O", "X",
    "O", "O", "X", "X", "O",
    "X", "X", "O", "O", "X"
]
game2["board"] = draw_pattern
w, l = ttt_game.check_board_winner(draw_pattern)
assert w == "draw"
print("✓ Ничья зафиксирована корректно")

# 5. Тест таблицы лидеров
casino.sync_player(ALICE["id"], ALICE["name"])
casino.sync_player(BOB["id"], BOB["name"])
casino.add_coins(BOB["id"], 500)

leaderboard = casino.get_leaderboard(current_user_id=ALICE["id"])
assert len(leaderboard["leaders"]) == 2
assert leaderboard["leaders"][0]["id"] == BOB["id"] # У Боба 500
assert leaderboard["leaders"][1]["id"] == ALICE["id"] # У Алисы 100
assert leaderboard["myRank"] == 2
print("✓ Таблица лидеров работает и правильно ранжирует игроков")

print("Все тесты успешно пройдены!")
