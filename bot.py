import os
import time
import telebot
from telebot import types

from parser import get_today, get_tomorrow, get_week

# =========================
# 🔐 TOKEN (Railway env)
# =========================
TOKEN = os.getenv("TOKEN")

if not TOKEN:
    raise Exception("TOKEN is not set in environment variables")

bot = telebot.TeleBot(TOKEN)

def send_long_message(chat_id, text):
    max_length = 4000

    while len(text) > max_length:
        part = text[:max_length]
        last_newline = part.rfind("\n")

        if last_newline != -1:
            part = text[:last_newline]
            text = text[last_newline:]
        else:
            text = text[max_length:]

        bot.send_message(chat_id, part)

    if text:
        bot.send_message(chat_id, text)
# =========================
# 🎛 MENU
# =========================
def main_menu():
    markup = types.InlineKeyboardMarkup()

    btn_today = types.InlineKeyboardButton("📅 Сегодня", callback_data="today")
    btn_tomorrow = types.InlineKeyboardButton("⏭ Завтра", callback_data="tomorrow")
    btn_week = types.InlineKeyboardButton("📆 Неделя", callback_data="week")

    markup.add(btn_today, btn_tomorrow)
    markup.add(btn_week)

    return markup


# =========================
# 🚀 START
# =========================
@bot.message_handler(commands=["start"])
def start(message):
    bot.send_message(
        message.chat.id,
        " Привет от Куриги:",
        reply_markup=main_menu()
    )


# =========================
# 🔘 CALLBACK
# =========================
@bot.callback_query_handler(func=lambda call: True)
def callback(call):
    try:
        bot.answer_callback_query(call.id)

        if call.data == "today":
            text = get_today()

        elif call.data == "tomorrow":
            text = get_tomorrow()

        elif call.data == "week":
            text = get_week()

        else:
            text = "Неизвестная команда"

        bot.edit_message_text(
            text,
            call.message.chat.id,
            call.message.message_id,
            reply_markup=main_menu()
        )

    except Exception as e:
        bot.send_message(call.message.chat.id, f"Ошибка: {e}")


# =========================
# ▶️ STABLE START (Railway-safe)
# =========================
if __name__ == "__main__":
    while True:
        try:
            print("🤖 Bot started...")

            bot.infinity_polling(
                timeout=10,
                long_polling_timeout=5,
                skip_pending=True
            )

        except Exception as e:
            print("💥 Bot crashed:", e)
            time.sleep(5)
