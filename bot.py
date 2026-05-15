import os
import json
import telebot

from flask import Flask, request
from datetime import datetime
from telebot import types

from parser import parse_schedule, format_schedule

# =========================
# CONFIG
# =========================
TOKEN = os.getenv("TOKEN")
ADMIN_ID = 439819918
USERS_FILE = "users.json"

if not TOKEN:
    raise Exception("TOKEN is not set")

bot = telebot.TeleBot(TOKEN, threaded=False)
app = Flask(__name__)

ERROR_LOGS = []
broadcast_mode = False   # 🔥 FIX: было set(), теперь boolean


# =========================
# AUTO WEBHOOK
# =========================
def set_webhook():
    domain = os.getenv("RAILWAY_PUBLIC_DOMAIN")
    if not domain:
        print("No RAILWAY_PUBLIC_DOMAIN")
        return

    url = f"https://{domain}/"

    try:
        bot.remove_webhook()
        bot.set_webhook(url=url)
        print("Webhook set:", url)
    except Exception as e:
        print("Webhook error:", e)


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
# UI (FIX: admin button ONLY for admin)
# =========================
def main_menu(user_id):
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)

    markup.row("📅 Сегодня", "⏭ Завтра")
    markup.row("📆 Неделя")

    if user_id == ADMIN_ID:
        markup.row("⚙️ Admin")

    return markup


# =========================
# SAFE SEND
# =========================
def send_safe(chat_id, text):
    if not text:
        text = "Пусто"

    MAX = 3800
    parts = [text[i:i + MAX] for i in range(0, len(text), MAX)]

    for part in parts:
        bot.send_message(chat_id, part, reply_markup=main_menu(chat_id))


# =========================
# WEBHOOK
# =========================
@app.route("/", methods=["POST"])
def webhook():
    try:
        update = telebot.types.Update.de_json(
            request.get_data().decode("utf-8")
        )
        bot.process_new_updates([update])

    except Exception as e:
        print("WEBHOOK ERROR:", e)
        ERROR_LOGS.append(str(e))

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
        reply_markup=main_menu(message.chat.id)
    )


# =========================
# ADMIN PANEL (FIX: ONLY BUTTON FOR ADMIN)
# =========================
@bot.message_handler(func=lambda m: m.text == "⚙️ Admin")
def admin_button(message):

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

    if call.from_user.id != ADMIN_ID:
        return

    chat_id = call.message.chat.id
    bot.answer_callback_query(call.id)

    if call.data == "stats":
        bot.send_message(chat_id, f"👥 Users: {len(load_users())}")

    elif call.data == "users":
        bot.send_message(chat_id, f"👥 Total: {len(load_users())}")

    elif call.data == "ping":
        bot.send_message(chat_id, "🟢 OK")

    elif call.data == "logs":
        logs = "\n".join(ERROR_LOGS[-10:]) or "No errors"
        bot.send_message(chat_id, logs)

    elif call.data == "broadcast":
        global broadcast_mode
        broadcast_mode = True
        bot.send_message(chat_id, "📢 Отправь текст рассылки")


# =========================
# MAIN HANDLER
# =========================
@bot.message_handler(content_types=["text"])
def handle(message):

    global broadcast_mode

    chat_id = message.chat.id
    text = (message.text or "").strip()

    print("TEXT:", chat_id, text)

    if text.startswith("/"):
        return

    try:
        # ================= BROADCAST =================
        if chat_id == ADMIN_ID and broadcast_mode:
            broadcast_mode = False

            users = load_users()
            ok, fail = 0, 0

            for u in users:
                try:
                    bot.send_message(u, f"📢 {text}")
                    ok += 1
                except:
                    fail += 1

            bot.send_message(chat_id, f"✔ Sent: {ok} | ❌ Failed: {fail}")
            return

        # ================= SCHEDULE =================
        schedule = parse_schedule()

        if not schedule:
            send_safe(chat_id, "Нет данных 😎")
            return

        keys = sorted(
            schedule.keys(),
            key=lambda x: datetime.strptime(x, "%d.%m.%Y")
        )

        if text == "📅 Сегодня":
            if keys:
                send_safe(chat_id, format_schedule({keys[0]: schedule[keys[0]]}))

        elif text == "⏭ Завтра":
            if len(keys) > 1:
                send_safe(chat_id, format_schedule({keys[1]: schedule[keys[1]]}))

        elif text == "📆 Неделя":
            send_safe(chat_id, format_schedule(schedule))

    except Exception as e:
        print("HANDLE ERROR:", e)
        ERROR_LOGS.append(str(e))
        send_safe(chat_id, f"Ошибка: {e}")


# =========================
# START SERVER
# =========================
if __name__ == "__main__":
    print("BOT STARTED")

    set_webhook()

    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
