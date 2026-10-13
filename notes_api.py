# -*- coding: utf-8 -*-
"""
API для заметок и заданий к парам с дедлайнами.
"""

import json
import time
import uuid
from flask import Blueprint, jsonify, request

import auth
import store

bp = Blueprint("notes", __name__, url_prefix="/api/notes")


def _user_notes_key(user_id):
    return f"notes:user:{user_id}"


def get_user_notes(user_id):
    s = store.get_store()
    raw = s.get(_user_notes_key(user_id))
    if not raw:
        return []
    try:
        if isinstance(raw, str):
            return json.loads(raw)
        return raw
    except Exception:
        return []


def save_user_notes(user_id, notes):
    s = store.get_store()
    s.set(_user_notes_key(user_id), json.dumps(notes, ensure_ascii=False))


def init_app(app):
    app.register_blueprint(bp)


@bp.route("", methods=["GET"])
def list_notes():
    user, err = auth.current_user()
    if err:
        return jsonify({"ok": False, "error": err}), 401
    notes = get_user_notes(user["id"])
    return jsonify({"ok": True, "notes": notes})


@bp.route("", methods=["POST"])
def add_or_update_note():
    user, err = auth.current_user()
    if err:
        return jsonify({"ok": False, "error": err}), 401

    data = request.get_json(silent=True) or {}
    subject = (data.get("subject") or "").strip()
    text = (data.get("text") or "").strip()
    deadline = (data.get("deadline") or "").strip()
    note_id = data.get("id")

    if not text:
        return jsonify({"ok": False, "error": "Текст задания не может быть пустым"}), 400

    notes = get_user_notes(user["id"])
    now = int(time.time())

    if note_id:
        found = False
        for n in notes:
            if n.get("id") == note_id:
                n["subject"] = subject
                n["text"] = text
                n["deadline"] = deadline
                n["updated_at"] = now
                found = True
                break
        if not found:
            notes.append({
                "id": note_id,
                "subject": subject,
                "text": text,
                "deadline": deadline,
                "done": False,
                "created_at": now,
            })
    else:
        new_note = {
            "id": f"note_{int(now * 1000)}_{uuid.uuid4().hex[:6]}",
            "subject": subject,
            "text": text,
            "deadline": deadline,
            "done": False,
            "created_at": now,
        }
        notes.append(new_note)

    save_user_notes(user["id"], notes)
    return jsonify({"ok": True, "notes": notes})


@bp.route("/toggle", methods=["POST"])
def toggle_note():
    user, err = auth.current_user()
    if err:
        return jsonify({"ok": False, "error": err}), 401

    data = request.get_json(silent=True) or {}
    note_id = data.get("id")
    if not note_id:
        return jsonify({"ok": False, "error": "Не указан id заметки"}), 400

    notes = get_user_notes(user["id"])
    for n in notes:
        if n.get("id") == note_id:
            n["done"] = not n.get("done", False)
            break

    save_user_notes(user["id"], notes)
    return jsonify({"ok": True, "notes": notes})


@bp.route("/<note_id>", methods=["DELETE"])
def delete_note(note_id):
    user, err = auth.current_user()
    if err:
        return jsonify({"ok": False, "error": err}), 401

    notes = get_user_notes(user["id"])
    notes = [n for n in notes if n.get("id") != note_id]
    save_user_notes(user["id"], notes)
    return jsonify({"ok": True, "notes": notes})
