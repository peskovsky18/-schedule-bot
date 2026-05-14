import os
import telebot
from telebot import types
from datetime import datetime, timedelta

from parser import parse_schedule, format_schedule


# =========================
# 🔐 TOKEN
# =========================
TOKEN = os.getenv("TOKEN")

if not TOKEN:
    raise Exception("TOKEN is not set")

bot = telebot.TeleBot(TOKEN)


# =========================
# 📌 ПОСТОЯННАЯ КЛАВИАТУРА (BOTTOM MENU)
# =========================
def main_menu():
    markup = types.ReplyKeyboardMarkup(
        resize_keyboard=True,
        one_time_keyboard=False,   # 🔥 ключевой момент: НЕ исчезает
        input_field_placeholder="Выбери действие"
    )

    markup.row("📅 Сегодня", "⏭ Завтра")
    markup.row("📆 Неделя")

    return markup


# =========================
# 🛡 SAFE SEND (Telegram limit)
# =========================
def send_safe(chat_id, text):
    MAX = 3800

    if not text:
        text = "Пусто"

    if len(text) <= MAX:
        bot.send_message(chat_id, text, reply_markup=main_menu())
        return

    parts = [text[i:i+MAX] for i in range(0, len(text), MAX)]

    for p in parts:
        bot.send_message(chat_id, p, reply_markup=main_menu())


# =========================
# 🚀 START
# =========================
@bot.message_handler(commands=["start"])
def start(message):
    bot.send_message(
        message.chat.id,
        "📚 Привет! Кнопки всегда снизу 👇",
        reply_markup=main_menu()
    )


# =========================
# 📩 HANDLE BUTTONS
# =========================
@bot.message_handler(func=lambda message: True)
def handle(message):
    text = message.text
    chat_id = message.chat.id

    try:
        schedule = parse_schedule()

        # ================= TODAY =================
        if text == "📅 Сегодня":
            today = datetime.now().strftime("%d.%m.%Y")

            lessons = schedule.get(today)
            if not lessons:
                return send_safe(chat_id, "Сегодня пар нет 😎")

            return send_safe(chat_id, format_schedule({today: lessons}))


        # ================= TOMORROW =================
        elif text == "⏭ Завтра":
            tomorrow = (datetime.now() + timedelta(days=1)).strftime("%d.%m.%Y")

            lessons = schedule.get(tomorrow)
            if not lessons:
                return send_safe(chat_id, "Завтра пар нет 😎")

            return send_safe(chat_id, format_schedule({tomorrow: lessons}))


        # ================= WEEK =================
        elif text == "📆 Неделя":
            if not schedule:
                return send_safe(chat_id, "Нет данных")

            # отправляем по дням (без MESSAGE_TOO_LONG)
            for date, lessons in schedule.items():
                send_safe(chat_id, format_schedule({date: lessons}))

            return


        # ================= UNKNOWN =================
        else:
            return send_safe(chat_id, "Выбери кнопку снизу 👇")


    except Exception as e:
        return send_safe(chat_id, f"Ошибка: {e}")


# =========================
# ▶️ START POLLING (RAILWAY SAFE)
# =========================
print("Bot started...")

bot.infinity_polling(
    timeout=10,
    long_polling_timeout=5,
    skip_pending=True
)
