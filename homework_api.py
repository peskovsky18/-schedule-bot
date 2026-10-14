# -*- coding: utf-8 -*-
"""
API для домашних заданий группы из Telegram-канала.
"""

import io
import os
import requests
from flask import Blueprint, jsonify, request, Response

import auth
import homework

bp = Blueprint("homework", __name__, url_prefix="/api/homework")

_bot = None


def set_bot(bot_instance):
    global _bot
    _bot = bot_instance


def init_app(app, bot_instance=None):
    if bot_instance:
        set_bot(bot_instance)
    app.register_blueprint(bp)


@bp.route("", methods=["GET", "OPTIONS"])
def list_homework():
    if request.method == "OPTIONS":
        return "", 204

    items = homework.get_all_homework()

    # Если пользователь авторизован через Telegram, возвращаем его отметки выполнения
    user, _ = auth.current_user()
    user_done = []
    if user and user.get("id"):
        user_done = homework.get_user_done(user["id"])

    return jsonify({
        "ok": True,
        "homework": items,
        "user_done": user_done,
    })


@bp.route("/toggle", methods=["POST", "OPTIONS"])
def toggle_done():
    if request.method == "OPTIONS":
        return "", 204

    user, err = auth.current_user()
    if err or not user:
        return jsonify({"ok": False, "error": "Нужна авторизация через Telegram"}), 401

    data = request.get_json(silent=True) or {}
    hw_id = data.get("id")
    if not hw_id:
        return jsonify({"ok": False, "error": "Не указан id задания"}), 400

    is_done, user_done = homework.toggle_user_done(user["id"], hw_id)

    return jsonify({
        "ok": True,
        "id": hw_id,
        "done": is_done,
        "user_done": user_done,
    })


@bp.route("/photo/<file_id>", methods=["GET", "OPTIONS"])
def get_photo(file_id):
    """
    Проксирует изображение из Telegram Bot API, чтобы мини-апп мог безопасно
    отображать фотографии к заданиям без раскрытия токена бота.
    """
    if request.method == "OPTIONS":
        return "", 204

    token = os.getenv("TOKEN")
    if not token or not file_id:
        return "Фото не найдено", 404

    try:
        # Узнаём путь к файлу через Telegram Bot API
        file_info_url = f"https://api.telegram.org/bot{token}/getFile?file_id={file_id}"
        resp = requests.get(file_info_url, timeout=10)
        if resp.status_code != 200:
            return "Не удалось получить файл", 404

        data = resp.json()
        if not data.get("ok"):
            return "Файл не найден в Telegram", 404

        file_path = data["result"]["file_path"]
        download_url = f"https://api.telegram.org/file/bot{token}/{file_path}"

        img_resp = requests.get(download_url, timeout=15)
        if img_resp.status_code != 200:
            return "Не удалось загрузить изображение", 404

        response = Response(img_resp.content, mimetype=img_resp.headers.get("Content-Type", "image/jpeg"))
        # Кэшируем фото на 7 дней в браузере
        response.headers["Cache-Control"] = "public, max-age=604800, immutable"
        return response
    except Exception as e:
        return f"Ошибка загрузки фото: {str(e)}", 500


@bp.route("/parse", methods=["POST", "OPTIONS"])
def manual_parse():
    """
    Эндпоинт для ручного тестирования или добавления ДЗ через JSON.
    """
    if request.method == "OPTIONS":
        return "", 204

    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    photos = data.get("photos", [])
    post_link = data.get("post_link")

    item = homework.parse_homework_post(text, photos=photos, post_link=post_link)
    if not item:
        return jsonify({"ok": False, "error": "Не удалось распознать задание"}), 400

    saved = homework.save_homework(item)
    return jsonify({"ok": True, "item": saved})
