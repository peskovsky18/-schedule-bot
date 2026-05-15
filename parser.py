import requests
import time

from bs4 import BeautifulSoup
from datetime import datetime, timedelta

URL = "https://guide.herzen.spb.ru/schedule/23316/by-dates"

# =========================
# CACHE
# =========================
_cached_schedule = None
_cached_time = 0
CACHE_TTL = 300

# =========================
# FETCH HTML
# =========================
def fetch_html():

    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    for _ in range(3):

        try:
            r = requests.get(URL, headers=headers, timeout=15)

            if r.status_code == 200:
                r.encoding = "utf-8"
                return r.text

        except Exception as e:
            print("FETCH ERROR:", e)

        time.sleep(2)

    return None

# =========================
# PARSE
# =========================
def parse_schedule():

    global _cached_schedule
    global _cached_time

    # CACHE
    if _cached_schedule and (time.time() - _cached_time < CACHE_TTL):
        return _cached_schedule

    html = fetch_html()

    if not html:
        return _cached_schedule or {}

    try:

        soup = BeautifulSoup(html, "html.parser")

        schedule = {}

        # все дни
        days = soup.select(".schedule-day")

        for day in days:

            # дата
            date_el = day.select_one(".schedule-day__title")

            if not date_el:
                continue

            date = date_el.get_text(strip=True)

            schedule[date] = []

            # пары
            lessons = day.select(".schedule-lesson")

            for lesson in lessons:

                # время
                time_el = lesson.select_one(".schedule-lesson__time")

                lesson_time = (
                    time_el.get_text(" ", strip=True)
                    if time_el else "—"
                )

                # предмет
                subject_el = lesson.select_one(".schedule-lesson__discipline")

                subject = (
                    subject_el.get_text(" ", strip=True)
                    if subject_el else "—"
                )

                # тип
                type_el = lesson.select_one(".schedule-lesson__type")

                lesson_type = (
                    type_el.get_text(" ", strip=True)
                    if type_el else "занятие"
                )

                # преподаватель
                teacher_el = lesson.select_one(".schedule-lesson__teacher")

                teacher = (
                    teacher_el.get_text(" ", strip=True)
                    if teacher_el else "—"
                )

                # аудитория
                room_el = lesson.select_one(".schedule-lesson__auditory")

                room = (
                    room_el.get_text(" ", strip=True)
                    if room_el else "—"
                )

                schedule[date].append({
                    "time": lesson_time,
                    "subject": subject,
                    "type": lesson_type,
                    "teacher": teacher,
                    "room": room
                })

        _cached_schedule = schedule
        _cached_time = time.time()

        return schedule

    except Exception as e:

        print("PARSE ERROR:", e)

        return _cached_schedule or {}

# =========================
# FORMAT
# =========================
def format_schedule(schedule):

    if not schedule:
        return "📚 Расписание недоступно"

    result = "📚 Расписание\n"

    for date, lessons in schedule.items():

        result += f"\n📅 {date}\n"

        if not lessons:
            result += "\nНет пар 😎\n"
            continue

        for l in lessons:

            result += (
                f"\n📖 {l['time']}\n"
                f"    {l['subject']}\n"
                f"    {l['type']}\n"
                f"    👤 {l['teacher']}\n"
                f"    🏫 {l['room']}\n"
            )

    return result

# =========================
# HELPERS
# =========================
def get_today():

    schedule = parse_schedule()

    today = datetime.now().strftime("%d.%m.%Y")

    for date in schedule:

        if today in date:
            return format_schedule({date: schedule[date]})

    return "Сегодня пар нет 😎"

def get_tomorrow():

    schedule = parse_schedule()

    tomorrow = (
        datetime.now() + timedelta(days=1)
    ).strftime("%d.%m.%Y")

    for date in schedule:

        if tomorrow in date:
            return format_schedule({date: schedule[date]})

    return "Завтра пар нет 😎"

def get_week():
    return format_schedule(parse_schedule())
