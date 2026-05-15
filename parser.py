import requests
import re
import time

from bs4 import BeautifulSoup
from datetime import datetime, timedelta

URL = "https://guide.herzen.spb.ru/schedule/23316/by-dates"

# =========================
# CACHE
# =========================
_cached_schedule = None
_cached_time = 0
CACHE_TTL = 300  # 5 минут


# =========================
# FETCH HTML
# =========================
def fetch_html():

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
        "Accept": "text/html,application/xhtml+xml"
    }

    for attempt in range(3):

        try:

            r = requests.get(
                URL,
                headers=headers,
                timeout=15
            )

            if r.status_code == 200 and len(r.text) > 1000:
                r.encoding = "utf-8"
                return r.text

            print(f"[FETCH] BAD STATUS: {r.status_code}")

        except Exception as e:
            print(f"[FETCH ERROR] {e}")

        time.sleep(2)

    return None


# =========================
# PARSE SCHEDULE
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

        # 🔥 весь текст страницы
        text = soup.get_text("\n", strip=True)

        # даты
        date_pattern = r"\d{2}\.\d{2}\.\d{4}"

        parts = re.split(f"({date_pattern})", text)

        schedule = {}
        current_date = None

        for part in parts:

            part = part.strip()

            if not part:
                continue

            # =========================
            # DATE
            # =========================
            if re.fullmatch(date_pattern, part):

                current_date = part
                schedule[current_date] = []

                continue

            # =========================
            # LESSONS
            # =========================
            if current_date:

                lessons = parse_lessons(part)

                if lessons:
                    schedule[current_date].extend(lessons)

        # cache update
        _cached_schedule = schedule
        _cached_time = time.time()

        return schedule

    except Exception as e:

        print("[PARSE ERROR]", e)

        return _cached_schedule or {}


# =========================
# PARSE LESSONS
# =========================
def parse_lessons(text):

    lessons = []

    # разбиваем по времени пары
    pattern = r"(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})"

    parts = re.split(pattern, text)

    if len(parts) < 2:
        return lessons

    for i in range(1, len(parts), 2):

        try:

            lesson_time = (
                parts[i]
                .replace("-", "–")
                .replace(" ", "")
                .strip()
            )

            block = parts[i + 1].strip()

            # строки блока
            lines = [
                x.strip()
                for x in block.split("\n")
                if x.strip()
            ]

            if not lines:
                continue

            # =========================
            # SUBJECT
            # =========================
            subject = lines[0]

            # =========================
            # TYPE
            # =========================
            lesson_type = "занятие"

            for line in lines:

                lower = line.lower()

                if "лекц" in lower:
                    lesson_type = "лекция"

                elif "практ" in lower:
                    lesson_type = "практика"

                elif "лаб" in lower:
                    lesson_type = "лабораторная"

                elif "экзам" in lower:
                    lesson_type = "экзамен"

                elif "зач" in lower:
                    lesson_type = "зачёт"

            # =========================
            # TEACHER
            # =========================
            teacher = "—"

            for line in lines:

                lower = line.lower()

                if any(word in lower for word in [
                    "доц",
                    "проф",
                    "асс",
                    "преп",
                    "зав. каф",
                    "ст. преп"
                ]):

                    teacher = line
                    break

            # =========================
            # ROOM
            # =========================
            room = "—"

            for line in lines:

                lower = line.lower()

                if (
                    "ауд." in lower
                    or "корпус" in lower
                    or "мойка" in lower
                ):
                    room = line
                    break

            lessons.append({
                "time": lesson_time,
                "subject": subject,
                "type": lesson_type,
                "teacher": teacher,
                "room": room
            })

        except Exception as e:
            print("[LESSON ERROR]", e)

    return lessons


# =========================
# FORMAT OUTPUT
# =========================
def format_schedule(schedule):

    if not schedule:
        return "📚 Расписание временно недоступно"

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
# API HELPERS
# =========================
def get_today():

    schedule = parse_schedule()

    today = datetime.now().strftime("%d.%m.%Y")

    for date in schedule:

        if today in date:
            return format_schedule({
                date: schedule[date]
            })

    return "Сегодня пар нет 😎"


def get_tomorrow():

    schedule = parse_schedule()

    tomorrow = (
        datetime.now() + timedelta(days=1)
    ).strftime("%d.%m.%Y")

    for date in schedule:

        if tomorrow in date:
            return format_schedule({
                date: schedule[date]
            })

    return "Завтра пар нет 😎"


def get_week():
    return format_schedule(parse_schedule())
