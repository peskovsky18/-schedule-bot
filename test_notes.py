import sys
from unittest.mock import MagicMock
sys.modules["flask"] = MagicMock()
sys.modules["requests"] = MagicMock()

import store
s = store.MemoryStore()
store.set_store(s)

import notes_api

def test_notes():
    user_id = 999

    # 1. Начальный список пуст
    notes = notes_api.get_user_notes(user_id)
    assert notes == []
    print("✓ Пустой список заметок корректен")

    # 2. Добавление заметок
    test_note = {
        "id": "note_1",
        "subject": "Математический анализ",
        "text": "Сделать дз № 12, 14",
        "deadline": "2026-10-20T18:00",
        "done": False,
        "created_at": 123456
    }
    notes_api.save_user_notes(user_id, [test_note])

    loaded = notes_api.get_user_notes(user_id)
    assert len(loaded) == 1
    assert loaded[0]["subject"] == "Математический анализ"
    print("✓ Сохранение и загрузка заметок работают")

    # 3. Переключение done
    loaded[0]["done"] = True
    notes_api.save_user_notes(user_id, loaded)
    updated = notes_api.get_user_notes(user_id)
    assert updated[0]["done"] is True
    print("✓ Переключение статуса выполнено")

    # 4. Удаление
    notes_api.save_user_notes(user_id, [])
    assert notes_api.get_user_notes(user_id) == []
    print("✓ Удаление заметки работает")

    print("Все тесты хранилища заметок успешно пройдены!")

if __name__ == "__main__":
    test_notes()
