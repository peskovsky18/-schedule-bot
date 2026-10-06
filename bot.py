# -*- coding: utf-8 -*-
"""
Телеграм-бот с расписанием РГПУ им. А. И. Герцена.

Работает через webhook: Telegram сам присылает POST на этот сервер при
каждом сообщении. Для локальной отладки можно включить long polling
переменной окружения USE_POLLING=1.

Переменные окружения:
    TOKEN         — токен бота от @BotFather (обязательно)
    WEBHOOK_URL   — публичный адрес сервиса, например
                    https://schedule-bot.onrender.com (для webhook)
    ADMIN_ID      — Telegram ID администратора (по умолчанию 439819918)
    GROUP_ID      — ID группы на сайте guide.herzen.spb.ru
    GROUP_NAME    — название группы; если задано, ID ищется автоматически
    TELEGRAM_SECRET — необязательный секрет для проверки, что запросы
                    действительно от Telegram
    USE_POLLING   — 1, чтобы работать через long polling (локально)
"""

import json
import os
import threading
import time
import traceback
from datetime import date, timedelta

import telebot
import telebot.apihelper as apihelper
from flask import Flask, jsonify, request
from telebot import types

import chess_api
import chess_game
import parser
from parser import format_schedule, get_today, get_tomorrow, get_week, parse_schedule

# Короткие таймауты к Telegram API. По умолчанию 15 с на соединение и 30 с
# на ответ — затянувшийся вызов задерживал бы старт сервиса.
apihelper.CONNECT_TIMEOUT = 5
apihelper.READ_TIMEOUT = 15

# =========================
# CONFIG
# =========================
TOKEN = os.getenv("TOKEN")

ADMIN_ID = int(os.getenv("ADMIN_ID", "439819918"))

# Публичный адрес сервиса. Нужен, чтобы бот сам зарегистрировал webhook.
# На Render переменная RENDER_EXTERNAL_URL задаётся автоматически,
# поэтому вручную указывать адрес не требуется.
WEBHOOK_URL = (
    os.getenv("WEBHOOK_URL")
    or os.getenv("RENDER_EXTERNAL_URL")
    or ""
).strip().rstrip("/")

# Необязательный секрет: Telegram будет присылать его в заголовке,
# и мы сможем отбросить поддельные запросы.
TELEGRAM_SECRET = (os.getenv("TELEGRAM_SECRET") or "").strip()

# Адрес мини-приложения (Netlify). Если задан, бот поставит кнопку меню,
# которая открывает расписание в виде приложения.
MINIAPP_URL = (os.getenv("MINIAPP_URL") or "").strip().rstrip("/")

USE_POLLING = os.getenv("USE_POLLING") == "1"

USERS_FILE = os.getenv("USERS_FILE", "users.json")

if not TOKEN:
    raise Exception(
        "Переменная окружения TOKEN не задана, работать нечем.\n"
        "Как исправить:\n"
        "  1. Откройте сервис на Render → вкладка Environment.\n"
        "  2. Add Environment Variable: Key = TOKEN, "
        "Value = токен бота от @BotFather.\n"
        "  3. Save — Render перезапустит сервис сам.\n"
        "Если сервис создавался как Blueprint, TOKEN запрашивается только\n"
        "при первом создании: при обновлении существующего Blueprint Render\n"
        "переменные с sync: false игнорирует, поэтому добавьте вручную."
    )

bot = telebot.TeleBot(TOKEN, threaded=False)
app = Flask(__name__)

# Раздел шахмат /api/chess подключается ниже — после того, как объявлена
# функция уведомлений: в Python имя должно существовать в момент вызова.

ERROR_LOGS = []
broadcast_mode = set()

# Кэш имени бота: чтобы health-check не дёргал Telegram API каждый раз
_bot_username = None


# =========================
# WEBHOOK
# =========================
@app.route("/", methods=["POST"])
def webhook():
    # Проверяем секрет, если он задан
    if TELEGRAM_SECRET:
        got = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if got != TELEGRAM_SECRET:
            print("[WEBHOOK] отклонён запрос с неверным секретом")
            return "Forbidden", 403

    try:
        data = request.get_data().decode("utf-8")

        if not data:
            return "OK", 200

        update = telebot.types.Update.de_json(data)
        bot.process_new_updates([update])

    except Exception as e:
        ERROR_LOGS.append(str(e))
        print("WEBHOOK ERROR:", e)
        traceback.print_exc()

    # Всегда отвечаем 200, иначе Telegram будет слать апдейт повторно
    return "OK", 200


@app.route("/", methods=["GET"])
@app.route("/health", methods=["GET"])
def health():
    """
    Проверка живости сервиса.

    Обращений к сети здесь нет вообще: ни к сайту университета, ни
    к Telegram. Render дёргает этот адрес, чтобы понять, жив ли сервис,
    и недоступность внешнего API не должна выглядеть как падение бота.
    Расписание берётся из кэша, имя бота — из уже выясненного.

    Чтобы принудительно обновить расписание, добавьте ?deep=1.
    """
    deep = request.args.get("deep") == "1"

    schedule = parse_schedule() if deep else parser.cached_schedule()

    return jsonify({
        "status": "ok",
        "bot": _bot_username,
        "ready": parser.cache_age() is not None,
        "cache_age": parser.cache_age(),
        "dates": len(schedule),
        "lessons": sum(len(v) for v in schedule.values()),
        "users": len(load_users()),
        "errors": len(ERROR_LOGS),
    })


def warm_bot_username():
    """
    Узнаёт имя бота и запоминает его.

    Вызывается из фоновой настройки, а не из /health: проверка живости
    не должна ждать ответа Telegram.
    """
    global _bot_username

    if _bot_username is None:
        try:
            _bot_username = bot.get_me().username
            print(f"[BOT] @{_bot_username}")
        except Exception as e:
            print("[BOT] не удалось получить имя бота:", e)

    return _bot_username


# =========================
# JSON API ДЛЯ МИНИ-ПРИЛОЖЕНИЯ
# =========================
# Мини-приложение живёт на Netlify, а API — здесь, поэтому нужен CORS.
# Доступ по умолчанию открыт всем: данные о расписании публичные,
# запись через API невозможна. Чтобы ограничить домен, задайте
# ALLOWED_ORIGINS, например: https://my-miniapp.netlify.app
ALLOWED_ORIGINS = (os.getenv("ALLOWED_ORIGINS") or "*").strip()


@app.after_request
def add_cors_headers(response):
    """CORS только для /api/* — вебхук трогать не нужно."""
    if request.path.startswith("/api/"):
        response.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGINS
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        # X-Telegram-Init-Data — подпись Telegram, по ней шахматы
        # понимают, кто именно ходит
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Telegram-Init-Data"
        response.headers["Vary"] = "Origin"
    return response


@app.route("/api/schedule", methods=["GET", "OPTIONS"])
def api_schedule():
    """
    Расписание в JSON для мини-приложения.

    Отдаёт только предстоящие дни, начиная с сегодняшнего (по Москве).
    """
    if request.method == "OPTIONS":
        return "", 204

    try:
        schedule = parse_schedule()
    except Exception as e:
        ERROR_LOGS.append(str(e))
        traceback.print_exc()
        return jsonify({"ok": False, "error": "Не удалось получить расписание"}), 502

    today = parser.now_msk().date()
    today_iso = today.isoformat()

    days = []
    for iso in sorted(schedule):
        if iso < today_iso:
            continue

        days.append({
            "date": iso,
            "weekday": parser.WEEKDAYS[date.fromisoformat(iso).weekday()],
            "human": parser.human_date(iso),
            "lessons": schedule[iso],
        })

    return jsonify({
        "ok": True,
        "group": parser.group_info(),
        "today": today_iso,
        "tomorrow": (today + timedelta(days=1)).isoformat(),
        "timezone": "Europe/Moscow",
        "cache_age": parser.cache_age(),
        "groups_total": len(days),
        "lessons_total": sum(len(d["lessons"]) for d in days),
        "days": days,
    })


def register_webhook():
    """
    Регистрирует webhook в Telegram.

    Возвращает True, если всё в порядке или настраивать нечего
    (например, локальный запуск без WEBHOOK_URL).
    """
    if not WEBHOOK_URL:
        print("[WEBHOOK] WEBHOOK_URL не задан — регистрация пропущена")
        return True

    # Сносим прошлый webhook отдельным блоком: если именно этот вызов
    # не удался, новый всё равно нужно поставить. Раньше они были в одном
    # try, и сбой remove_webhook оставлял бота вообще без webhook.
    try:
        bot.remove_webhook()
    except Exception as e:
        print("[WEBHOOK] старый webhook снять не удалось (не критично):", e)

    try:
        bot.set_webhook(
            url=WEBHOOK_URL,
            secret_token=TELEGRAM_SECRET or None,
            drop_pending_updates=True,
        )
        print(f"[WEBHOOK] зарегистрирован: {WEBHOOK_URL}")
        return True
    except Exception as e:
        print("[WEBHOOK] не удалось зарегистрировать:", e)
        return False


def register_menu_button():
    """
    Ставит кнопку меню, открывающую мини-приложение.

    Без MINIAPP_URL ничего не делает, поэтому задеплоить бота можно
    раньше, чем мини-приложение. Возвращает True, если настраивать
    нечего или всё получилось.
    """
    if not MINIAPP_URL:
        print("[MENU] MINIAPP_URL не задан — кнопка мини-приложения пропущена")
        return True

    try:
        bot.set_chat_menu_button(
            menu_button=types.MenuButtonWebApp(
                type="web_app",
                text="Расписание",
                web_app=types.WebAppInfo(url=MINIAPP_URL),
            )
        )
        print(f"[MENU] кнопка мини-приложения: {MINIAPP_URL}")
        return True
    except Exception as e:
        print("[MENU] не удалось поставить кнопку меню:", e)
        return False


_setup_lock = threading.Lock()
_setup_done = False


def setup_telegram():
    """Настраивает webhook и кнопку меню. Возвращает True, если всё готово."""
    global _setup_done

    with _setup_lock:
        if _setup_done:
            return True

        # Заодно узнаём имя бота — потом /health отдаст его без обращения
        # к сети
        warm_bot_username()

        webhook_ok = register_webhook()
        menu_ok = register_menu_button()

        _setup_done = webhook_ok and menu_ok
        return _setup_done


def start_telegram_setup():
    """
    Запускает настройку Telegram в отдельном потоке.

    Раньше это выполнялось прямо при импорте модуля. Gunicorn на Render
    стартует с --preload, то есть импорт идёт до открытия порта: если
    Telegram отвечал медленно, сервис не успевал подняться и деплой падал.
    Теперь старт от сети не зависит, а при неудаче попытки повторяются.
    """
    def work():
        for attempt in range(1, 6):
            if setup_telegram():
                return

            delay = min(15 * attempt, 60)
            print(f"[SETUP] попытка {attempt} не удалась, повтор через {delay} с")
            time.sleep(delay)

        print("[SETUP] Telegram так и не настроился — проверьте TOKEN и логи")

    threading.Thread(target=work, daemon=True, name="telegram-setup").start()


# =========================
# USERS
# =========================
def load_users():
    """Список chat_id. Файл может отсутствовать — это нормально."""
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception as e:
        print("[USERS] не удалось прочитать:", e)
        return []


def save_user(user_id):
    """
    Добавляет пользователя в список.

    На бесплатном хостинге диск может быть только для чтения или
    очищаться при перезапуске, поэтому ошибка записи не должна ломать
    команду /start.
    """
    try:
        users = load_users()
        if user_id in users:
            return

        users.append(user_id)
        with open(USERS_FILE, "w", encoding="utf-8") as f:
            json.dump(users, f, ensure_ascii=False, indent=2)

    except Exception as e:
        print("[USERS] не удалось сохранить (это не критично):", e)


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
    """Отправляет текст, разбивая слишком длинные сообщения."""
    if not text:
        text = "Пусто"

    MAX = 3800
    for i in range(0, len(text), MAX):
        chunk = text[i:i + MAX]
        # Кнопку прикрепляем только к последнему сообщению
        last = i + MAX >= len(text)
        bot.send_message(
            chat_id,
            chunk,
            reply_markup=main_menu() if last else None,
        )


# =========================
# START
# =========================
@bot.message_handler(commands=["start"])
def start(message):
    save_user(message.chat.id)

    # Переход по ссылке-приглашению в шахматы выглядит как /start <id партии>
    parts = (message.text or "").split(maxsplit=1)
    invite = parts[1].strip() if len(parts) > 1 else ""

    if invite and accept_chess_invite(message, invite):
        return

    bot.send_message(
        message.chat.id,
        "📚 Бот запущен\n\nВыберите, что показать:",
        reply_markup=main_menu(),
    )


def notify_chess_move(game, game_id, mover_id, resigned=False):
    """
    Пишет сопернику, что сделан ход.

    Вызывается из обработчика HTTP, поэтому отправка уходит в отдельный
    поток: ответ на ход не должен ждать Telegram, иначе доска будет
    подвисать на время сетевого запроса.
    """
    players = [game.get("white"), game.get("black")]
    opponent = next(
        (p for p in players if p and p.get("id") and p["id"] != mover_id),
        None,
    )

    if not opponent:
        return

    if resigned:
        text = "♟ Соперник сдался. Вы победили!"
    else:
        board = chess_game.board_of(game)
        if board.is_checkmate():
            text = "♟ Мат! Партия закончена."
        elif board.is_check():
            text = "♟ Шах! Ваш ход."
        else:
            text = "♟ Ваш ход."

    def work():
        try:
            markup = None

            if MINIAPP_URL:
                markup = types.InlineKeyboardMarkup()
                markup.add(types.InlineKeyboardButton(
                    "Открыть доску",
                    web_app=types.WebAppInfo(url=f"{MINIAPP_URL}/?game={game_id}"),
                ))

            bot.send_message(opponent["id"], text, reply_markup=markup)
        except Exception as e:
            # Соперник мог не начать чат с ботом — это не повод ронять ход
            print("[CHESS] не удалось сообщить о ходе:", e)

    threading.Thread(target=work, daemon=True, name="chess-notify").start()


# Токен нужен, чтобы проверять подпись Telegram и понимать, кто ходит.
# notify связывает ходы с сообщениями в боте.
chess_api.init_app(app, TOKEN, notify=notify_chess_move)


def accept_chess_invite(message, game_id):
    """
    Сажает приглашённого за чёрных и присылает кнопку с доской.

    Возвращает True, если сообщение было про шахматы и обработано здесь —
    тогда обычное приветствие показывать не нужно.
    """
    game = chess_game.load_game(game_id)

    if not game:
        bot.send_message(
            message.chat.id,
            "♟ Эта партия уже недоступна. Создайте новую в приложении.",
        )
        return True

    player = {
        "id": message.from_user.id,
        "name": message.from_user.first_name or "Игрок",
    }

    already = chess_game.is_player(game, player["id"])

    if not already:
        game, error = chess_game.join_game(game, player)
        if error:
            bot.send_message(message.chat.id, f"♟ {error}")
            return True

    if not MINIAPP_URL:
        bot.send_message(
            message.chat.id,
            "♟ Приглашение принято, но приложение не настроено: "
            "на Render не задан MINIAPP_URL.",
        )
        return True

    color = chess_game.player_color(game, player["id"])
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton(
        "Открыть доску",
        web_app=types.WebAppInfo(url=f"{MINIAPP_URL}/?game={game_id}"),
    ))

    if already:
        text = "♟ Партия уже ваша — вот доска."
    else:
        text = "♟ Вас пригласили в шахматы. Вы играете " + (
            "белыми" if color == "white" else "чёрными"
        ) + "."

    bot.send_message(message.chat.id, text, reply_markup=markup)

    # Соперника тоже стоит предупредить, что игра началась.
    # В личном чате chat_id совпадает с id пользователя.
    if not already and color == "black" and game.get("white"):
        try:
            bot.send_message(game["white"]["id"], "♟ Соперник присоединился. Ваш ход!")
        except Exception as e:
            print("[CHESS] не удалось предупредить соперника:", e)

    return True


# =========================
# ADMIN PANEL
# =========================
@bot.message_handler(commands=["admin"])
def admin(message):

    if message.from_user.id != ADMIN_ID:
        bot.send_message(message.chat.id, "⛔ Нет доступа")
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

    bot.send_message(message.chat.id, "👑 ADMIN PANEL", reply_markup=markup)


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
        schedule = parse_schedule()
        bot.send_message(
            chat_id,
            f"👥 Пользователей: {len(load_users())}\n"
            f"📅 Дней в расписании: {len(schedule)}\n"
            f"📚 Пар всего: {sum(len(v) for v in schedule.values())}",
        )

    elif call.data == "users":
        bot.send_message(chat_id, f"👥 Total: {len(load_users())}")

    elif call.data == "ping":
        bot.send_message(chat_id, "🟢 OK")

    elif call.data == "logs":
        bot.send_message(chat_id, "\n".join(ERROR_LOGS[-10:]) or "No errors")

    elif call.data == "broadcast":
        broadcast_mode.add(chat_id)
        bot.send_message(chat_id, "📢 Введите текст")


# =========================
# TEXT HANDLER
# =========================
@bot.message_handler(content_types=["text"])
def handle(message):

    chat_id = message.chat.id
    text = (message.text or "").strip()

    if text.startswith("/"):
        return

    try:
        # ================= BROADCAST =================
        if chat_id == ADMIN_ID and chat_id in broadcast_mode:
            broadcast_mode.discard(chat_id)

            users = load_users()
            ok, fail = 0, 0

            for u in users:
                try:
                    bot.send_message(u, f"📢 {text}")
                    ok += 1
                except Exception as e:
                    print(f"[BROADCAST] не доставлено {u}: {e}")
                    fail += 1

            bot.send_message(chat_id, f"✔ Sent: {ok} | ❌ Failed: {fail}")
            return

        # ================= SCHEDULE =================
        if text == "📅 Сегодня":
            lessons = get_today()
            if not lessons:
                bot.send_message(chat_id, "😎 Сегодня пар нет", reply_markup=main_menu())
            else:
                send_safe(chat_id, format_schedule(lessons))

        elif text == "⏭ Завтра":
            lessons = get_tomorrow()
            if not lessons:
                bot.send_message(chat_id, "😎 Завтра пар нет", reply_markup=main_menu())
            else:
                send_safe(chat_id, format_schedule(lessons, compact=True))

        elif text == "📆 Неделя":
            lessons = get_week()
            if not lessons:
                bot.send_message(
                    chat_id,
                    "😎 На ближайшую неделю пар нет",
                    reply_markup=main_menu(),
                )
            else:
                send_safe(chat_id, format_schedule(lessons, compact=True))

        else:
            bot.send_message(
                chat_id,
                "Не понял 🤔 Выберите пункт меню.",
                reply_markup=main_menu(),
            )

    except Exception as e:
        ERROR_LOGS.append(str(e))
        traceback.print_exc()
        send_safe(chat_id, f"Ошибка: {e}")


# =========================
# START SERVER
# =========================
# При запуске через gunicorn блок __main__ не выполняется, поэтому настройку
# Telegram запускаем на уровне модуля — но в фоне, чтобы не задерживать старт.
if not USE_POLLING:
    start_telegram_setup()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))

    if USE_POLLING:
        print("BOT STARTED (polling)")
        bot.remove_webhook()
        bot.infinity_polling()
    else:
        print(f"BOT STARTED (webhook) on port {port}")
        app.run(host="0.0.0.0", port=port)
