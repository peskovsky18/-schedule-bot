import os
import json
import time
import telebot

from telebot import types
from datetime import datetime, timedelta

from parser import parse_schedule, format_schedule


# =========================
# 🔐 CONFIG
# =========================
TOKEN = os.getenv("TOKEN")

if not TOKEN:
    raise Exception("TOKEN is not set")

ADMIN_ID = 439819918
USERS_FILE = "users.json"

bot = telebot.TeleBot(TOKEN)

ERROR_LOGS = []


# =========================
# 👥 USERS
# =========================
def load_users():
    try:
        with open(USERS_FILE, "r") as f:
            return json.load(f)
    except:
        return []


def save_user(user_id):
    users = load_users()

    if user_id not in users:
        users.append(user_id)

        with open(USERS_FILE, "w") as f:
            json.dump(users, f)


# =========================
# 📌 KEYBOARD
# =========================
def main_menu():
    markup = types.ReplyKeyboardMarkup(
        resize_keyboard=True,
        one_time_keyboard=False
    )

    markup.row("📅 Сегодня", "⏭ Завтра")
    markup.row("📆 Неделя")

    return markup


# =========================
# 🛡 SAFE SEND
# =========================
def send_safe(chat_id, text):
    MAX = 3800

    if len(text) <= MAX:
        bot.send_message(chat_id, text, reply_markup=main_menu())
        return

    parts = [text[i:i + MAX] for i in range(0, len(text), MAX)]

    for part in parts:
        bot.send_message(chat_id, part, reply_markup=main_menu())


# =========================
# 🚀 START
# =========================
@bot.message_handler(commands=["start"])
def start(message):
    save_user(message.chat.id)

    bot.send_message(
        message.chat.id,
        "📚 Бот запущен",
        reply_markup=main_menu()
    )


# =========================
# 📚 BUTTONS
# =========================
@bot.message_handler(func=lambda message: True)
def handle(message):

    text = message.text
    chat_id = message.chat.id

    try:
        schedule = parse_schedule()

        if text == "📅 Сегодня":

            today = datetime.now().strftime("%d.%m.%Y")

            lessons = schedule.get(today)

            if not lessons:
                return send_safe(chat_id, "Сегодня пар нет 😎")

            return send_safe(
                chat_id,
                format_schedule({today: lessons})
            )

        elif text == "⏭ Завтра":

            tomorrow = (
                datetime.now() + timedelta(days=1)
            ).strftime("%d.%m.%Y")

            lessons = schedule.get(tomorrow)

            if not lessons:
                return send_safe(chat_id, "Завтра пар нет 😎")

            return send_safe(
                chat_id,
                format_schedule({tomorrow: lessons})
            )

        elif text == "📆 Неделя":

            for date, lessons in schedule.items():
                send_safe(
                    chat_id,
                    format_schedule({date: lessons})
                )

            return

    except Exception as e:
        ERROR_LOGS.append(str(e))
        send_safe(chat_id, f"Ошибка: {e}")


# =========================
# 👑 ADMIN PANEL
# =========================
@bot.message_handler(commands=["admin"])
def admin_panel(message):

    if message.chat.id != ADMIN_ID:
        return

    text = (
        "👑 АДМИН-ПАНЕЛЬ\n\n"
        "/stats - статистика\n"
        "/users - пользователи\n"
        "/broadcast текст - рассылка\n"
        "/ping - проверка\n"
        "/logs - ошибки"
    )

    bot.send_message(message.chat.id, text)


# =========================
# 📊 STATS
# =========================
@bot.message_handler(commands=["stats"])
def stats(message):

    if message.chat.id != ADMIN_ID:
        return

    users = load_users()

    bot.send_message(
        message.chat.id,
        f"👥 Пользователей: {len(users)}"
    )


# =========================
# 👥 USERS
# =========================
@bot.message_handler(commands=["users"])
def users_cmd(message):

    if message.chat.id != ADMIN_ID:
        return

    users = load_users()

    bot.send_message(
        message.chat.id,
        f"👥 Всего пользователей: {len(users)}"
    )


# =========================
# 📢 BROADCAST
# =========================
@bot.message_handler(commands=["broadcast"])
def broadcast(message):

    if message.chat.id != ADMIN_ID:
        return

    text = message.text.replace("/broadcast", "").strip()

    if not text:
        return bot.send_message(
            message.chat.id,
            "Использование:\n/broadcast текст"
        )

    users = load_users()

    success = 0
    failed = 0

    for user_id in users:

        try:
            bot.send_message(
                user_id,
                f"📢 {text}",
                reply_markup=main_menu()
            )

            success += 1
            time.sleep(0.05)

        except Exception as e:
            failed += 1
            ERROR_LOGS.append(str(e))

    bot.send_message(
        message.chat.id,
        f"✅ Отправлено: {success}\n❌ Ошибок: {failed}"
    )


# =========================
# 🟢 PING
# =========================
@bot.message_handler(commands=["ping"])
def ping(message):

    if message.chat.id != ADMIN_ID:
        return

    bot.send_message(
        message.chat.id,
        "🟢 Бот работает"
    )


# =========================
# 📄 LOGS
# =========================
@bot.message_handler(commands=["logs"])
def logs(message):

    if message.chat.id != ADMIN_ID:
        return

    if not ERROR_LOGS:
        return bot.send_message(
            message.chat.id,
            "✅ Ошибок нет"
        )

    text = "\n".join(ERROR_LOGS[-10:])

    send_safe(
        message.chat.id,
        f"📄 Последние ошибки:\n\n{text}"
    )


# =========================
# ▶️ START POLLING
# =========================
print("Bot started...")

while True:
    try:
        bot.infinity_polling(
            timeout=10,
            long_polling_timeout=5,
            skip_pending=True
        )

    except Exception as e:
        print("Polling error:", e)
        time.sleep(5)
