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
# SAFE REQUEST
# =========================
def fetch_html():

    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml"
    }

    for attempt in range(3):

        try:
            r = requests.get(URL, headers=headers, timeout=15)

            if r.status_code == 200 and len(r.text) > 1000:
                r.encoding = "utf-8"
                return r.text

            print(f"[fetch_html] bad status {r.status_code}")

        except Exception as e:
            print("[fetch_html] error:", e)

        time.sleep(2)

    return None

# =========================
# MAIN PARSER
# =========================
def parse_schedule():

    global _cached_schedule
    global _cached_time

    # cache
    if _cached_schedule and (time.time() - _cached_time < CACHE_TTL):
        return _cached_schedule

    html = fetch_html()

    if not html:
        return _cached_schedule or {}

    try:

        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text("\n", strip=True)

        date_pattern = r"\d{2}\.\d{2}\.\d{4}"

        parts = re.split(f"({date_pattern})", text)

        schedule = {}
        current_date = None

        for part in parts:

            part = part.strip()

            if not part:
                continue

            # DATE
            if re.fullmatch(date_pattern, part):
                current_date = part
                schedule[current_date] = []
                continue

            # LESSONS
            if current_date:
                lessons = parse_lessons(part)

                if lessons:
                    schedule[current_date].extend(lessons)

        _cached_schedule = schedule
        _cached_time = time.time()

        return schedule

    except Exception as e:
        print("[parse_schedule] error:", e)
        return _cached_schedule or {}

# =========================
# PARSE LESSONS
# =========================
def parse_lessons(text):

    lessons = []

    blocks = re.split(r"\n{2,}|•|—{2,}", text)

    for block in blocks:

        block = block.strip()

        if len(block) < 10:
            continue

        # ================= TIME =================
        time_match = re.search(
            r"\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}",
            block
        )

        lesson_time = (
            time_match.group(0).replace("-", "–")
            if time_match else "—"
        )

        # ================= CLEAN =================
        clean = re.sub(
            r"\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}",
            "",
            block
        )

        clean = re.sub(r"\s+", " ", clean).strip()

        # ================= ROOM =================
        room_match = re.search(
            r"ауд\.?\s*[^,\n]+(?:\(.*?\))?",
            clean,
            re.I
        )

        room = room_match.group(0).strip() if room_match else "—"

        # ================= TEACHER =================
        teacher_match = re.search(
            r"(доцент|преподаватель|профессор|зав\.?\s*каф\.?)\s+[А-Яа-яЁёA-Za-z\s]+",
            clean
        )

        teacher = (
            teacher_match.group(0).strip()
            if teacher_match else "—"
        )

        # ================= TYPE =================
        lower = clean.lower()

        if "лек" in lower:
            lesson_type = "лекция"

        elif "практ" in lower:
            lesson_type = "практика"

        elif "лаб" in lower:
            lesson_type = "лабораторная"

        else:
            lesson_type = "занятие"

        # ================= SUBJECT =================
        subject = clean

        # remove room
        subject = re.sub(
            r"ауд\.?\s*[^,\n]+(?:\(.*?\))?",
            "",
            subject,
            flags=re.I
        )

        # remove teacher
        subject = re.sub(
            r"(доцент|преподаватель|профессор|зав\.?\s*каф\.?)\s+[А-Яа-яЁёA-Za-z\s]+",
            "",
            subject,
            flags=re.I
        )

        # remove lesson type
        subject = re.sub(
            r"\b(лекция|лек|практика|практ|лаб)\b",
            "",
            subject,
            flags=re.I
        )

        subject = re.sub(r"\s+", " ", subject).strip(" ,.-")

        # skip garbage
        if len(subject) < 3:
            continue

        lessons.append({
            "time": lesson_time,
            "subject": subject,
            "type": lesson_type,
            "teacher": teacher,
            "room": room
        })

    return lessons

# =========================
# FORMAT
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
                f"\n📖 {l.get('time', '—')}\n"
                f"    {l.get('subject', '—')}\n"
                f"    {l.get('type', '—')}\n"
                f"    👤 {l.get('teacher', '—')}\n"
                f"    🏫 {l.get('room', '—')}\n"
            )

    return result.strip()

# =========================
# HELPERS
# =========================
def get_today():

    schedule = parse_schedule()

    today = datetime.now().strftime("%d.%m.%Y")

    lessons = schedule.get(today)

    if not lessons:
        return "Сегодня пар нет 😎"

    return format_schedule({today: lessons})

def get_tomorrow():

    schedule = parse_schedule()

    tomorrow = (
        datetime.now() + timedelta(days=1)
    ).strftime("%d.%m.%Y")

    lessons = schedule.get(tomorrow)

    if not lessons:
        return "Завтра пар нет 😎"

    return format_schedule({tomorrow: lessons})

def get_week():
    return format_schedule(parse_schedule())
