
import os
import telebot
from telebot import types

from parser import get_today, get_tomorrow, get_week

# 🔐 TOKEN из Railway Variables
TOKEN = os.getenv (TOKEN)

if not TOKEN:
    raise Exception("TOKEN is not set in environment variables")

bot = telebot.TeleBot(TOKEN)


# =========================
# 🎛 ГЛАВНОЕ МЕНЮ (КНОПКИ)
# =========================
def main_menu():
    markup = types.InlineKeyboardMarkup()

    btn_today = types.InlineKeyboardButton("📅 Сегодня", callback_data="today")
    btn_tomorrow = types.InlineKeyboardButton("📅 Завтра", callback_data="tomorrow")
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
        "ПРИВЕТ, всех с днем Кураги\nВыбери действие:",
        reply_markup=main_menu()
    )


# =========================
# 🔘 ОБРАБОТКА КНОПОК
# =========================
@bot.callback_query_handler(func=lambda call: True)
def callback(call):
    try:
        if call.data == "today":
            bot.send_message(call.message.chat.id, get_today())

        elif call.data == "tomorrow":
            bot.send_message(call.message.chat.id, get_tomorrow())

        elif call.data == "week":
            bot.send_message(call.message.chat.id, get_week())

        # убираем "часики" у кнопки
        bot.answer_callback_query(call.id)

    except Exception as e:
        bot.send_message(call.message.chat.id, f"Ошибка: {e}")


# =========================
# ▶️ ЗАПУСК
# =========================
print("Bot started...")
bot.infinity_polling()
