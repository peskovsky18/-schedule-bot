import requests
import re
import time
from bs4 import BeautifulSoup
from datetime import datetime

URL = "https://old-guide.herzen.spb.ru/static/schedule_dates.php?id_group=23316"

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
        r = requests.get(URL, timeout=10)
        r.encoding = "utf-8"
        return r.text
    except Exception as e:
        print("[FETCH ERROR]", e)
        return None


# =========================
# MAIN PARSER
# =========================
def parse_schedule():
    global _cached_schedule, _cached_time

    # cache
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

        # LESSON BLOCKS
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
                    elif "ауд" in low or "корпус" in low:
                        room = line
                    elif any(x in low for x in ["доц", "проф", "преп", "зав"]):
                        teacher = line

                # очистка мусора
                subject = re.sub(r"\s{2,}", " ", subject)
                teacher = re.sub(r"\s{2,}", " ", teacher)
                room = re.sub(r"\s{2,}", " ", room)

                schedule[current_date].append({
                    "time": time_str,
                    "subject": subject,
                    "type": lesson_type,
                    "teacher": teacher,
                    "room": room
                })

            except Exception as e:
                print("[LESSON ERROR]", e)

    _cached_schedule = schedule
    _cached_time = time.time()

    return schedule


# =========================
# FORMAT (КРАСИВЫЙ ВЫВОД)
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
                f"──────────────────\n"
            )

    return result


# =========================
# HELPERS
# =========================
def get_week():
    return format_schedule(parse_schedule())


def get_today():
    schedule = parse_schedule()
    today = datetime.now().strftime("%d.%m.%Y")

    for d in schedule:
        if today in d:
            return format_schedule({d: schedule[d]})

    return "Сегодня пар нет 😎"


def get_tomorrow():
    schedule = parse_schedule()
    tomorrow = (datetime.now()).strftime("%d.%m.%Y")

    keys = list(schedule.keys())

    if len(keys) > 1:
        return format_schedule({keys[1]: schedule[keys[1]]})

    return "Завтра пар нет 😎"
