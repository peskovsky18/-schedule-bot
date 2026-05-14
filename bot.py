import os
import telebot
from parser import get_tomorrow, get_week

TOKEN = os.getenv("TOKEN")

print("TOKEN =", TOKEN)  # 👈 диагностика

if not TOKEN:
    raise Exception("TOKEN is not set in environment variables")

bot = telebot.TeleBot(TOKEN)


@bot.message_handler(commands=["start"])
def start(message):
    bot.send_message(message.chat.id, "/tomorrow — завтра\n/week — неделя")


@bot.message_handler(commands=["tomorrow"])
def tomorrow(message):
    bot.send_message(message.chat.id, get_tomorrow())


@bot.message_handler(commands=["week"])
def week(message):
    bot.send_message(message.chat.id, get_week())


print("Bot started...")
bot.infinity_polling()
