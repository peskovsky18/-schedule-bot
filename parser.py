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
CACHE_TTL = 300


# =========================
# FETCH
# =========================
def fetch_html():
    try:
        headers = {
            "User-Agent": "Mozilla/5.0"
        }

        r = requests.get(URL, headers=headers, timeout=10)
        r.encoding = "utf-8"

        if len(r.text) < 2000:
            print("[FETCH] HTML too small → possible empty page")

        return r.text

    except Exception as e:
        print("[FETCH ERROR]", e)
        return None


# =========================
# PARSER
# =========================
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

        # DATE
        if re.fullmatch(date_pattern, part):
            current_date = part
            schedule[current_date] = []
            continue

        if not current_date:
            continue

        matches = re.split(f"({time_pattern})", part)

        for i in range(1, len(matches), 2):
            try:
                time_raw = matches[i]
                block = matches[i + 1]

                time_str = time_raw.replace(" ", "").replace("-", "–")

                lines = [x.strip() for x in block.split("\n") if x.strip()]
                if not lines:
                    continue

                subject = lines[0]

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
                    elif "ауд" in low or "корпус" in low or "мойка" in low:
                        room = line
                    elif any(x in low for x in ["доц", "проф", "преп", "зав"]):
                        teacher = line

                schedule[current_date].append({
                    "time": time_str,
                    "subject": subject,
                    "type": lesson_type,
                    "teacher": teacher,
                    "room": room
                })

            except Exception as e:
                print("[PARSE ERROR]", e)

    _cached_schedule = schedule
    _cached_time = time.time()

    return schedule


# =========================
# FORMAT (Notion style + compact)
# =========================
def format_schedule(schedule, compact=False):
    if not schedule:
        return "📚 Расписание временно недоступно"

    result = "📚 Расписание\n"

    for date, lessons in schedule.items():

        result += f"\n\n📅 {date}\n"

        if not lessons:
            result += "   😎 Нет пар\n"
            continue

        for l in lessons:

            time = l["time"]
            subject = l["subject"]
            ttype = l["type"]
            teacher = l["teacher"]
            room = l["room"]

            if compact:
                result += f"\n• {time} — {subject}"

                if teacher != "—":
                    result += f" • {teacher}"
                if room != "—":
                    result += f" • {room}"

            else:
                result += (
                    f"\n┌─ 📖 {time}\n"
                    f"│ {subject}\n"
                    f"│ 🏷 {ttype}\n"
                    f"│ 👤 {teacher}\n"
                    f"│ 🏫 {room}\n"
                    f"└──────────────\n"
                )

    return result


# =========================
# HELPERS
# =========================
def get_week():
    return parse_schedule()


def get_today():
    schedule = parse_schedule()
    today = datetime.now().strftime("%d.%m.%Y")

    return {k: v for k, v in schedule.items() if today in k}


def get_tomorrow():
    schedule = parse_schedule()
    tomorrow = (datetime.now() + timedelta(days=1)).strftime("%d.%m.%Y")

    return {k: v for k, v in schedule.items() if tomorrow in k}
