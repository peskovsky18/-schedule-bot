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
# SAFE REQUEST (с retry)
# =========================
def fetch_html():
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
        "Accept": "text/html,application/xhtml+xml"
    }

    for attempt in range(3):
        try:
            r = requests.get(URL, headers=headers, timeout=10)

            if r.status_code == 200 and len(r.text) > 1000:
                r.encoding = "utf-8"
                return r.text

            print(f"[fetch_html] Bad response: {r.status_code}, attempt {attempt+1}")

        except Exception as e:
            print(f"[fetch_html] Error attempt {attempt+1}: {e}")

        time.sleep(2)

    return None


# =========================
# PARSE SCHEDULE
# =========================
def parse_schedule():
    global _cached_schedule, _cached_time

    # 🔥 cache check
    if _cached_schedule and (time.time() - _cached_time < CACHE_TTL):
        return _cached_schedule

    html = fetch_html()

    # 🔴 если сайт упал — возвращаем кеш или пусто
    if not html:
        print("[parse_schedule] No HTML received")
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

            if re.fullmatch(date_pattern, part):
                current_date = part
                schedule[current_date] = []
                continue

            if current_date:
                lessons = parse_lessons(part)
                if lessons:
                    schedule[current_date].extend(lessons)

        # update cache
        _cached_schedule = schedule
        _cached_time = time.time()

        return schedule

    except Exception as e:
        print("[parse_schedule] Parse error:", e)
        return _cached_schedule or {}


# =========================
# PARSE LESSONS
# =========================
def parse_lessons(text):
    lessons = []

    blocks = re.split(r"\n{2,}|•|—{2,}", text)

    for b in blocks:
        b = b.strip()
        if len(b) < 10:
            continue

        time_match = re.search(r"\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}", b)
        time_str = time_match.group(0) if time_match else "—"

        subject = clean_subject(b)
        room = extract_room(b)
        teacher = extract_teacher(b)

        lessons.append({
            "time": time_str,
            "subject": subject,
            "room": room,
            "teacher": teacher
        })

    return lessons


# =========================
# CLEANERS
# =========================
def clean_subject(text):
    text = re.sub(r"\d{1,2}:\d{2}.*?-\s*\d{1,2}:\d{2}", "", text)
    text = re.sub(r"ауд\.?|преп\.?|доцент", "", text, flags=re.I)
    return text.strip() or "—"


def extract_room(text):
    m = re.search(r"ауд\.?\s*\S+", text, re.I)
    return m.group(0) if m else "—"


def extract_teacher(text):
    m = re.search(r"(доцент|преподаватель)\s+[A-Яа-яA-Za-z\s]+", text)
    return m.group(0) if m else "—"


# =========================
# FORMAT OUTPUT
# =========================
def format_schedule(schedule):
    if not schedule:
        return "📚 Расписание временно недоступно"

    result = "📚 Расписание\n"

    for date, lessons in schedule.items():
        result += f"\n📅 {date}\n\n"

        for l in lessons:
            result += (
                f"⏰ {l['time']}\n"
                f"📖 {l['subject']}\n"
                f"🏫 {l['room']}\n"
                f"👨‍🏫 {l['teacher']}\n"
                f"-----------------\n"
            )

    return result


# =========================
# API HELPERS
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
    tomorrow = (datetime.now() + timedelta(days=1)).strftime("%d.%m.%Y")

    lessons = schedule.get(tomorrow)
    if not lessons:
        return "Завтра пар нет 😎"

    return format_schedule({tomorrow: lessons})


def get_week():
    return format_schedule(parse_schedule())
