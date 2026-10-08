# -*- coding: utf-8 -*-
"""
Парсер расписания учебного заведения.

Основной источник данных — JSON внутри Livewire-снимка страницы
(`wire:snapshot`). Там уже есть готовые поля: SCHEDULE_DATE (ISO),
TIME_START, TIME_END, NAMEDISC, LECTYPE, FIO, ROOM_NAME, NOTE, E_COURSE_URL.
Разбирать HTML регулярками больше не нужно: вёрстка может меняться, а JSON
остаётся стабильным.

Если снимок почему-то недоступен, включается резервный разбор HTML —
на случай редизайна сайта.
"""

import html as html_lib
import json
import os
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup

# =========================
# ЧАСОВОЙ ПОЯС
# =========================
# Сервер может стоять в UTC. Расписание учебное, поэтому все «сегодня»
# и «завтра» считаем строго по Москве.
try:
    from zoneinfo import ZoneInfo

    MSK = ZoneInfo("Europe/Moscow")
except Exception:  # нет tzdata — берём фиксированное смещение
    MSK = timezone(timedelta(hours=3))


def now_msk():
    return datetime.now(MSK)


# =========================
# КОНФИГ
# =========================
BASE = "https://guide.herzen.spb.ru"

# ID группы на сайте выдаётся на учебный год и каждый сентябрь меняется,
# поэтому он вынесен в переменную окружения.
# 25111 = 4об_ППРСД/23, Институт педагогики (проверено 06.10.2026).
GROUP_ID = os.getenv("GROUP_ID", "25111").strip()

# Необязательно: если задать GROUP_NAME, бот сам найдёт актуальный ID группы
# по названию (например, "4об_ППРСД"). Спасает от смены ID каждое 1 сентября.
GROUP_NAME = os.getenv("GROUP_NAME", "").strip()

WEB_TIMEOUT = 20
CACHE_TTL = 300

WEEKDAYS = [
    "понедельник", "вторник", "среда", "четверг",
    "пятница", "суббота", "воскресенье",
]

# Для интерфейса мини-приложения: «6 октября»
MONTHS_GENITIVE = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]

# Как читаются коды типов занятий с сайта
LESSON_TYPES = {
    "лекц": "лекция",
    "лекция": "лекция",
    "практ": "практика",
    "практика": "практика",
    "лаб": "лабораторная",
    "лабораторная": "лабораторная",
    "сем": "семинар",
    "семинар": "семинар",
    "зачет": "зачёт",
    "экзамен": "экзамен",
}


# =========================
# КЕШ
# =========================
_cached_schedule = None
_cached_time = 0
_cached_group = None
_cached_group_time = 0
_cached_group_info = {}
_resolved_group_id = None


# =========================
# ЗАГРУЗКА
# =========================
def fetch_html(url):
    """Скачивает страницу. Возвращает текст или None."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
        ),
        "Accept-Language": "ru-RU,ru;q=0.9",
    }

    last_error = None
    for attempt in range(2):
        try:
            r = requests.get(url, headers=headers, timeout=WEB_TIMEOUT)
            r.encoding = "utf-8"

            if r.status_code == 404:
                print(f"[FETCH] 404: {url} — группа или адрес устарели")
                return None

            r.raise_for_status()

            if len(r.text) < 2000:
                print("[FETCH] HTML подозрительно короткий — возможно, пустая страница")

            return r.text

        except Exception as e:
            last_error = e
            if attempt == 0:
                time.sleep(1)

    print(f"[FETCH ERROR] {url}: {last_error}")
    return None


def find_group_id(name):
    """Ищет актуальный ID группы по названию на странице /schedule."""
    global _cached_group, _cached_group_time

    if _cached_group and (time.time() - _cached_group_time < CACHE_TTL * 12):
        return _cached_group

    page = fetch_html(f"{BASE}/schedule")
    if not page:
        return None

    pairs = re.findall(
        r'href="' + re.escape(BASE) + r'/schedule/(\d+)/classes"[^>]*>\s*'
        r'<span[^>]*>([^<]+)</span>',
        page,
    )

    # В списке групп имя идёт как "4об_ППРСД", а на странице группы —
    # "4об_ППРСД/23". Сравниваем без суффикса года.
    def base(value):
        return value.strip().lower().split("/")[0]

    target = base(name)
    exact = None
    partial = []

    for group_id, raw_name in pairs:
        group_name = html_lib.unescape(raw_name).strip()
        low = base(group_name)

        if low == target:
            exact = group_id
            break
        if target and target in low:
            partial.append(group_id)

    result = exact or (partial[0] if partial else None)

    if result:
        _cached_group = result
        _cached_group_time = time.time()
        print(f"[GROUP] '{name}' → ID {result}")
    else:
        print(f"[GROUP] группа '{name}' не найдена, беру GROUP_ID={GROUP_ID}")

    return result


def group_url():
    """Актуальный адрес страницы «По датам» для нужной группы."""
    global _resolved_group_id

    group_id = GROUP_ID

    if GROUP_NAME:
        found = find_group_id(GROUP_NAME)
        if found:
            group_id = found

    _resolved_group_id = group_id

    return f"{BASE}/schedule/{group_id}/by-dates"


def group_info():
    """
    Сведения о группе: название, институт, направление.

    Нужны для шапки мини-приложения. Данные берутся из того же снимка,
    что и расписание, поэтому заполняются после первого разбора.
    """
    info = dict(_cached_group_info)
    info.setdefault("id", _resolved_group_id or GROUP_ID)
    info.setdefault("name", "")
    info.setdefault("institute", "")
    info.setdefault("program", "")
    return info


# =========================
# РАЗБОР JSON ИЗ LIVEWIRE
# =========================
def _walk(obj):
    """Рекурсивно обходит вложенные dict/list."""
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from _walk(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _walk(value)


def _extract_snapshot(page):
    """Достаёт JSON из атрибута wire:snapshot."""
    match = re.search(r'wire:snapshot="([^"]*)"', page)
    if not match:
        return None

    try:
        return json.loads(html_lib.unescape(match.group(1)))
    except Exception as e:
        print("[SNAPSHOT] не удалось разобрать JSON:", e)
        return None


def _norm_room(room):
    if not room:
        return "—"
    return re.sub(r"\s+", " ", str(room)).strip() or "—"


def time_key(time_str):
    """
    Ключ сортировки пар по времени начала.

    Сортировать строки нельзя: '9:40' оказалось бы после '15:10'.
    """
    match = re.match(r"\s*(\d{1,2}):(\d{2})", str(time_str))
    if not match:
        return (99, 99)
    return (int(match.group(1)), int(match.group(2)))


def _norm_teacher(row):
    fio = (row.get("FIO") or "").strip()
    duty = (row.get("DUTY_NAME") or row.get("ZV_NAME") or "").strip()

    if not fio:
        return "—"
    return f"{duty} {fio}".strip() if duty else fio


def _norm_type(raw):
    if not raw:
        return "занятие"
    return LESSON_TYPES.get(str(raw).strip().lower(), str(raw).strip())


def _remember_group(slot):
    """Запоминает сведения о группе из первого же слота расписания."""
    global _cached_group_info

    if _cached_group_info:
        return

    name = (slot.get("NAMEGROUP") or "").strip()
    if not name:
        return

    _cached_group_info = {
        "name": name,
        "institute": (slot.get("NAME_ROD") or "").strip(),
        "program": (slot.get("PNAME") or slot.get("SNAME") or "").strip(),
    }


def parse_from_snapshot(page):
    """
    Собирает расписание из Livewire-снимка.

    Структура: «слот» хранит дату и время (SCHEDULE_DATE, TIME_START,
    TIME_END), а сами предметы лежат глубже — во вложенном ROWS.
    """
    snapshot = _extract_snapshot(page)
    if not snapshot:
        return {}

    slots = [
        d for d in _walk(snapshot)
        if "SCHEDULE_DATE" in d and "TIME_START" in d
    ]
    if not slots:
        return {}

    schedule = {}
    seen = set()

    for slot in slots:
        _remember_group(slot)

        date_iso = str(slot.get("SCHEDULE_DATE") or "").strip()
        if not date_iso:
            continue

        time_from = str(slot.get("TIME_START") or "").strip()
        time_to = str(slot.get("TIME_END") or "").strip()
        time_str = f"{time_from}–{time_to}" if time_to else time_from

        # Предметы внутри слота; если их нет — возможно, слот самодостаточен
        rows = [
            d for d in _walk(slot.get("ROWS") or [])
            if "NAMEDISC" in d and str(d.get("NAMEDISC") or "").strip()
        ]
        if not rows and str(slot.get("NAMEDISC") or "").strip():
            rows = [slot]

        for row in rows:
            subject = re.sub(r"\s+", " ", str(row.get("NAMEDISC"))).strip()
            teacher = _norm_teacher(row)
            room = _norm_room(row.get("ROOM_NAME"))

            key = (date_iso, time_str, subject, teacher, room)
            if key in seen:
                continue
            seen.add(key)

            subgroup = row.get("SUBGROUP") or 0
            try:
                subgroup = int(subgroup)
            except (TypeError, ValueError):
                subgroup = 0

            moodle = (row.get("E_COURSE_URL") or "").strip() or None
            note = (row.get("NOTE") or "").strip().replace("—", "–") or None

            schedule.setdefault(date_iso, []).append({
                "time": time_str,
                "subject": subject,
                "type": _norm_type(row.get("LECTYPE")),
                "teacher": teacher,
                "room": room,
                "note": note,
                "subgroup": subgroup,
                "moodle": moodle,
            })

    for lessons in schedule.values():
        lessons.sort(key=lambda l: time_key(l["time"]))

    return schedule


# =========================
# РЕЗЕРВНЫЙ РАЗБОР HTML
# =========================
def parse_from_html(page):
    """
    Запасной вариант: разбор текста страницы.
    Нужен, только если Livewire-снимок пропал.
    """
    soup = BeautifulSoup(page, "html.parser")
    text = soup.get_text("\n", strip=True)

    # День и месяц могут быть однозначными: 6.10.2026
    date_pattern = r"\d{1,2}\.\d{1,2}\.\d{4}"
    time_pattern = r"\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}"

    parts = re.split(f"({date_pattern})", text)

    schedule = {}
    current = None

    for part in parts:
        part = part.strip()
        if not part:
            continue

        if re.fullmatch(date_pattern, part):
            day, month, year = part.split(".")
            current = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
            schedule.setdefault(current, [])
            continue

        if not current:
            continue

        chunks = re.split(f"({time_pattern})", part)

        for i in range(1, len(chunks), 2):
            try:
                time_str = chunks[i].replace(" ", "").replace("-", "–")
                block = chunks[i + 1]

                lines = [x.strip() for x in block.split("\n") if x.strip()]
                if not lines:
                    continue

                lesson_type = "занятие"
                teacher = "—"
                room = "—"

                for line in lines:
                    low = line.lower()
                    if "лекц" in low:
                        lesson_type = "лекция"
                    elif "практ" in low:
                        lesson_type = "практика"
                    elif "лаб" in low:
                        lesson_type = "лабораторная"
                    elif "ауд" in low or "корпус" in low:
                        room = line
                    elif any(x in low for x in ["доц", "проф", "преп", "зав"]):
                        teacher = line

                schedule[current].append({
                    "time": time_str,
                    "subject": lines[0],
                    "type": lesson_type,
                    "teacher": teacher,
                    "room": room,
                    "note": None,
                    "subgroup": 0,
                    "moodle": None,
                })

            except Exception as e:
                print("[PARSE ERROR]", e)

    for lessons in schedule.values():
        lessons.sort(key=lambda l: time_key(l["time"]))

    return schedule


# =========================
# ОСНОВНАЯ ФУНКЦИЯ
# =========================
def refresh_in_background():
    """
    Обновляет расписание в отдельном потоке.

    Разбор страницы вуза занимает несколько секунд чистого процессора,
    и всё это время запрос держит поток — а потоков мало, и приложение
    при открытии шлёт сразу несколько запросов. Потоки кончались,
    проверка живости Render не укладывалась в свои 5 секунд, и сервис
    перезапускался, теряя запросы в полёте. Поэтому ждать сайт в самом
    запросе нельзя: отдаём что есть, а обновление идёт фоном.
    """
    global _refreshing

    with _refresh_lock:
        if _refreshing:
            return
        _refreshing = True

    def work():
        global _refreshing
        try:
            parse_schedule(force=True)
        except Exception as e:
            print("[PARSE] фоновое обновление не удалось:", e)
        finally:
            _refreshing = False

    threading.Thread(target=work, daemon=True, name="schedule-refresh").start()


def parse_schedule(force=False, wait=True):
    """
    Возвращает расписание: {"2026-10-06": [пары...], ...}
    Ключ — ISO-дата, внутри список пар, отсортированный по времени.

    wait=False — не ждать похода на сайт: отдать то, что уже есть,
    а обновление запустить в фоне. Так работают все запросы
    приложения; ждать имеет смысл только при прогреве кэша.
    """
    global _cached_schedule, _cached_time

    if not force and _cached_schedule and (time.time() - _cached_time < CACHE_TTL):
        return _cached_schedule

    if not wait:
        refresh_in_background()
        return _cached_schedule or {}

    page = fetch_html(group_url())
    if not page:
        return _cached_schedule or {}

    schedule = parse_from_snapshot(page)

    if not schedule:
        print("[PARSE] JSON недоступен — перехожу на разбор HTML")
        schedule = parse_from_html(page)

    if not schedule:
        return _cached_schedule or {}

    _cached_schedule = schedule
    _cached_time = time.time()

    return schedule


# =========================
# ФОРМАТИРОВАНИЕ
# =========================
def format_date(iso):
    """'2026-10-06' → '06.10.2026, вторник'."""
    try:
        d = date.fromisoformat(iso)
    except ValueError:
        return iso
    return f"{d.strftime('%d.%m.%Y')}, {WEEKDAYS[d.weekday()]}"


def human_date(iso):
    """'2026-10-06' → '6 октября, вторник' — для мини-приложения."""
    try:
        d = date.fromisoformat(iso)
    except ValueError:
        return iso
    return f"{d.day} {MONTHS_GENITIVE[d.month - 1]}, {WEEKDAYS[d.weekday()]}"


def format_schedule(schedule, compact=False):
    """Собирает текст сообщения из расписания."""
    if not schedule:
        return "📚 Расписание временно недоступно"

    result = "📚 Расписание"

    for iso in sorted(schedule.keys()):
        lessons = schedule[iso]

        result += f"\n\n📅 {format_date(iso)}\n"

        if not lessons:
            result += "   😎 Нет пар\n"
            continue

        for lesson in lessons:
            subject = lesson["subject"]
            teacher = lesson.get("teacher", "—")
            room = lesson.get("room", "—")
            subgroup = lesson.get("subgroup") or 0

            if compact:
                line = f"\n• {lesson['time']} — {subject}"
                if teacher != "—":
                    line += f" • {teacher}"
                if room != "—":
                    line += f" • {room}"
                result += line
            else:
                head = f"\n┌─ 📖 {lesson['time']}"
                if subgroup:
                    head += f" (подгруппа {subgroup})"
                result += head + "\n"
                result += f"│ {subject}\n"
                result += f"│ 🏷 {lesson['type']}\n"
                result += f"│ 👤 {teacher}\n"
                result += f"│ 🏫 {room}\n"

                if lesson.get("note"):
                    result += f"│ 🗓 {lesson['note']}\n"
                if lesson.get("moodle"):
                    result += f"│ 🔗 {lesson['moodle']}\n"

                result += "└──────────────\n"

    return result


# =========================
# ВЫБОРКИ ПО ДАТАМ
# =========================
def _today_iso():
    return now_msk().date().isoformat()


def get_today():
    """Пары на сегодня (по московскому времени)."""
    today = _today_iso()
    schedule = parse_schedule(wait=False)
    return {today: schedule[today]} if today in schedule else {}


def get_tomorrow():
    """Пары на завтра (по московскому времени)."""
    tomorrow = (now_msk().date() + timedelta(days=1)).isoformat()
    schedule = parse_schedule(wait=False)
    return {tomorrow: schedule[tomorrow]} if tomorrow in schedule else {}


def get_week():
    """Пары на ближайшие 7 дней, начиная с сегодня."""
    schedule = parse_schedule(wait=False)
    today = now_msk().date()

    week = {}
    for offset in range(7):
        iso = (today + timedelta(days=offset)).isoformat()
        if iso in schedule:
            week[iso] = schedule[iso]

    return week


def get_upcoming():
    """Всё, что ещё будет, без прошедших дат."""
    schedule = parse_schedule(wait=False)
    today = _today_iso()
    return {iso: lessons for iso, lessons in schedule.items() if iso >= today}


# =========================
# СОСТОЯНИЕ КЭША
# =========================
# Фоновое обновление: один поток на всех, повторные запуски не нужны
_refreshing = False
_refresh_lock = threading.Lock()


def cached_schedule():
    """
    Возвращает расписание из кэша, НЕ обращаясь к сайту.

    Нужно для проверки живости сервиса. Если health-check будет ходить
    на сайт учебного заведения, то при недоступности сайта Render сочтёт
    сервис сломанным и начнёт его перезапускать.
    """
    return _cached_schedule or {}


def cache_age():
    """Сколько секунд назад расписание обновлялось. None — кэша ещё нет."""
    if not _cached_time:
        return None
    return int(time.time() - _cached_time)
