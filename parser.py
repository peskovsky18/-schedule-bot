import requests
from bs4 import BeautifulSoup
from datetime import datetime, timedelta

URL = "https://guide.herzen.spb.ru/schedule/23316/by-dates"

def fetch_html():
    headers = {
        "User-Agent": "Mozilla/5.0 Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    }

    try:
        r = requests.get(URL, headers=headers, timeout=10)
        r.encoding = "utf-8"
        return r.text
    except Exception as e:
        print("ERROR:", e)
        return ""

    soup = BeautifulSoup(html, "lxml")

    schedule = {}
    current_date = None

    # 📌 берем весь контент, но не как текст, а как элементы
    elements = soup.find_all(True)

    for el in elements:
        text = el.get_text(" ", strip=True)

        if not text:
            continue

        # 📅 дата (обычно короткая строка с точками)
        if is_date(text):
            current_date = text
            schedule[current_date] = []
            continue

        # ⏰ пара (ищем время)
        if is_lesson_block(text):
            lesson = extract_lesson(text)

            if lesson and current_date:
                schedule[current_date].append(lesson)

    return schedule
def is_date(text: str) -> bool:
    return (
        len(text) < 25
        and "." in text
        and any(char.isdigit() for char in text)
    )


def is_lesson_block(text: str) -> bool:
    return ":" in text and "-" in text
def extract_lesson(text: str):
    parts = text.split()

    time = None
    subject_parts = []

    room = "—"
    teacher = "—"

    for p in parts:
        if "-" in p and ":" in p:
            time = p
        else:
            subject_parts.append(p)

    subject = " ".join(subject_parts).strip()

    # 📌 эвристики под твой вуз
    if "ауд" in text.lower():
        room = extract_after_keyword(text, "ауд")

    if "преп" in text.lower() or "доцент" in text.lower():
        teacher = extract_teacher(text)

    return {
        "time": time or "—",
        "subject": subject or "—",
        "room": room,
        "teacher": teacher
    }
def extract_after_keyword(text, keyword):
    try:
        idx = text.lower().index(keyword)
        return text[idx:idx+20]
    except:
        return "—"


def extract_teacher(text):
    words = text.split()
    for i, w in enumerate(words):
        if "преп" in w.lower() or "доцент" in w.lower():
            return " ".join(words[i:i+3])
    return "—"
def format_schedule(schedule):
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

    return resultdef get_today():
    schedule = parse_schedule()
    today = datetime.now().strftime("%d.%m.%Y")

    for date in schedule:
        if today in date:
            return format_schedule({date: schedule[date]})

    return "Сегодня пар нет 😎"


def get_tomorrow():
    schedule = parse_schedule()
    tomorrow = (datetime.now() + timedelta(days=1)).strftime("%d.%m.%Y")

    for date in schedule:
        if tomorrow in date:
            return format_schedule({date: schedule[date]})

    return "Завтра пар нет 😎"


def get_week():
    return format_schedule(parse_schedule())
