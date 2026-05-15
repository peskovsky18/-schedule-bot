import os
import json
import telebot

from flask import Flask, request
from telebot import types

from parser import parse_schedule, format_schedule

# =========================
# CONFIG
# =========================
TOKEN = os.getenv("TOKEN")

if not TOKEN:
    raise Exception("TOKEN is not set")

ADMIN_ID = 439819918
USERS_FILE = "users.json"

bot = telebot.TeleBot(TOKEN)
app = Flask(__name__)

ERROR_LOGS = []
broadcast_mode = {}

# =========================
# USERS
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
# KEYBOARD
# =========================
def main_menu():
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)
    markup.row("📅 Сегодня", "⏭ Завтра")
    markup.row("📆 Неделя")
    return markup

# =========================
# SAFE SEND
# =========================
def send_safe(chat_id, text):
    MAX = 3800
    for i in range(0, len(text), MAX):
        bot.send_message(chat_id, text[i:i+MAX], reply_markup=main_menu())

# =========================
# WEBHOOK (FIXED)
# =========================
@app.route(f"/{TOKEN}", methods=["POST"])
def webhook():
    json_str = request.get_data().decode("utf-8")
    update = telebot.types.Update.de_json(json_str)
    bot.process_new_updates([update])
    return "OK", 200

# =========================
# START
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
# MAIN HANDLER
# =========================
@bot.message_handler(func=lambda m: True)
def handle(message):

    global broadcast_mode

    chat_id = message.chat.id
    text = message.text

    # 🔥 BROADCAST MODE
    if chat_id == ADMIN_ID and broadcast_mode.get(chat_id):
        broadcast_mode[chat_id] = False

        users = load_users()
        success, failed = 0, 0

        for u in users:
            try:
                bot.send_message(u, f"📢 {text}")
                success += 1
            except:
                failed += 1

        bot.send_message(chat_id, f"✔ Sent: {success} | ❌ Failed: {failed}")
        return

    try:
        schedule = parse_schedule()

        if text == "📅 Сегодня":
            today = list(schedule.keys())[0]
            send_safe(chat_id, format_schedule({today: schedule[today]}))

        elif text == "⏭ Завтра":
            keys = list(schedule.keys())
            if len(keys) > 1:
                send_safe(chat_id, format_schedule({keys[1]: schedule[keys[1]]}))
            else:
                send_safe(chat_id, "Завтра нет данных 😎")

        elif text == "📆 Неделя":
            send_safe(chat_id, format_schedule(schedule))

    except Exception as e:
        ERROR_LOGS.append(str(e))
        send_safe(chat_id, f"Ошибка: {e}")

# =========================
# PRO ADMIN PANEL
# =========================
@bot.message_handler(commands=["admin"])
def admin_panel(message):

    if message.from_user.id != ADMIN_ID:
        return

    markup = types.InlineKeyboardMarkup()

    markup.add(
        types.InlineKeyboardButton("📊 Статистика", callback_data="stats"),
        types.InlineKeyboardButton("👥 Пользователи", callback_data="users")
    )

    markup.add(
        types.InlineKeyboardButton("📢 Рассылка", callback_data="broadcast"),
        types.InlineKeyboardButton("📄 Логи", callback_data="logs")
    )

    markup.add(
        types.InlineKeyboardButton("🟢 Ping", callback_data="ping")
    )

    bot.send_message(message.chat.id, "👑 PRO ADMIN PANEL", reply_markup=markup)

# =========================
# CALLBACKS
# =========================
@bot.callback_query_handler(func=lambda call: True)
def callbacks(call):

    chat_id = call.message.chat.id

    if call.from_user.id != ADMIN_ID:
        return

    bot.answer_callback_query(call.id)

    if call.data == "stats":
        bot.send_message(chat_id, f"👥 Users: {len(load_users())}")

    elif call.data == "users":
        bot.send_message(chat_id, f"👥 Total: {len(load_users())}")

    elif call.data == "ping":
        bot.send_message(chat_id, "🟢 OK")

    elif call.data == "logs":
        bot.send_message(chat_id, "\n".join(ERROR_LOGS[-10:]) or "No errors")

    elif call.data == "broadcast":
        broadcast_mode[chat_id] = True
        bot.send_message(chat_id, "📢 Send message for broadcast")

# =========================
# START SERVER
# =========================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
