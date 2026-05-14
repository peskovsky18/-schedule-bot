import os
import json
import time
import telebot
from flask import Flask, request
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

app = Flask(__name__)


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
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)

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

    for i in range(0, len(text), MAX):
        bot.send_message(chat_id, text[i:i + MAX], reply_markup=main_menu())


# =========================
# 🚀 START
# =========================
@bot.message_handler(commands=["start"])
def start(message):
    save_user(message.chat.id)

    bot.send_message(
        message.chat.id,
        "📚 Бот запущен (webhook mode)",
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

            return send_safe(chat_id, format_schedule({today: lessons}))

        elif text == "⏭ Завтра":
            tomorrow = (datetime.now() + timedelta(days=1)).strftime("%d.%m.%Y")
            lessons = schedule.get(tomorrow)

            if not lessons:
                return send_safe(chat_id, "Завтра пар нет 😎")

            return send_safe(chat_id, format_schedule({tomorrow: lessons}))

        elif text == "📆 Неделя":
            for date, lessons in schedule.items():
                send_safe(chat_id, format_schedule({date: lessons}))
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

    bot.send_message(
        message.chat.id,
        "👑 АДМИН-ПАНЕЛЬ\n\n"
        "/stats\n/users\n/broadcast\n/ping\n/logs"
    )


@bot.message_handler(commands=["stats"])
def stats(message):
    if message.chat.id != ADMIN_ID:
        return

    users = load_users()
    bot.send_message(message.chat.id, f"👥 Пользователей: {len(users)}")


@bot.message_handler(commands=["users"])
def users_cmd(message):
    if message.chat.id != ADMIN_ID:
        return

    users = load_users()
    bot.send_message(message.chat.id, f"👥 Всего: {len(users)}")


@bot.message_handler(commands=["broadcast"])
def broadcast(message):
    if message.chat.id != ADMIN_ID:
        return

    text = message.text.replace("/broadcast", "").strip()

    if not text:
        return bot.send_message(message.chat.id, "Использование: /broadcast текст")

    users = load_users()

    success = 0
    failed = 0

    for user_id in users:
        try:
            bot.send_message(user_id, f"📢 {text}")
            success += 1
            time.sleep(0.05)
        except Exception as e:
            failed += 1
            ERROR_LOGS.append(str(e))

    bot.send_message(message.chat.id, f"Отправлено: {success}, ошибок: {failed}")


@bot.message_handler(commands=["ping"])
def ping(message):
    if message.chat.id == ADMIN_ID:
        bot.send_message(message.chat.id, "🟢 Bot OK")


@bot.message_handler(commands=["logs"])
def logs(message):
    if message.chat.id != ADMIN_ID:
        return

    if not ERROR_LOGS:
        return bot.send_message(message.chat.id, "Ошибок нет")

    bot.send_message(message.chat.id, "\n".join(ERROR_LOGS[-10:]))


# =========================
# 🌐 WEBHOOK ENDPOINT
# =========================
@app.route(f"/{TOKEN}", methods=["POST"])
def webhook():
    update = telebot.types.Update.de_json(
        request.stream.read().decode("utf-8")
    )
    bot.process_new_updates([update])
    return "OK", 200


# =========================
# 🟢 HEALTH CHECK
# =========================
@app.route("/")
def home():
    return "Bot is running", 200


# =========================
# ▶️ START SERVER
# =========================
if __name__ == "__main__":
    print("Webhook bot running...")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
