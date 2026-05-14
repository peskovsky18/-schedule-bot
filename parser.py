import requests
from datetime import datetime, timedelta
from bs4 import BeautifulSoup

URL = "https://guide.herzen.spb.ru/schedule/23316/by-dates"


def fetch_page():
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    }

    try:
        r = requests.get(URL, headers=headers, timeout=10)
        r.encoding = "utf-8"
        return r.text
    except Exception as e:
        print("REQUEST ERROR:", e)
        return ""


def parse_schedule():
    html = fetch_page()
    if not html:
        return {}

    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text("\n")

    lines = [x.strip() for x in text.split("\n") if x.strip()]

    schedule = {}
    current_date = None

    for i, line in enumerate(lines):

        if "," in line and "." in line:
            current_date = line
            schedule[current_date] = []
            continue

        if "-" in line and ":" in line:
            try:
                subject = lines[i + 1]
                if current_date:
                    schedule[current_date].append(f"{line} — {subject}")
            except:
                pass

    return schedule


def get_tomorrow():
    schedule = parse_schedule()

    tomorrow = datetime.now() + timedelta(days=1)
    date_str = tomorrow.strftime("%-d.%m.%Y")

    result = []

    for date in schedule:
        if date.startswith(date_str):
            result.append(f"📅 {date}\n")
            result += [f"• {x}" for x in schedule[date]]

    return "\n".join(result) if result else "Завтра пар нет 😎"


def get_week():
    schedule = parse_schedule()
    today = datetime.now()

    result = []

    for i in range(7):
        day = today + timedelta(days=i)
        date_str = day.strftime("%-d.%m.%Y")

        for date in schedule:
            if date.startswith(date_str):
                result.append(f"\n📅 {date}")
                result += [f"• {x}" for x in schedule[date]]

    return "\n".join(result) if result else "На неделе пар нет 😎"