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

# O ходит в клетку 3
game, error, _ = ttt_game.make_move(game, BOB["id"], 3)
assert error is None
assert game["board"][3] == "O"
assert game["turn"] == "X"

# Попытка сходить в занятую клетку
_, error, _ = ttt_game.make_move(game, ALICE["id"], 0)
assert error is not None
print("✓ Проверка занятой клетки работает")

# Попытка сходить не в свою очередь
_, error, _ = ttt_game.make_move(game, BOB["id"], 1)
assert error is not None
print("✓ Проверка очередности хода работает")

# X ходит в 1, O в 4, X в 2 (победа первой строки 0, 1, 2)
game, error, _ = ttt_game.make_move(game, ALICE["id"], 1)
game, error, _ = ttt_game.make_move(game, BOB["id"], 4)
game, error, reward_id = ttt_game.make_move(game, ALICE["id"], 2)

assert error is None
assert game["status"] == "finished"
assert game["winner"] == "X"
assert game["winning_line"] == [0, 1, 2]
assert reward_id == ALICE["id"]
print("✓ Победа по горизонтали зафиксирована, награда выдана")

# Проверяем, что Алисе начислены тугрики
alice_rec = casino.load(ALICE["id"])
assert alice_rec["balance"] >= ttt_game.TTT_WIN_COINS
print("✓ Баланс победителя пополнен")

# 4. Тест ничьей
game2 = ttt_game.create_game(ALICE)
game2, _ = ttt_game.join_game(game2, BOB)
# X O X
# X X O
# O X O
# Порядок:
# X: 0, O: 1, X: 2, O: 5, X: 4, O: 8, X: 3, O: 6, X: 7
moves = [(ALICE, 0), (BOB, 1), (ALICE, 2), (BOB, 5), (ALICE, 4), (BOB, 8), (ALICE, 3), (BOB, 6), (ALICE, 7)]
for player, cell in moves:
    game2, error, _ = ttt_game.make_move(game2, player["id"], cell)
    assert error is None

assert game2["status"] == "finished"
assert game2["winner"] == "draw"
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
