# -*- coding: utf-8 -*-
"""
Модуль домашних заданий из Telegram-канала группы.

Парсит посты с ДЗ (шаблоны с 📌предметом📌, дедлайном, ссылками и фото),
сохраняет их в хранилище и привязывает к конкретному предмету и дню в расписании.
"""

import json
import os
import re
import time
import urllib.parse
from datetime import date, datetime, timedelta

import store

HW_KEY = "homework:items"


def _done_key(user_id):
    return f"homework:done:{user_id}"


def normalize_subject(s):
    """Нормализует название предмета для надёжного сравнения."""
    if not s:
        return ""
    s = s.lower().replace("ё", "е")
    # Удаляем пунктуацию и лишние пробелы
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def classify_link(url):
    """
    Классифицирует ссылку и формирует красивую иконку с подписью.
    """
    u = url.lower()
    if "docs.google.com/document" in u:
        return "📄", "Google Документ"
    if "docs.google.com/spreadsheets" in u:
        return "📊", "Google Таблица"
    if "docs.google.com/presentation" in u:
        return "📽", "Google Презентация"
    if ".pdf" in u:
        try:
            path = urllib.parse.urlparse(url).path
            fname = path.split("/")[-1] if "/" in path else "Файл PDF"
            fname = urllib.parse.unquote(fname)
            # Убираем расширение и подчёркивания для чистоты
            fname = re.sub(r"\.pdf$", "", fname, flags=re.IGNORECASE)
            fname = fname.replace("_", " ").strip()
            if len(fname) > 40:
                fname = fname[:37] + "…"
            return "📕", fname or "Файл PDF"
        except Exception:
            return "📕", "Файл PDF"
    if "drive.google.com" in u or "yadi.sk" in u or "disk.yandex" in u:
        return "📁", "Файлы на диске"
    if "userapi.com" in u or "vk.com" in u:
        return "📎", "Материал ВКонтакте"

    try:
        domain = urllib.parse.urlparse(url).netloc
        domain = re.sub(r"^www\.", "", domain)
        return "🔗", domain or "Ссылка"
    except Exception:
        return "🔗", "Ссылка"


def extract_links(text):
    """Находит все URL в тексте и структурирует их."""
    if not text:
        return []
    # Находим URL без замыкающих скобок и пунктуации
    raw_urls = re.findall(r"(https?://[^\s<>\"'\)]+)", text)
    seen = set()
    links = []
    for raw in raw_urls:
        url = raw.rstrip(".,;:")
        if url and url not in seen:
            seen.add(url)
            icon, title = classify_link(url)
            links.append({
                "url": url,
                "icon": icon,
                "title": title
            })
    return links


def extract_deadline(text, ref_date=None):
    """
    Ищет дату дедлайна в тексте поста (например, '❗️Дедлайн - 29.09❗️', 'до 18.10').
    Возвращает дату в формате YYYY-MM-DD или None.
    """
    if not text:
        return None

    pattern = (
        r"(?:[❗️‼️⚠️📌📍]*\s*)?"
        r"(?:дедлайн|срок|сдать до|до|сдача|к)\s*[-—:\s]\s*"
        r"(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?"
    )
    m = re.search(pattern, text, re.IGNORECASE)
    if not m:
        return None

    try:
        day = int(m.group(1))
        month = int(m.group(2))
        year_val = m.group(3)

        if not (1 <= day <= 31 and 1 <= month <= 12):
            return None

        today = ref_date or date.today()

        if year_val:
            year = int(year_val)
            if year < 100:
                year += 2000
        else:
            # Учебный год: если текущий месяц в осеннем семестре (9..12):
            # месяцы 9..12 относятся к текущему году, 1..8 — к следующему.
            cur_year = today.year
            cur_month = today.month

            if cur_month >= 9:
                year = cur_year if month >= 8 else cur_year + 1
            else:
                year = cur_year if month <= 8 else cur_year - 1

        target_date = date(year, month, day)
        return target_date.isoformat()
    except Exception:
        return None


def find_next_schedule_date(subject_query, schedule_data=None, after_date=None):
    """
    Ищет в расписании ближайшую дату, на которую выпадает указанный предмет.
    """
    if not subject_query:
        return None

    norm_query = normalize_subject(subject_query)
    today_iso = (after_date or date.today()).isoformat()

    if not schedule_data:
        try:
            import parser
            schedule_data = parser.cached_schedule()
        except Exception:
            schedule_data = {}

    if not schedule_data:
        return None

    for iso in sorted(schedule_data.keys()):
        if iso < today_iso:
            continue
        lessons = schedule_data.get(iso) or []
        for l in lessons:
            subj = l.get("subject") or ""
            norm_subj = normalize_subject(subj)
            if norm_query in norm_subj or norm_subj in norm_query:
                return iso

    return None


def clean_homework_text(raw_text):
    """
    Убирает заголовок с пинами и строку с дедлайном,
    оставляя только полезное содержание задания.
    """
    if not raw_text:
        return ""

    lines = raw_text.splitlines()
    clean_lines = []
    first_pin_removed = False

    for line in lines:
        stripped = line.strip()

        # Первая строка с пинами 📌...📌
        if not first_pin_removed and re.match(r"^[📌📍].*[📌📍]$", stripped):
            first_pin_removed = True
            continue

        # Строка с дедлайном
        if re.search(r"(?:[❗️‼️⚠️]*\s*)?(?:дедлайн|срок|сдать до)\s*[-—:]", stripped, re.IGNORECASE):
            continue

        clean_lines.append(line)

    res = "\n".join(clean_lines).strip()
    return res or raw_text.strip()


def parse_homework_post(text, photos=None, post_link=None, channel_id=None, message_id=None, message_date=None, schedule_data=None):
    """
    Главный парсер поста Telegram с ДЗ.

    Возвращает словарь с нормализованными данными для сохранения.
    """
    text = (text or "").strip()
    if not text and not photos:
        return None

    # 1. Извлекаем название предмета
    subject = None
    pin_match = re.search(r"[📌📍]\s*([^📌📍\n]+?)\s*[📌📍]", text)
    if pin_match:
        subject = pin_match.group(1).strip()
    else:
        # Если пинов нет, берём первую непустую строку
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        if lines:
            subject = lines[0]

    if not subject:
        subject = "Задание"

    ref_date = date.today()
    if message_date:
        try:
            ref_date = datetime.fromtimestamp(message_date).date()
        except Exception:
            pass

    # 2. Дедлайн
    deadline_iso = extract_deadline(text, ref_date)

    # Если дедлайна в тексте нет — ищем ближайшую пару в расписании
    if not deadline_iso:
        next_date = find_next_schedule_date(subject, schedule_data, ref_date)
        if next_date:
            deadline_iso = next_date

    # 3. Ссылки
    links = extract_links(text)

    # 4. Очищенный текст
    clean_text = clean_homework_text(text)

    # 5. ID задания (уникальный по каналу и сообщению)
    now_ts = int(time.time())
    if channel_id and message_id:
        hw_id = f"hw_{abs(int(channel_id))}_{message_id}"
    elif message_id:
        hw_id = f"hw_msg_{message_id}_{int(now_ts)}"
    else:
        import uuid
        hw_id = f"hw_{now_ts}_{uuid.uuid4().hex[:6]}"

    # Формируем структуру
    return {
        "id": hw_id,
        "channel_id": channel_id,
        "message_id": message_id,
        "post_link": post_link,
        "subject": subject,
        "date": deadline_iso,  # YYYY-MM-DD
        "text": clean_text,
        "raw_text": text,
        "links": links,
        "photos": photos or [],
        "created_at": now_ts,
        "updated_at": now_ts,
    }


def get_all_homework():
    """Возвращает список всех сохранённых домашних заданий."""
    s = store.get_store()
    raw = s.get(HW_KEY)
    if not raw:
        return []
    try:
        if isinstance(raw, str):
            return json.loads(raw)
        return raw
    except Exception:
        return []


def save_homework_list(items):
    s = store.get_store()
    s.set(HW_KEY, json.dumps(items, ensure_ascii=False))


def save_homework(item):
    """
    Добавляет или обновляет домашнее задание в списке.
    """
    if not item or not item.get("id"):
        return None

    items = get_all_homework()
    found = False
    for i, it in enumerate(items):
        if it.get("id") == item["id"]:
            items[i] = item
            found = True
            break

    if not found:
        items.insert(0, item)

    # Ограничиваем историю последними 100 заданиями
    items = items[:100]
    save_homework_list(items)
    return item


def get_homework_by_id(hw_id):
    items = get_all_homework()
    for it in items:
        if it.get("id") == hw_id:
            return it
    return None


def delete_homework(hw_id):
    items = get_all_homework()
    items = [it for it in items if it.get("id") != hw_id]
    save_homework_list(items)
    return True


def get_user_done(user_id):
    """Возвращает множество id заданий, которые пользователь отметил как выполненные."""
    if not user_id:
        return []
    s = store.get_store()
    raw = s.get(_done_key(user_id))
    if not raw:
        return []
    try:
        if isinstance(raw, str):
            return json.loads(raw)
        return raw
    except Exception:
        return []


def toggle_user_done(user_id, hw_id):
    """Переключает статус выполнения ДЗ для конкретного пользователя."""
    if not user_id or not hw_id:
        return False, []

    s = store.get_store()
    done_list = get_user_done(user_id)
    if hw_id in done_list:
        done_list = [i for i in done_list if i != hw_id]
        is_done = False
    else:
        done_list.append(hw_id)
        is_done = True

    s.set(_done_key(user_id), json.dumps(done_list, ensure_ascii=False))
    return is_done, done_list
