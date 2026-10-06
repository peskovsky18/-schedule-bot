# -*- coding: utf-8 -*-
"""
HTTP-API музыки: добавление треков прямо из мини-приложения.

Мини-приложение статическое — файлы ему хранить негде, поэтому загрузка
идёт на сервер, а оттуда в Redis. Проверка подписи Telegram обязательна
для всего, что меняет данные: иначе хранилище забьёт кто угодно.

Отдача аудио, наоборот, без подписи: тег <audio> не умеет отправлять
заголовки, и требовать подпись там просто нечем.
"""

import base64

from flask import Blueprint, Response, jsonify, request

import auth
import music

bp = Blueprint("music", __name__)

# Администратор может удалять чужие треки
_admin_id = None


def init_app(app, admin_id=None):
    global _admin_id
    _admin_id = admin_id
    app.register_blueprint(bp)


def _player():
    """Пользователь для записи в метаданные."""
    user, error = auth.current_user()
    return user, error


# =========================
# СПИСОК И ДОБАВЛЕНИЕ
# =========================
@bp.route("/api/music", methods=["GET"])
def api_list():
    """
    Список добавленных треков.

    Встроенные треки живут в config.js мини-приложения и сюда не входят:
    сервер про них ничего не знает и знать не должен.
    """
    user, _ = auth.current_user()
    user_id = user["id"] if user else None

    tracks = [music.serialize(t, user_id, _admin_id) for t in music.list_tracks()]

    return jsonify({
        "ok": True,
        "tracks": tracks,
        "usedBytes": music.total_bytes(),
        "maxUploadBytes": music.MAX_UPLOAD_BYTES,
        "maxTracks": music.MAX_TRACKS,
    })


@bp.route("/api/music", methods=["POST"])
def api_add():
    """
    Добавляет трек.

    Два способа в одном обработчике: файлом (multipart, поле audio)
    или ссылкой (JSON с полем url). Файл предпочтительнее — ссылка
    живёт, пока жив чужой хостинг.
    """
    user, error = _player()
    if error:
        return jsonify({"ok": False, "error": error}), 401

    upload = request.files.get("audio")
    title = request.form.get("title") or ""

    if upload:
        try:
            data = upload.read()
        except Exception as e:
            return jsonify({"ok": False, "error": f"Не удалось прочитать файл: {e}"}), 400

        track, error = music.add_file(user, title, data, upload.mimetype)
    else:
        payload = request.get_json(silent=True) or {}
        track, error = music.add_link(
            user,
            title or payload.get("title") or "",
            payload.get("url") or request.form.get("url") or "",
        )

    if error:
        return jsonify({"ok": False, "error": error}), 400

    return jsonify({
        "ok": True,
        "track": music.serialize(track, user["id"], _admin_id),
        "usedBytes": music.total_bytes(),
    })


@bp.route("/api/music/<track_id>/delete", methods=["POST"])
def api_delete(track_id):
    user, error = _player()
    if error:
        return jsonify({"ok": False, "error": error}), 401

    track, error = music.remove(track_id, user["id"], _admin_id)
    if error:
        return jsonify({"ok": False, "error": error}), 403

    return jsonify({"ok": True, "removed": track["id"], "usedBytes": music.total_bytes()})


# =========================
# ОТДАЧА АУДИО
# =========================
def _range_of(header, total):
    """
    Разбирает «bytes=0-1023» в пару чисел.

    Возвращает None, если заголовка нет или он не разбирается —
    тогда отдаём файл целиком.
    """
    if not header or not header.startswith("bytes=") or total <= 0:
        return None

    spec = header[6:].split(",")[0].strip()
    if "-" not in spec:
        return None

    start_text, end_text = spec.split("-", 1)

    try:
        if start_text == "":
            # «bytes=-500» — последние 500 байт
            length = int(end_text)
            if length <= 0:
                return None
            return max(0, total - length), total - 1

        start = int(start_text)
        end = int(end_text) if end_text else total - 1
    except ValueError:
        return None

    start = max(0, start)
    end = min(end, total - 1)

    if start > end:
        return None

    return start, end


@bp.route("/api/music/<track_id>/audio", methods=["GET"])
def api_audio(track_id):
    """
    Отдаёт звук трека.

    Поддерживаем Range: без него полоса перемотки в плеере не работает —
    браузер не может запросить середину файла и просто не даёт двигать
    ползунок.
    """
    payload, content_type = music.audio_of(track_id)

    if not payload:
        return jsonify({"ok": False, "error": "Трек не найден"}), 404

    try:
        data = base64.b64decode(payload)
    except (ValueError, TypeError):
        return jsonify({"ok": False, "error": "Файл повреждён"}), 500

    total = len(data)
    span = _range_of(request.headers.get("Range"), total)

    if span:
        start, end = span
        chunk = data[start:end + 1]

        response = Response(chunk, status=206, mimetype=content_type)
        response.headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    else:
        response = Response(data, status=200, mimetype=content_type)

    response.headers["Content-Length"] = str(len(response.data))
    response.headers["Accept-Ranges"] = "bytes"
    # Треки не меняются, а идентификаторы случайны и не переиспользуются
    response.headers["Cache-Control"] = "public, max-age=86400"

    return response
