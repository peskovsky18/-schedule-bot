import requests
import re
import time
from bs4 import BeautifulSoup
from datetime import datetime, timedelta

URL = "https://guide.herzen.spb.ru/schedule/23316/by-dates"

_cached_schedule = None
_cached_time = 0
CACHE_TTL = 300


def fetch_html():

    headers = {"User-Agent": "Mozilla/5.0"}

    try:
        r = requests.get(URL, headers=headers, timeout=15)

        if r.status_code == 200:
            r.encoding = "utf-8"
            return r.text

    except Exception as e:
        print("FETCH ERROR:", e)

    return None


def parse_schedule():

    global _cached_schedule, _cached_time

    if _cached_schedule and (time.time() - _cached_time < CACHE_TTL):
        return _cached_schedule

    html = fetch_html()

    if not html:
        return _cached_schedule or {}

    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text("\n", strip=True)

    date_pattern = r"\d{2}\.\d{2}\.\d{4}"
    time_pattern = r"\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}"

    parts = re.split(f"({date_pattern})", text)

    schedule = {}
    current_date = None

    for part in parts:

        part = part.strip()
        if not part:
            continue

        if re.fullmatch(date_pattern, part):
            current_date = part
            schedule[current_date] = []
            continue

        if not current_date:
            continue

        matches = re.split(f"({time_pattern})", part)

        for i in range(1, len(matches), 2):

            try:
                lesson_time = matches[i].replace(" ", "").replace("-", "–")
                block = matches[i + 1]

                lines = [x.strip() for x in block.split("\n") if x.strip()]

                if not lines:
                    continue

                subject = lines[0]
                lesson_type = "занятие"
                teacher = "—"
                room = "—"

                for line in lines:
                    l = line.lower()

                    if "лекц" in l:
                        lesson_type = "лекция"
                    elif "практ" in l:
                        lesson_type = "практика"
                    elif "лаб" in l:
                        lesson_type = "лабораторная"
                    elif "ауд" in l or "корпус" in l:
                        room = line
                    elif any(x in l for x in ["доц", "проф", "преп", "зав"]):
                        teacher = line

                schedule[current_date].append({
                    "time": lesson_time,
                    "subject": subject,
                    "type": lesson_type,
                    "teacher": teacher,
                    "room": room
                })

            except Exception as e:
                print("LESSON ERROR:", e)

    _cached_schedule = schedule
    _cached_time = time.time()

    return schedule


def format_schedule(schedule):

    if not schedule:
        return "📚 Расписание недоступно"

    result = "📚 Расписание\n"

    for date, lessons in schedule.items():

        result += f"\n📅 {date}\n"

        for l in lessons:

            result += (
                f"\n📖 {l['time']}\n"
                f"    {l['subject']}\n"
                f"    {l['type']}\n"
                f"    👤 {l['teacher']}\n"
                f"    🏫 {l['room']}\n"
            )

    return result


def get_today():
    schedule = parse_schedule()
    today = datetime.now().strftime("%d.%m.%Y")

    for d in schedule:
        if today in d:
            return format_schedule({d: schedule[d]})

    return "Сегодня пар нет 😎"


def get_tomorrow():
    schedule = parse_schedule()
    tomorrow = (datetime.now() + timedelta(days=1)).strftime("%d.%m.%Y")

    for d in schedule:
        if tomorrow in d:
            return format_schedule({d: schedule[d]})

    return "Завтра пар нет 😎"


def get_week():
    return format_schedule(parse_schedule())
