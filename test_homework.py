# -*- coding: utf-8 -*-
"""
Тесты для парсинга и хранения домашних заданий из Telegram-канала.
"""

import sys
from unittest.mock import MagicMock
sys.modules["requests"] = MagicMock()
sys.modules["bs4"] = MagicMock()

import store
s = store.MemoryStore()
store.set_store(s)

import homework


def test_homework_parsing():
    post1 = """📌Социально-педагогическая девиантология📌

Задание в парах. Подготовить по своей теме выступление и презентацию, в ней вставить фото сделанного вами буклета, ориентированного на школьников .
Что входит: признаки, правила/рекомендации, полезные специалисты и учреждения

(При желании буклет можно принести)

Бронируем темы в комментариях

❗️Дедлайн - 29.09❗️"""

    item1 = homework.parse_homework_post(post1, channel_id=-100111, message_id=101)
    assert item1 is not None
    assert item1["subject"] == "Социально-педагогическая девиантология"
    assert item1["date"] == "2026-09-29"
    assert "Задание в парах" in item1["text"]
    assert "📌" not in item1["text"]
    assert "Дедлайн" not in item1["text"]
    print("✓ Пост 1: предмет и дедлайн 29.09 успешно распознаны")

    post2 = """📌Социально-педагогическая девиантология📌

Выполнить задание с фото:
№12 - для отсутствующих 22.09

№13 - заполнить таблицу с фото
1. https://psv4.userapi.com/s/v1/d/Yms-aiihKjycviVvMrpOsH6chKg1f98tgNQEN_pHcQj4fgEbtVgzIWIZEhhIqccIXgHXKpK-Tj2D47qFvBflFer2YVXziMGsk3wtvlJDKqemJS4yfboR9A/Merton_R_K_-_Sotsialnaya_struktura_i_anomia-1.pdf
2. https://psv4.userapi.com/s/v1/d/clFV8EWzQ2WLB9GoTrakICxxgSmBb9d_D4zOsKNX-aWYP41nx1lC5PeRO2S1MJdjizalRhYpWCALSrWrp6Xdtl4gTGIpkuAQNhfAAcZast-PzV4P8xGdbg/1992_Norma_i_patologia.pdf

№14 - выложено выше (доклад с буклетом)

❗️Дедлайн - 29.09❗️"""

    item2 = homework.parse_homework_post(
        post2,
        photos=[{"file_id": "photo_123", "width": 1280, "height": 720}],
        channel_id=-100111,
        message_id=102,
        post_link="https://t.me/c/111/102"
    )
    assert item2 is not None
    assert item2["subject"] == "Социально-педагогическая девиантология"
    assert item2["date"] == "2026-09-29"
    assert len(item2["links"]) == 2
    assert item2["links"][0]["icon"] == "📕"
    assert "Merton" in item2["links"][0]["title"]
    assert len(item2["photos"]) == 1
    assert item2["photos"][0]["file_id"] == "photo_123"
    assert item2["post_link"] == "https://t.me/c/111/102"
    print("✓ Пост 2: 2 ссылки на PDF и прикреплённое фото успешно обработаны")

    post3 = """📌Активизация ресурсного состояния семьи📌

1. Нарисовать одну из трех тем и прикрепить фото рисунка в Гугл документ https://docs.google.com/document/d/17tbwALY5AWMMJPB5KIjhNvd-CKpuuOqaZFVkTZme2lA/edit?tab=t.0

• Ваше плохое настроение 
• Сложить лист гармошкой и на каждой из частей гармошки нарисовать этап своей жизни в хронологическом порядке 
• Ваше хобби 

2. Книги для активизации ресурсного состояния семьи вставить в тот же Гугл документ 

3. Сочинить сказку для активизации ресурсного состояния семьи (для ребенка) и вставить ее в Гугл документ 

Вечером сделаю разделы каждого задания, пожалуйста, вставляйте задание в нужное место"""

    # Имитируем расписание с этой парой
    mock_schedule = {
        "2026-10-18": [
            {"subject": "Активизация ресурсного состояния семьи", "time": "11:00 - 12:30"}
        ]
    }

    item3 = homework.parse_homework_post(
        post3,
        channel_id=-100111,
        message_id=103,
        schedule_data=mock_schedule
    )
    assert item3 is not None
    assert item3["subject"] == "Активизация ресурсного состояния семьи"
    assert item3["date"] == "2026-10-18"  # Автоматически найдено в расписании!
    assert len(item3["links"]) == 1
    assert item3["links"][0]["icon"] == "📄"
    assert item3["links"][0]["title"] == "Google Документ"
    print("✓ Пост 3: автоматическое определение дедлайна по расписанию и Google Docs работают")

    # Проверка сохранения
    homework.save_homework(item1)
    homework.save_homework(item2)
    homework.save_homework(item3)

    all_hw = homework.get_all_homework()
    assert len(all_hw) == 3
    print("✓ Сохранение и выборка заданий работают")

    # Редактирование существующего (тот же channel_id и message_id)
    post2_edited = post2.replace("29.09", "30.09")
    item2_edited = homework.parse_homework_post(
        post2_edited,
        channel_id=-100111,
        message_id=102
    )
    homework.save_homework(item2_edited)
    all_hw_after = homework.get_all_homework()
    assert len(all_hw_after) == 3
    updated = homework.get_homework_by_id(item2["id"])
    assert updated["date"] == "2026-09-30"
    print("✓ Обновление отредактированного поста в канале работает")

    # Личные отметки выполнения
    user_alice = 1001
    done, done_list = homework.toggle_user_done(user_alice, item1["id"])
    assert done is True
    assert item1["id"] in done_list

    done2, done_list2 = homework.toggle_user_done(user_alice, item1["id"])
    assert done2 is False
    assert item1["id"] not in done_list2
    print("✓ Персональный чекбокс выполнения задания работает")

    print("\nВсе тесты домашних заданий успешно пройдены!")


if __name__ == "__main__":
    test_homework_parsing()
