/**
 * Интерфейс мини-приложения: сеть, кэш, отрисовка.
 *
 * Вся арифметика вынесена в core.js — здесь только DOM и запросы.
 */
(function () {
  "use strict";

  var core = window.ScheduleCore;

  // Логика шахматной доски. Файл публикует себя как window.ChessBoard,
  // здесь даём короткое имя, чтобы не путаться с DOM-элементом доски.
  var chess = window.ChessBoard;

  var CACHE_KEY = "schedule.cache.v2";
  var API_KEY = "schedule.apiBase";
  var CACHE_TTL = 5 * 60 * 1000; // 5 минут, как и на сервере

  // В верхней панели — три быстрых режима. Остальные («Неделя»,
  // «Всё расписание») остались в выездном меню.
  var MODES = [
    { id: "today", title: "Сегодня" },
    { id: "tomorrow", title: "Завтра" },
    { id: "next", title: "Следующая неделя" },
  ];

  /* ---------- Telegram ---------- */

  var tg = (window.Telegram && window.Telegram.WebApp) || null;

  // Вне Telegram приложение тоже должно работать — так его удобно
  // открывать в браузере при разработке.
  var inTelegram = !!(tg && (
    (tg.initData && tg.initData.length > 0) ||
    (tg.initDataUnsafe && tg.initDataUnsafe.user)
  ));

  function supports(method) {
    return !!(tg && typeof tg[method] === "function");
  }

  function haptic(type) {
    if (inTelegram && tg.HapticFeedback) {
      try {
        if (type === "light" || type === "medium" || type === "heavy") {
          tg.HapticFeedback.impactOccurred(type);
        } else if (type === "success" || type === "warning" || type === "error") {
          tg.HapticFeedback.notificationOccurred(type);
        } else if (type === "selection") {
          tg.HapticFeedback.selectionChanged();
        }
      } catch (e) {}
    }
  }

  function initTelegram() {
    if (!inTelegram) return;

    try { tg.ready(); } catch (e) {}
    try { tg.expand(); } catch (e) {}

    if (supports("setHeaderColor") && tg.backgroundColor) {
      try { tg.setHeaderColor(tg.backgroundColor); } catch (e) {}
    }
    if (supports("disableVerticalSwipes")) {
      try { tg.disableVerticalSwipes(); } catch (e) {}
    }

    applyTelegramTheme();

    if (supports("onEvent")) {
      try {
        tg.onEvent("themeChanged", applyTelegramTheme);
      } catch (e) {}
    }
  }

  /** Подставляет цвета темы Telegram в CSS-переменные. */
  function applyTelegramTheme() {
    if (!inTelegram) return;

    var p = tg.themeParams || {};
    var root = document.documentElement;
    var map = {
      "--tg-bg": p.bg_color || tg.backgroundColor,
      "--tg-secondary-bg": p.secondary_bg_color,
      "--tg-text": p.text_color,
      "--tg-hint": p.hint_color,
      "--tg-link": p.link_color,
      "--tg-button": p.button_color,
      "--tg-button-text": p.button_text_color,
      "--tg-accent": p.accent_text_color,
      "--tg-section-bg": p.section_bg_color,
      "--tg-section-header": p.section_header_text_color,
      "--tg-subtitle": p.subtitle_text_color,
      "--tg-destructive": p.destructive_text_color,
    };

    Object.keys(map).forEach(function (name) {
      if (map[name]) root.style.setProperty(name, map[name]);
    });

    if (tg.colorScheme) {
      root.setAttribute("data-scheme", tg.colorScheme === "light" ? "light" : "dark");
    }
  }

  /* ---------- Состояние ---------- */

  var state = {
    mode: "today",
    data: null,
    cached: false,
    loading: false,
    error: null,
  };

  /* ---------- Адрес API ---------- */

  function resolveApiBase() {
    // 1. Параметр в ссылке — удобно для быстрой проверки
    try {
      var fromUrl = new URLSearchParams(location.search).get("api");
      if (fromUrl) {
        localStorage.setItem(API_KEY, fromUrl.replace(/\/+$/, ""));
        return fromUrl.replace(/\/+$/, "");
      }
    } catch (e) {}

    // 2. Ранее сохранённый
    try {
      var saved = localStorage.getItem(API_KEY);
      if (saved) return saved;
    } catch (e) {}

    // 3. Значение из config.js
    return String(window.SCHEDULE_API_BASE || "").replace(/\/+$/, "");
  }

  var apiBase = resolveApiBase();

  /* ---------- Кэш ---------- */

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;

      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.data) return null;

      return parsed;
    } catch (e) {
      return null;
    }
  }

  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: data }));
    } catch (e) {}
  }

  /* ---------- Сеть ---------- */

  // Сколько раз подряд переспрашивали пустое расписание. Счётчик
  // обязан жить снаружи функции: внутри он обнулялся бы при каждом
  // вызове, и переспрос стал бы бесконечным.
  var scheduleAttempts = 0;

  function fetchSchedule() {
    state.loading = true;
    state.error = null;
    renderStatus();

    var url = (apiBase || "") + "/api/schedule";

    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("Сервер ответил " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error("Некорректный ответ API");

        // Сервис отдаёт кэш сразу, а расписание обновляет в фоне.
        // Сразу после перезапуска кэш пуст, и первый ответ приходит
        // без дней — тогда переспрашиваем через пару секунд, иначе
        // человек увидит пустой экран и решит, что всё сломалось
        var empty = !data.days || data.days.length === 0;

        if (empty && scheduleAttempts < 3) {
          scheduleAttempts += 1;
          setTimeout(fetchSchedule, 2500);
          return;
        }

        scheduleAttempts = 0;
        state.data = data;
        state.cached = false;
        state.loading = false;
        writeCache(data);
        render();
        populateSubjectDatalist();
      })
      .catch(function (err) {
        state.loading = false;
        scheduleAttempts = 0;
        state.error = err && err.message ? err.message : "Нет связи";

        // Бесплатный Render засыпает, поэтому показываем последнее
        // известное расписание вместо пустого экрана.
        render();
      });
  }

  /* ---------- Отрисовка ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function render() {
    renderGroup();
    renderSegments();
    renderStatus();
    renderDays();
  }

  function renderGroup() {
    var box = document.getElementById("group");
    var title = (window.APP && window.APP.title) || "ППРСД super app";

    if (box) box.textContent = title;
    document.title = title;
  }

  function renderSegments() {
    var box = document.getElementById("segments");
    if (!box || box.childElementCount) return;

    MODES.forEach(function (mode) {
      var btn = el("button", "segmented__btn", mode.title);
      btn.type = "button";
      btn.dataset.mode = mode.id;

      btn.addEventListener("click", function () {
        state.mode = mode.id;
        renderSegments();
        renderDays();
      });

      box.appendChild(btn);
    });
  }

  function markActiveSegment() {
    var box = document.getElementById("segments");
    if (!box) return;

    Array.prototype.forEach.call(box.children, function (btn) {
      var active = btn.dataset.mode === state.mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function renderStatus() {
    var box = document.getElementById("status");
    if (!box) return;

    box.className = "status";
    box.textContent = "";

    if (state.loading && !state.data) {
      box.textContent = "Загружаем расписание…";
      box.classList.add("status--muted");
      return;
    }

    if (state.error) {
      box.classList.add("status--error");

      if (state.data) {
        // Данные из кэша — предупреждаем, но показываем расписание
        var age = state.data.cache_age;
        box.textContent = "Нет связи с сервером. Показаны сохранённые данные" +
          (age !== null && age !== undefined ? " (" + core.formatAge(age) + ")" : "") + ".";
      } else {
        box.textContent = "Не удалось загрузить расписание: " + state.error;
      }

      var retry = el("button", "status__retry", "Повторить");
      retry.type = "button";
      retry.addEventListener("click", fetchSchedule);
      box.appendChild(document.createTextNode(" "));
      box.appendChild(retry);
      return;
    }

    if (state.loading) {
      box.textContent = "Обновляем…";
      box.classList.add("status--muted");
      return;
    }

    if (state.data) {
      var when = core.formatAge(state.data.cache_age);
      box.textContent = when ? "Обновлено " + when : "Актуально";
      box.classList.add("status--muted");
    }
  }

  /* ---------- Заметки и дедлайны к парам ---------- */

  var NOTES_KEY = "schedule.notes.v1";
  var notesList = [];
  var noteFilter = "active";
  var openNoteModal = function () {};
  var openNoteFormForSubject = function () {};
  var toggleNote = function () {};
  var deleteNote = function () {};
  var updateNoteBadge = function () {};
  var populateSubjectDatalist = function () {};
  var renderNoteList = function () {};

  function showToast(text, isError) {
    var toast = document.getElementById("appToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "appToast";
      toast.className = "app-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.className = "app-toast" + (isError ? " is-error" : " is-success");
    toast.classList.add("is-visible");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 2800);
  }

  function loadStoredNotes() {
    try {
      var raw = localStorage.getItem(NOTES_KEY);
      if (raw) notesList = JSON.parse(raw) || [];
    } catch (e) {
      notesList = [];
    }
  }

  function saveStoredNotes() {
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notesList));
    } catch (e) {
      console.warn("[notes] ошибка записи в localStorage:", e);
    }
    updateNoteBadge();
    renderNoteList();
  }

  loadStoredNotes();

  /* ---------- ДЗ из Telegram-канала группы ---------- */

  var channelHomeworkList = [];
  var userDoneHomework = {};
  var hwExpandedMap = {};
  var HOMEWORK_CACHE_KEY = "schedule_homework_cache_v1";

  function readStoredHomework() {
    try {
      var raw = localStorage.getItem(HOMEWORK_CACHE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.homework)) {
        channelHomeworkList = parsed.homework;
      }
      if (parsed && Array.isArray(parsed.user_done)) {
        userDoneHomework = {};
        parsed.user_done.forEach(function (id) { userDoneHomework[id] = true; });
      }
    } catch (e) {}
  }

  function writeStoredHomework(homework, user_done) {
    try {
      var doneList = user_done;
      if (!Array.isArray(doneList)) {
        doneList = Object.keys(userDoneHomework).filter(function (k) { return userDoneHomework[k]; });
      }
      localStorage.setItem(HOMEWORK_CACHE_KEY, JSON.stringify({
        at: Date.now(),
        homework: homework || channelHomeworkList,
        user_done: doneList
      }));
    } catch (e) {}
  }

  readStoredHomework();

  function normSubj(s) {
    if (!s) return "";
    return String(s).toLowerCase().replace(/ё/g, "е").replace(/[^\w\sа-яa-z0-9]/gi, " ").replace(/\s+/g, " ").trim();
  }

  function getHomeworkForLesson(lessonSubject, dayDate) {
    if (!lessonSubject || !dayDate || !channelHomeworkList.length) return [];
    var normLesson = normSubj(lessonSubject);
    return channelHomeworkList.filter(function (hw) {
      if (!hw.date || hw.date !== dayDate) return false;
      var normHw = normSubj(hw.subject);
      if (normLesson.indexOf(normHw) !== -1 || normHw.indexOf(normLesson) !== -1) return true;
      var hwWords = normHw.split(" ").filter(function (w) { return w.length > 2; });
      var lessonWords = normLesson.split(" ").filter(function (w) { return w.length > 2; });
      if (!hwWords.length || !lessonWords.length) return false;
      var matches = hwWords.filter(function (hwW) {
        return lessonWords.some(function (lwW) {
          return lwW.indexOf(hwW) !== -1 || hwW.indexOf(lwW) !== -1;
        });
      });
      return matches.length >= Math.min(2, hwWords.length);
    });
  }

  function toggleHomeworkDone(hwId) {
    userDoneHomework[hwId] = !userDoneHomework[hwId];
    writeStoredHomework();
    haptic("light");
    renderDays();

    fetchWithTimeout((apiBase || "") + "/api/homework/toggle", {
      method: "POST",
      headers: chessHeaders(),
      body: JSON.stringify({ id: hwId })
    }, 10000).catch(function () {});
  }

  function openExternal(url, event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (inTelegram && supports("openLink")) {
      try { tg.openLink(url); return; } catch (e) {}
    }
    window.open(url, "_blank");
  }

  function openPhotoModal(src) {
    var overlay = document.getElementById("photoOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "photoOverlay";
      overlay.className = "photo-overlay";
      overlay.innerHTML = '<div class="photo-overlay__backdrop"></div><div class="photo-overlay__body"><img class="photo-overlay__img" src="" /><button class="photo-overlay__close" type="button">✕</button></div>';
      document.body.appendChild(overlay);
      overlay.addEventListener("click", function () { overlay.hidden = true; });
    }
    var img = overlay.querySelector("img");
    if (img) img.src = src;
    overlay.hidden = false;
  }

  function loadChannelHomework() {
    fetchWithRetry((apiBase || "") + "/api/homework", {
      headers: authHeaders()
    }, LOAD_TIMEOUT_MS, 2)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && Array.isArray(data.homework)) {
          var userDone = Array.isArray(data.user_done) ? data.user_done : [];
          writeStoredHomework(data.homework, userDone);
          channelHomeworkList = data.homework;
          userDoneHomework = {};
          userDone.forEach(function (id) { userDoneHomework[id] = true; });
          renderDays();
        }
      })
      .catch(function () {});
  }

  function getNotesForSubject(subject) {
    if (!subject) return [];
    var norm = String(subject).trim().toLowerCase();
    return notesList.filter(function (n) {
      return n.subject && String(n.subject).trim().toLowerCase() === norm;
    });
  }

  function formatDeadline(iso) {
    if (!iso) return null;
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return null;

      var now = new Date();
      var isOverdue = d.getTime() < now.getTime();

      var months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
      var day = d.getDate();
      var month = months[d.getMonth()];
      var hours = ("0" + d.getHours()).slice(-2);
      var minutes = ("0" + d.getMinutes()).slice(-2);
      var timeStr = hours + ":" + minutes;

      var todayStr = core.moscowToday();
      var dueIsoDate = "";
      try {
        dueIsoDate = d.toISOString().split("T")[0];
      } catch (e) {
        dueIsoDate = String(iso).split("T")[0];
      }
      var isToday = dueIsoDate === todayStr;
      var isTomorrow = dueIsoDate === core.addDays(todayStr, 1);

      var text = "";
      if (isOverdue) {
        text = "⚠️ До " + day + " " + month + ", " + timeStr;
      } else if (isToday) {
        text = "⚡ Сегодня в " + timeStr;
      } else if (isTomorrow) {
        text = "⏳ Завтра в " + timeStr;
      } else {
        text = "📅 " + day + " " + month + ", " + timeStr;
      }

      return {
        text: text,
        isOverdue: isOverdue,
        isToday: isToday
      };
    } catch (e) {
      return null;
    }
  }

  function renderDays() {
    var box = document.getElementById("days");
    if (!box) return;

    markActiveSegment();
    box.textContent = "";

    if (state.loading && !state.data) {
      box.appendChild(skeleton());
      return;
    }

    if (!state.data) {
      box.appendChild(emptyState("Расписание пока не загружено."));
      return;
    }

    var view = core.buildView(state.data.days, state.mode, state.data.today);

    if (!view.length) {
      box.appendChild(emptyState("Расписание пустое."));
      return;
    }

    var fragment = document.createDocumentFragment();
    view.forEach(function (day) {
      fragment.appendChild(dayCard(day));
    });
    box.appendChild(fragment);
  }

  function skeleton() {
    var wrap = el("div", "skeleton");
    for (var i = 0; i < 2; i++) {
      var card = el("div", "skeleton__card");

      // Шапка карточки дня: дата и бейдж количества пар
      var head = el("div", "skeleton__head");
      head.appendChild(el("div", "skeleton__pill skeleton__pill--date"));
      head.appendChild(el("div", "skeleton__pill skeleton__pill--badge"));
      card.appendChild(head);

      // 2 пары внутри дня
      for (var j = 0; j < 2; j++) {
        var lesson = el("div", "skeleton__lesson");
        var time = el("div", "skeleton__pill skeleton__pill--time");
        var body = el("div", "skeleton__lesson-body");
        var title = el("div", "skeleton__pill skeleton__pill--title");
        var tags = el("div", "skeleton__tags");
        tags.appendChild(el("div", "skeleton__pill skeleton__pill--tag"));
        tags.appendChild(el("div", "skeleton__pill skeleton__pill--room"));
        body.appendChild(title);
        body.appendChild(tags);
        lesson.appendChild(time);
        lesson.appendChild(body);
        card.appendChild(lesson);
      }

      wrap.appendChild(card);
    }
    return wrap;
  }

  function emptyState(text) {
    var wrap = el("div", "empty");
    wrap.appendChild(el("div", "empty__icon", "🎉"));
    wrap.appendChild(el("div", "empty__text", text));
    return wrap;
  }

  function dayCard(day) {
    var card = el("section", "day");
    if (day.isToday) card.classList.add("day--today");

    var head = el("header", "day__head");

    var left = el("div", "day__titles");
    left.appendChild(el("h2", "day__label", day.label));

    if (day.label !== day.human) {
      left.appendChild(el("div", "day__date", day.human));
    }

    head.appendChild(left);

    var count = day.lessons.length;
    head.appendChild(el(
      "span",
      "day__count",
      count ? count + " " + core.lessonsWord(count) : "нет пар"
    ));

    card.appendChild(head);

    if (day.isEmpty) {
      card.appendChild(el("div", "day__empty", "Пар нет"));
      return card;
    }

    var list = el("div", "lessons");
    day.lessons.forEach(function (lesson) {
      list.appendChild(lessonCard(lesson, day));
    });
    card.appendChild(list);

    return card;
  }

  function lessonCard(lesson, day) {
    var card = el("article", "lesson");

    card.appendChild(el("div", "lesson__time", lesson.time));

    var body = el("div", "lesson__body");

    var headRow = el("div", "lesson__head-row");
    headRow.appendChild(el("h3", "lesson__subject", lesson.subject));

    var addNoteBtn = el("button", "lesson__add-note", "+ Задание");
    addNoteBtn.type = "button";
    addNoteBtn.title = "Добавить задание к этой паре";
    addNoteBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      openNoteFormForSubject(lesson.subject);
    });
    headRow.appendChild(addNoteBtn);

    body.appendChild(headRow);

    var tags = el("div", "lesson__tags");

    var type = el("span", "badge badge--" + core.typeClass(lesson.type), lesson.type);
    tags.appendChild(type);

    if (lesson.room && lesson.room !== "—") {
      tags.appendChild(el("span", "badge badge--room", lesson.room));
    }
    if (lesson.subgroup) {
      tags.appendChild(el("span", "badge badge--room", "подгруппа " + lesson.subgroup));
    }

    body.appendChild(tags);

    if (lesson.teacher && lesson.teacher !== "—") {
      body.appendChild(el("div", "lesson__teacher", lesson.teacher));
    }

    if (lesson.note) {
      body.appendChild(el("div", "lesson__note", "🗓 " + lesson.note));
    }

    var moodle = core.moodleLink(lesson);
    if (moodle) {
      var link = el("a", "lesson__link", "Открыть курс в Moodle");
      link.href = moodle;
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      link.addEventListener("click", function (event) {
        // Внутри Telegram внешние ссылки нужно открывать через SDK,
        // иначе они откроются внутри webview и приложение «потеряется».
        if (inTelegram && supports("openLink")) {
          event.preventDefault();
          try { tg.openLink(moodle); } catch (e) { window.open(moodle, "_blank"); }
        }
      });

      body.appendChild(link);
    }

    // Заметки к этой паре
    var subjectNotes = getNotesForSubject(lesson.subject);
    if (subjectNotes.length > 0) {
      var notesWrap = el("div", "lesson__notes");
      subjectNotes.forEach(function (n) {
        var item = el("div", "lesson__note-item" + (n.done ? " is-done" : ""));

        var check = document.createElement("input");
        check.type = "checkbox";
        check.className = "lesson__note-check";
        check.checked = !!n.done;
        check.title = n.done ? "Отметить невыполненным" : "Отметить выполненным";
        check.addEventListener("click", function (e) {
          e.stopPropagation();
          toggleNote(n.id);
        });

        var content = el("div", "lesson__note-content");
        var textEl = el("span", "lesson__note-text", n.text);
        content.appendChild(textEl);

        if (n.deadline) {
          var due = formatDeadline(n.deadline);
          if (due) {
            var dueEl = el("span", "lesson__note-due" + (due.isOverdue ? " is-overdue" : ""), due.text);
            content.appendChild(dueEl);
          }
        }

        item.appendChild(check);
        item.appendChild(content);

        item.addEventListener("click", function (e) {
          if (e.target !== check) {
            openNoteModal();
          }
        });

        notesWrap.appendChild(item);
      });
      body.appendChild(notesWrap);
    }

    // Домашнее задание из Telegram-канала группы
    if (day && day.date) {
      var channelHw = getHomeworkForLesson(lesson.subject, day.date);
      if (channelHw && channelHw.length > 0) {
        var hwWrap = el("div", "lesson__hw-list");
        channelHw.forEach(function (hw) {
          var isDone = !!userDoneHomework[hw.id];
          var isExpanded = !!hwExpandedMap[hw.id];
          var hwCard = el("div", "lesson__hw" + (isDone ? " is-done" : "") + (isExpanded ? " is-expanded" : " is-collapsed"));

          var hwHead = el("div", "lesson__hw-head");
          hwHead.setAttribute("role", "button");
          hwHead.setAttribute("tabindex", "0");
          hwHead.setAttribute("aria-expanded", isExpanded ? "true" : "false");

          var hwTitleWrap = el("div", "lesson__hw-title-wrap");
          var hwBadge = el("span", "lesson__hw-badge", "📌 Задание");
          hwTitleWrap.appendChild(hwBadge);

          if (hw.deadline_str) {
            var dlBadge = el("span", "lesson__hw-deadline", "❗️Дедлайн: " + hw.deadline_str);
            hwTitleWrap.appendChild(dlBadge);
          }

          var linksCount = (Array.isArray(hw.links) && hw.links.length) || 0;
          var photosCount = (Array.isArray(hw.photos) && hw.photos.length) || 0;
          if (linksCount > 0) {
            var linkBadge = el("span", "lesson__hw-attach-badge", "📎 " + linksCount);
            linkBadge.title = linksCount + " вложений-ссылок";
            hwTitleWrap.appendChild(linkBadge);
          }
          if (photosCount > 0) {
            var photoBadge = el("span", "lesson__hw-attach-badge", "🖼 " + photosCount);
            photoBadge.title = photosCount + " прикрепленных фото";
            hwTitleWrap.appendChild(photoBadge);
          }
          hwHead.appendChild(hwTitleWrap);

          var hwActions = el("div", "lesson__hw-actions");

          var checkWrap = el("label", "lesson__hw-check-label");
          var check = document.createElement("input");
          check.type = "checkbox";
          check.className = "lesson__hw-check";
          check.checked = isDone;
          check.addEventListener("click", function (e) {
            e.stopPropagation();
          });
          check.addEventListener("change", function (e) {
            e.stopPropagation();
            toggleHomeworkDone(hw.id);
          });
          var checkText = el("span", "lesson__hw-check-text", isDone ? "Сделано" : "Сделать");
          checkWrap.appendChild(check);
          checkWrap.appendChild(checkText);
          hwActions.appendChild(checkWrap);

          var chevron = el("span", "lesson__hw-chevron", isExpanded ? "▲" : "▼");
          hwActions.appendChild(chevron);

          hwHead.appendChild(hwActions);
          hwCard.appendChild(hwHead);

          // 1-строчный превью-тизер, если свернуто
          var previewEl = null;
          if (hw.text) {
            var firstLine = hw.text.split("\n")[0].trim();
            if (firstLine) {
              previewEl = el("div", "lesson__hw-preview", firstLine);
              if (isExpanded) previewEl.hidden = true;
              hwCard.appendChild(previewEl);
            }
          }

          // Раскрывающееся тело задания
          var hwBody = el("div", "lesson__hw-body");
          if (!isExpanded) hwBody.hidden = true;

          if (hw.text) {
            var hwText = el("div", "lesson__hw-text", hw.text);
            hwBody.appendChild(hwText);
          }

          // Ссылки
          if (Array.isArray(hw.links) && hw.links.length > 0) {
            var linksWrap = el("div", "lesson__hw-links");
            hw.links.forEach(function (linkItem) {
              var a = el("a", "lesson__hw-link-btn");
              a.href = linkItem.url;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.title = linkItem.title || linkItem.url;

              var iconSpan = el("span", "lesson__hw-link-icon", linkItem.icon || "🔗");
              var titleSpan = el("span", "lesson__hw-link-title", linkItem.title || linkItem.url);
              a.appendChild(iconSpan);
              a.appendChild(titleSpan);

              a.addEventListener("click", function (e) {
                openExternal(linkItem.url, e);
              });

              linksWrap.appendChild(a);
            });
            hwBody.appendChild(linksWrap);
          }

          // Фото
          if (Array.isArray(hw.photos) && hw.photos.length > 0) {
            var photosWrap = el("div", "lesson__hw-photos");
            hw.photos.forEach(function (photo) {
              var photoUrl = photo.proxy_url;
              if (photoUrl && photoUrl.indexOf("http") !== 0) {
                photoUrl = (apiBase || "") + photoUrl;
              }
              var imgWrap = el("div", "lesson__hw-photo-wrap");
              var img = document.createElement("img");
              img.className = "lesson__hw-photo";
              img.src = photoUrl;
              img.alt = "Фото к заданию";
              img.loading = "lazy";
              img.addEventListener("click", function (e) {
                e.stopPropagation();
                openPhotoModal(photoUrl);
              });
              imgWrap.appendChild(img);
              photosWrap.appendChild(imgWrap);
            });
            hwBody.appendChild(photosWrap);
          }

          // Ссылка на оригинальный пост в канале
          if (hw.post_url) {
            var postLink = el("a", "lesson__hw-post-link", "📢 Открыть в канале");
            postLink.href = hw.post_url;
            postLink.target = "_blank";
            postLink.rel = "noopener noreferrer";
            postLink.addEventListener("click", function (e) {
              openExternal(hw.post_url, e);
            });
            hwBody.appendChild(postLink);
          }

          hwCard.appendChild(hwBody);

          // Переключатель сворачивания/разворачивания
          function toggleExpand(e) {
            if (e && (e.target === check || e.target === checkText || e.target === checkWrap)) return;
            var nowExpanded = !hwExpandedMap[hw.id];
            hwExpandedMap[hw.id] = nowExpanded;
            hwCard.classList.toggle("is-expanded", nowExpanded);
            hwCard.classList.toggle("is-collapsed", !nowExpanded);
            hwHead.setAttribute("aria-expanded", nowExpanded ? "true" : "false");
            chevron.textContent = nowExpanded ? "▲" : "▼";
            if (previewEl) previewEl.hidden = nowExpanded;
            hwBody.hidden = !nowExpanded;
            haptic("selection");
          }

          hwHead.addEventListener("click", toggleExpand);
          if (previewEl) {
            previewEl.addEventListener("click", toggleExpand);
          }

          hwWrap.appendChild(hwCard);
        });
        body.appendChild(hwWrap);
      }
    }

    card.appendChild(body);
    return card;
  }

  /* ---------- Рулетка ---------- */

  function prefersReducedMotion() {
    return !!(window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /**
   * Колесо «идти на пары или не идти». Секторы строятся из config.js.
   * Случайность — crypto.getRandomValues через core.randomUnit:
   * Math.random даёт предсказуемую последовательность, а здесь важно,
   * чтобы результат не зависел от предыдущих прокруток.
   */
  function initRoulette() {
    var cfg = window.ROULETTE || {};
    var box = document.getElementById("roulette");
    if (!box || cfg.enabled !== true) return;

    var outcomes = Array.isArray(cfg.outcomes) ? cfg.outcomes.filter(function (o) {
      return o && (o.title || o.short);
    }) : [];

    if (outcomes.length < 2) return;

    var wheel = document.getElementById("rouletteWheel");
    var spinBtn = document.getElementById("rouletteSpin");
    var resultEl = document.getElementById("rouletteResult");
    if (!wheel || !spinBtn || !resultEl) return;

    var count = outcomes.length;
    var span = 360 / count;

    // Длительность прокрутки: держим CSS-переход и таймер результата
    // синхронными, иначе при смене значения они разъедутся.
    // При системной настройке «меньше движения» анимации нет вовсе —
    // инлайновый стиль перебил бы правило из медиазапроса, поэтому
    // отключаем переход прямо здесь.
    var spinMs = Number(cfg.spinMs);
    if (!isFinite(spinMs) || spinMs < 0) spinMs = 2600;

    // Кривая колеса. Разгоняется быстро, а к концу подходит долго и
    // плавно: последний сектор колесо доползает на глазах, вместо
    // того чтобы щёлкнуть и встать. Это easeOutExpo — у него самый
    // длинный «хвост» из распространённых кривых.
    var WHEEL_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

    if (prefersReducedMotion()) {
      wheel.style.transition = "none";
    } else {
      wheel.style.transitionDuration = (spinMs / 1000) + "s";
      wheel.style.transitionTimingFunction = WHEEL_EASE;
    }

    // Секторы колеса
    var stops = outcomes.map(function (o, i) {
      var color = o.color || (i % 2 ? "#e0574f" : "#2fb27c");
      return color + " " + (i * span) + "deg " + ((i + 1) * span) + "deg";
    });
    wheel.style.background = "conic-gradient(" + stops.join(", ") + ")";

    // Надписи: сдвигаем к центру сектора и разворачиваем обратно,
    // иначе текст встал бы боком
    outcomes.forEach(function (o, i) {
      var center = (i + 0.5) * span;

      var label = el("span", "wheel__label");
      if (o.symbol) label.appendChild(el("span", "wheel__emoji", o.symbol));
      label.appendChild(el("span", "wheel__text", o.short || o.title));

      label.style.transform =
        "rotate(" + center + "deg) translateY(-46px) rotate(" + (-center) + "deg)";

      wheel.appendChild(label);
    });

    var rotation = 0;
    var spinning = false;

    function spin() {
      if (spinning) return;
      spinning = true;

      spinBtn.disabled = true;
      resultEl.textContent = "";
      resultEl.className = "roulette__result";

      var index = core.rouletteIndex(core.randomUnit(), count);
      var stop = core.rouletteStopAngle(index, count, core.randomUnit());

      // Докручиваем только вперёд: назад колесо дёргаться не должно
      var current = ((rotation % 360) + 360) % 360;
      var delta = ((stop - current) % 360 + 360) % 360;
      rotation += 360 * 4 + delta;

      wheel.style.transform = "rotate(" + rotation + "deg)";

      setTimeout(function () {
        spinning = false;
        spinBtn.disabled = false;

        var won = outcomes[index];
        resultEl.textContent = (won.symbol ? won.symbol + " " : "") + (won.title || won.short);
        resultEl.classList.add(won.tone === "skip" ? "is-skip" : "is-go");
      }, prefersReducedMotion() ? 0 : spinMs);
    }

    spinBtn.addEventListener("click", spin);
  }

  /* ---------- Шахматы ---------- */

  var CHESS_GAME_KEY = "chess.game";
  var CHESS_POLL_MS = 2500; // ждём хода соперника — опрашиваем часто
  var CHESS_IDLE_MS = 8000; // наш ход — менять состояние можем только мы

  /** Подпись Telegram для заголовка запроса. Вне Telegram пусто. */
  function telegramInitData() {
    return inTelegram && tg && tg.initData ? tg.initData : "";
  }

  /**
   * Только подпись, без типа содержимого.
   *
   * Для GET-запросов: Content-Type там ни к чему и вызывает лишний
   * предварительный запрос OPTIONS.
   */
  function authHeaders() {
    var headers = {};
    var initData = telegramInitData();

    if (initData) headers["X-Telegram-Init-Data"] = initData;
    return headers;
  }

  /**
   * Запрос с пределом ожидания.
   *
   * Бесплатный сервер засыпает без посетителей, и запрос может висеть
   * сколько угодно. Без предела барабаны казино крутились бы вечно,
   * а кнопки молчали бы — со стороны это неотличимо от поломки.
   */
  function fetchWithTimeout(url, options, timeoutMs) {
    var request = options || {};
    var timer = null;

    if (typeof AbortController !== "undefined") {
      var controller = new AbortController();
      request.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || 50000);
    }

    function stop() {
      if (timer) clearTimeout(timer);
    }

    function explain(error) {
      if (error && error.name === "AbortError") {
        var timeout = new Error(
          "Сервер не отвечает. После простоя он просыпается — попробуйте ещё раз"
        );

        // Пометка для повтора: такое имеет смысл повторить, а вот
        // ответ 401 или 403 повторять бессмысленно
        timeout.isTimeout = true;

        return timeout;
      }

      return error;
    }

    return fetch(url, request).then(function (response) {
      // Таймер НЕ гасим на заголовках. Сервер может отдать заголовки,
      // а тело не прислать — тогда разбор ниже зависнет навсегда,
      // и ни then, ни catch не сработают. Именно так барабаны казино
      // крутились бесконечно во второй раз.
      var parse = response.json.bind(response);

      response.json = function () {
        return parse().then(function (data) { stop(); return data; },
                            function (error) { stop(); throw explain(error); });
      };

      return response;
    }, function (error) {
      stop();
      throw explain(error);
    });
  }

  /**
   * Сколько ждём быстрые запросы — список треков, состояние казино,
   * начисление за вход. Сервис теперь не засыпает, поэтому много
   * времени им не нужно.
   */
  var LOAD_TIMEOUT_MS = 15000;

  /**
   * Повторяет запрос, если он не дошёл.
   *
   * Телефон иногда теряет запрос с подписью Telegram: предварительный
   * OPTIONS проходит, а сам запрос не уходит, и обещание висит до
   * предела ожидания. Новый запрос уходит по свежему соединению
   * и обычно срабатывает.
   *
   * Повторяем только безопасное и только то, что имеет смысл повторять:
   * обрыв связи или превышение времени. Ответ 401 или 403 повторять
   * незачем — он не изменится.
   *
   * Прокрут и ходы в шахматы сюда не попадают: их повтор мог бы
   * списать ставку дважды.
   */
  function fetchWithRetry(url, options, timeoutMs, tries) {
    var left = tries || 3;

    return fetchWithTimeout(url, options, timeoutMs).catch(function (error) {
      var worthRetry = error && (error.isTimeout || error.name === "TypeError");

      if (left <= 1 || !worthRetry) throw error;

      // Небольшая пауза: если соединение подвисло, мгновенный повтор
      // попадёт в то же место
      return new Promise(function (resolve) { setTimeout(resolve, 1200); })
        .then(function () {
          return fetchWithRetry(url, options, timeoutMs, left - 1);
        });
    });
  }

  /** Заголовки с подписью Telegram: по ней сервер понимает, кто ходит. */
  function chessHeaders() {
    var headers = { "Content-Type": "application/json" };
    var initData = telegramInitData();

    if (initData) headers["X-Telegram-Init-Data"] = initData;
    return headers;
  }

  /**
   * Запрос к шахматному API.
   *
   * Адрес берём из того же config.js, что и расписание: мини-апп живёт
   * на Netlify, а API — на Render, это разные домены.
   */
  /**
   * Сколько ждём ответа шахматного API.
   *
   * Сервер на бесплатном тарифе засыпает без посетителей, и первый
   * запрос может идти десятки секунд. Без ограничения кнопка осталась
   * бы серой навсегда и без единого объяснения — именно так это
   * и выглядело со стороны.
   */
  var CHESS_TIMEOUT_MS = 50000;

  function chessFetch(path, options) {
    var request = options || {};
    request.headers = chessHeaders();

    return fetchWithTimeout((apiBase || "") + "/api/chess" + path, request,
                            CHESS_TIMEOUT_MS)
      .then(function (response) {
        return response.json().catch(function () {
          return { ok: false, error: "Сервер ответил кодом " + response.status };
        }).then(function (data) {
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || ("Ошибка " + response.status));
          }
          return data;
        });
      })
  }

  function initChess() {
    var cfg = window.CHESS || {};
    var box = document.getElementById("chess");

    if (!box || cfg.enabled === false) return;

    var introEl = document.getElementById("chessIntro");
    var gameEl = document.getElementById("chessGame");
    var boardEl = document.getElementById("chessBoard");
    var turnEl = document.getElementById("chessTurn");
    var errorEl = document.getElementById("chessError");
    var whiteEl = document.getElementById("chessWhite");
    var blackEl = document.getElementById("chessBlack");
    var inviteBtn = document.getElementById("chessInvite");
    var resignBtn = document.getElementById("chessResign");
    var cancelBtn = document.getElementById("chessCancel");
    var againBtn = document.getElementById("chessAgain");
    var newBtn = document.getElementById("chessNew");
    var promoEl = document.getElementById("chessPromo");
    var promoList = document.getElementById("chessPromoList");

    if (!introEl || !gameEl || !boardEl || !newBtn) return;

    var gameId = null;
    var game = null;
    var selected = null;
    var pending = null; // { from, to }, пока выбирают фигуру для превращения
    var cellNodes = [];
    var pollTimer = null;
    var busy = false;
    var menuOpen = false;
    var funOpen = false;

    function showError(message) {
      errorEl.textContent = message || "";
      errorEl.hidden = !message;
    }

    function remember(id) {
      gameId = id;
      try {
        if (id) localStorage.setItem(CHESS_GAME_KEY, id);
        else localStorage.removeItem(CHESS_GAME_KEY);
      } catch (e) {}
    }

    function savedId() {
      try {
        return localStorage.getItem(CHESS_GAME_KEY);
      } catch (e) {
        return null;
      }
    }

    /* ---- отрисовка ---- */

    function buildBoard() {
      boardEl.textContent = "";
      cellNodes = [];

      for (var i = 0; i < 64; i++) {
        var file = i % 8;
        var rank = 7 - Math.floor(i / 8);

        var cell = el("button", "chess__cell");
        cell.type = "button";
        cell.dataset.square = chess.squareName(file, rank);
        cell.addEventListener("click", onCellClick);

        boardEl.appendChild(cell);
        cellNodes.push(cell);
      }
    }

    function renderBoard() {
      if (!game) return;

      var cells = chess.boardCells(game.fen);
      if (!cells) return;

      var targets = selected ? chess.targetsFrom(game.legal, selected) : [];
      var canMove = game.status === "active" && game.you && game.turn === game.you;
      var kingSquare = game.inCheck ? chess.findKing(game.fen, game.turn) : null;

      cells.forEach(function (info, i) {
        var node = cellNodes[i];
        if (!node) return;

        var classes = ["chess__cell", info.light ? "chess__cell--light" : "chess__cell--dark"];

        if (game.lastMove &&
            (game.lastMove.from === info.square || game.lastMove.to === info.square)) {
          classes.push("chess__cell--last");
        }
        if (selected === info.square) classes.push("chess__cell--selected");
        if (targets.indexOf(info.square) >= 0) {
          classes.push(info.code ? "chess__cell--capture" : "chess__cell--target");
        }
        if (kingSquare === info.square) classes.push("chess__cell--check");
        if (info.code) {
          classes.push(chess.isWhitePiece(info.code) ? "chess__cell--white" : "chess__cell--black");
        }

        node.className = classes.join(" ");
        node.textContent = "";

        if (info.code) {
          node.appendChild(el("span", "chess__piece", chess.pieceGlyph(info.code)));

          var owner = chess.isWhitePiece(info.code) ? "белая" : "чёрная";
          node.setAttribute("aria-label",
            info.square + ", " + owner + " " + chess.pieceName(info.code));
        } else {
          node.setAttribute("aria-label", info.square + ", пусто");
        }

        // Нажимать можно свои фигуры и клетки, куда можно пойти
        var mine = canMove && info.code && chess.pieceColor(info.code) === game.you;
        node.disabled = !(mine || targets.indexOf(info.square) >= 0);
      });
    }

    function playerLabel(player, color) {
      return (color === "white" ? "Белые" : "Чёрные") + ": " +
        (player ? player.name : "ждём соперника");
    }

    function render() {
      if (!game) {
        introEl.hidden = false;
        gameEl.hidden = true;
        promoEl.hidden = true;
        return;
      }

      introEl.hidden = true;
      gameEl.hidden = false;

      whiteEl.textContent = playerLabel(game.white, "white");
      blackEl.textContent = playerLabel(game.black, "black");
      whiteEl.classList.toggle("is-turn", game.status === "active" && game.turn === "white");
      blackEl.classList.toggle("is-turn", game.status === "active" && game.turn === "black");

      if (game.status === "waiting") {
        turnEl.textContent = "Ждём соперника — пригласите его";
      } else if (game.status === "finished") {
        var outcome = chess.resultText(game.result, game.you) || "Партия закончена";

        // За победу начисляют тугрики в казино — скажем об этом здесь,
        // чтобы человек не узнавал о награде только из баланса
        var won = game.result === "1-0" && game.you === "white" ||
          game.result === "0-1" && game.you === "black";

        if (won && game.reward) {
          outcome += " · +" + tugriks(game.reward);
        }

        turnEl.textContent = outcome;
      } else if (game.turn === game.you) {
        turnEl.textContent = game.inCheck ? "Ваш ход, вам шах!" : "Ваш ход";
      } else {
        turnEl.textContent = game.inCheck ? "Ход соперника, у него шах" : "Ход соперника";
      }

      inviteBtn.hidden = game.status !== "waiting";
      cancelBtn.hidden = game.status !== "waiting";
      resignBtn.hidden = game.status !== "active";
      againBtn.hidden = game.status !== "finished";

      // Выбранную фигуру сохраняем, если ход всё ещё возможен.
      //
      // Раньше выбор сбрасывался здесь всегда, и фоновый опрос состояния
      // молча снимал его, пока человек думает: клетки теряли подсветку
      // и становились недоступными, нажатие ни к чему не приводило.
      // Проверка по подсказкам надёжна: они приходят с сервера только
      // тому, чей сейчас ход, и только для фигур, которым есть куда пойти.
      if (selected && !chess.targetsFrom(game.legal, selected).length) {
        selected = null;
      }

      renderBoard();
    }

    /* ---- ходы ---- */

    function onCellClick(event) {
      var square = event.currentTarget.dataset.square;

      if (!game || game.status !== "active" || pending) return;
      if (!game.you || game.turn !== game.you) return;

      var cells = chess.boardCells(game.fen) || [];
      var target = null;

      for (var i = 0; i < cells.length; i++) {
        if (cells[i].square === square) {
          target = cells[i];
          break;
        }
      }

      if (selected) {
        if (chess.targetsFrom(game.legal, selected).indexOf(square) >= 0) {
          if (chess.needsPromotion(game.fen, selected, square)) {
            askPromotion(selected, square);
          } else {
            sendMove(selected, square, null);
          }
          return;
        }

        selected = null;
      }

      if (target && target.code && chess.pieceColor(target.code) === game.you &&
          chess.targetsFrom(game.legal, square).length) {
        selected = square;
      }

      renderBoard();
    }

    function askPromotion(from, to) {
      pending = { from: from, to: to };

      promoList.textContent = "";
      ["q", "r", "b", "n"].forEach(function (code) {
        var btn = el("button", "chess__promo-btn", chess.pieceGlyph(code));
        btn.type = "button";
        btn.setAttribute("aria-label", chess.pieceName(code));

        btn.addEventListener("click", function () {
          promoEl.hidden = true;
          var move = pending;
          pending = null;
          if (move) sendMove(move.from, move.to, code);
        });

        promoList.appendChild(btn);
      });

      promoEl.hidden = false;
    }

    function sendMove(from, to, promotion) {
      if (busy || !gameId) return;
      busy = true;

      var body = { from: from, to: to };
      if (promotion) body.promotion = promotion;

      chessFetch("/" + gameId + "/move", { method: "POST", body: JSON.stringify(body) })
        .then(function (data) {
          game = data.game;
          selected = null;
          render();
        })
        .catch(function (error) {
          showError(error.message);
          refresh();
        })
        .then(function () { busy = false; });
    }

    /* ---- сеть ---- */

    function refresh() {
      if (!gameId) return Promise.resolve();

      return chessFetch("/" + gameId).then(function (data) {
        game = data.game;
        render();
      }).catch(function (error) {
        // Партии нет — например, хранилище было в памяти и сервис
        // перезапустился. Тогда честно предлагаем начать заново.
        if (/не найдена/i.test(error.message)) {
          remember(null);
          game = null;
          render();
          showError("Партия больше недоступна — создайте новую");
          return;
        }
        showError(error.message);
      });
    }

    function createGame() {
      if (busy) return;
      busy = true;
      newBtn.disabled = true;

      // Показываем, что нажатие принято: иначе на медленном сервере
      // кажется, что кнопка не работает
      newBtn.textContent = "Создаю партию…";
      showError("");

      chessFetch("/new", { method: "POST" })
        .then(function (data) {
          remember(data.game.id);
          game = data.game;
          render();
          maybePoll();
        })
        .catch(function (error) { showError(error.message); })
        .then(function () {
          busy = false;
          newBtn.disabled = false;
          newBtn.textContent = "Создать партию";
        });
    }

    function joinGame(id) {
      chessFetch("/" + id + "/join", { method: "POST" })
        .then(function (data) {
          remember(id);
          game = data.game;
          render();
          maybePoll();
        })
        .catch(function (error) {
          // Уже участник или место занято — показываем состояние как есть
          remember(id);
          return refresh().then(function () {
            maybePoll();
            showError(error.message);
          });
        });
    }

    function invite() {
      if (!gameId) return;

      var bot = (window.CHESS && window.CHESS.bot) || "";
      var link = "https://t.me/" + bot + "?start=" + gameId;
      var share = "https://t.me/share/url?url=" + encodeURIComponent(link) +
        "&text=" + encodeURIComponent("Сыграем в шахматы?");

      if (inTelegram && supports("openTelegramLink")) {
        try { tg.openTelegramLink(share); return; } catch (e) {}
      }

      window.open(share, "_blank");
    }

    /**
     * Отменяет партию, к которой никто не присоединился.
     *
     * Без этого случайно созданная партия оставалась навсегда: выйти
     * из неё в приложении было нечем.
     */
    function cancelGame() {
      if (busy || !gameId) return;
      busy = true;
      cancelBtn.disabled = true;

      chessFetch("/" + gameId + "/cancel", { method: "POST" })
        .then(function () {
          stopPolling();
          remember(null);
          game = null;
          render();
        })
        .catch(function (error) { showError(error.message); })
        .then(function () {
          busy = false;
          cancelBtn.disabled = false;
        });
    }

    function resign() {
      if (busy || !gameId) return;
      busy = true;

      chessFetch("/" + gameId + "/resign", { method: "POST" })
        .then(function (data) {
          game = data.game;
          render();
        })
        .catch(function (error) { showError(error.message); })
        .then(function () { busy = false; });
    }

    /* ---- опрос ---- */

    function stopPolling() {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    /**
     * Включает опрос, если он вообще нужен.
     *
     * Вызывать нужно после каждого изменения состояния: партия могла
     * появиться уже после открытия меню, и тогда прежний запуск опроса
     * молча выходил ни с чем — из-за этого приложение не замечало
     * присоединившегося соперника.
     */
    /**
     * Как часто спрашивать сервер.
     *
     * Когда ждём хода соперника — часто: изменения появятся именно там.
     * Когда ход наш — редко: состояние меняем только мы сами (разве что
     * соперник сдастся). Так расход команд Upstash падает почти вдвое,
     * а на бесплатном тарифе это 10 000 в сутки.
     */
    function pollDelay() {
      var waitingForOpponent = game && game.status === "active" &&
        game.you && game.turn !== game.you;

      return waitingForOpponent ? CHESS_POLL_MS : CHESS_IDLE_MS;
    }

    var chessModal = document.getElementById("chessModal");
    var chessCard = document.getElementById("gameCardChess");
    var chessClose = document.getElementById("chessModalClose");
    var chessBackdrop = document.getElementById("chessModalBackdrop");
    var chessOpen = false;

    /** Доска видна, только когда открыта модальная арена шахмат. */
    function boardVisible() {
      return chessOpen && chessModal && !chessModal.hidden;
    }

    function openChessModal() {
      if (chessModal) chessModal.hidden = false;
      chessOpen = true;
      haptic("light");
      refresh().then(maybePoll);
    }

    function closeChessModal() {
      if (chessModal) chessModal.hidden = true;
      chessOpen = false;
      stopPolling();
    }

    if (chessCard) chessCard.addEventListener("click", openChessModal);
    if (chessClose) chessClose.addEventListener("click", closeChessModal);
    if (chessBackdrop) chessBackdrop.addEventListener("click", closeChessModal);

    function maybePoll() {
      stopPolling();
      if (!boardVisible() || !gameId || !game) return;

      // Перезапускаем таймер каждый раз, а не setInterval: задержка
      // зависит от состояния и должна меняться на ходу
      pollTimer = setTimeout(function tick() {
        if (document.visibilityState === "visible") refresh();
        pollTimer = boardVisible() && gameId && game
          ? setTimeout(tick, pollDelay())
          : null;
      }, pollDelay());
    }

    onVisibilityChange(function (isVisible) {
      if (isVisible && boardVisible()) refresh().then(maybePoll);
      else stopPolling();
    });

    /* ---- запуск ---- */

    buildBoard();

    newBtn.addEventListener("click", createGame);
    inviteBtn.addEventListener("click", invite);
    cancelBtn.addEventListener("click", cancelGame);
    resignBtn.addEventListener("click", resign);
    againBtn.addEventListener("click", createGame);

    // Ссылка-приглашение выглядит как ?game=<id>
    var invited = null;
    try {
      invited = new URLSearchParams(location.search).get("game");
    } catch (e) {}

    if (invited) {
      openChessModal();
      joinGame(invited);
    } else {
      var saved = savedId();
      if (saved) {
        remember(saved);
        refresh();
      } else {
        render();
      }
    }
  }

  /* ---------- Меню ---------- */

  // Кому сообщать об открытии и закрытии меню. Нужно шахматам:
  // опрашивать соперника имеет смысл, только пока доска на экране.
  var menuHandlers = [];

  function onMenuToggle(handler) {
    menuHandlers.push(handler);
  }

  function notifyMenu(open) {
    menuHandlers.forEach(function (handler) {
      try {
        handler(open);
      } catch (e) {
        console.warn("[menu] обработчик упал:", e && e.message);
      }
    });
  }

  // Кому сообщать о раскрытии «Приколов». Нужно шахматам: опрашивать
  // соперника имеет смысл, только когда доска действительно на экране.
  var funHandlers = [];

  function onFunToggle(handler) {
    funHandlers.push(handler);
  }

  function notifyFun(open) {
    funHandlers.forEach(function (handler) {
      try {
        handler(open);
      } catch (e) {
        console.warn("[fun] обработчик упал:", e && e.message);
      }
    });
  }

  /**
   * Раскрывающийся раздел «Приколы».
   *
   * По умолчанию свёрнут: меню длинное, и развлечения в нём тонули.
   * Состояние не запоминаем — при следующем открытии снова свёрнуто,
   * иначе смысл прятать теряется.
   */
  function initFun() {
    var toggle = document.getElementById("funToggle");
    var content = document.getElementById("funContent");

    if (!toggle || !content) return;

    function setOpen(open) {
      content.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      notifyFun(open);
    }

    toggle.addEventListener("click", function () {
      setOpen(content.hidden);
    });
  }

  /**
   * Меню выезжает справа. Разделы расписания переключают вкладку
   * на основной странице и закрывают меню.
   */
  function initMenu() {
    var menu = document.getElementById("menu");
    var backdrop = document.getElementById("menuBackdrop");
    var openBtn = document.getElementById("menuBtn");
    var closeBtn = document.getElementById("menuClose");
    var nav = document.getElementById("menuNav");

    if (!menu || !openBtn) return;

    function open() {
      menu.hidden = false;
      if (backdrop) backdrop.hidden = false;
      openBtn.setAttribute("aria-expanded", "true");
      markActive();
      notifyMenu(true);
    }

    function close() {
      menu.hidden = true;
      if (backdrop) backdrop.hidden = true;
      openBtn.setAttribute("aria-expanded", "false");
      notifyMenu(false);
    }

    /** Подсвечиваем раздел, который сейчас показан на экране. */
    function markActive() {
      if (!nav) return;

      Array.prototype.forEach.call(nav.children, function (btn) {
        btn.classList.toggle("is-active", btn.dataset.mode === state.mode);
      });
    }

    if (nav) {
      Array.prototype.forEach.call(nav.children, function (btn) {
        btn.addEventListener("click", function () {
          state.mode = btn.dataset.mode;
          renderSegments();
          renderDays();
          close();
        });
      });
    }

    openBtn.addEventListener("click", function () {
      if (menu.hidden) open();
      else close();
    });

    if (closeBtn) closeBtn.addEventListener("click", close);
    if (backdrop) backdrop.addEventListener("click", close);

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !menu.hidden) close();
    });

    // Меню открыто — значит разделы нужно подсвечивать при каждом показе
    menu.dataset.ready = "1";
  }

  /**
   * Netlify добавляет в правый нижний угол плашку «Powered by Netlify»
   * (iframe #nl-badge-frame) с максимальным z-index. Она показывается
   * всем посетителям и перекрывает низ экрана. Отключить её стоит
   * в настройках проекта, но приложение должно работать и с ней:
   * измеряем высоту и оставляем под расписанием место.
   */
  function watchNetlifyBadge() {
    function measure() {
      var badge = document.getElementById("nl-badge-frame");
      var height = 0;

      if (badge) {
        var rect = badge.getBoundingClientRect();
        height = rect.height || 0;
      }

      document.documentElement.style.setProperty("--badge-offset", height + "px");
      document.body.classList.toggle("has-netlify-badge", height > 0);

      return height > 0;
    }

    /** Пересчитываем при изменении размеров: плашка «устаивается» не сразу. */
    function follow(badge) {
      measure();

      if (typeof ResizeObserver === "function") {
        try {
          new ResizeObserver(measure).observe(badge);
          return;
        } catch (e) {}
      }

      [300, 1000, 3000].forEach(function (delay) {
        setTimeout(measure, delay);
      });
    }

    if (measure()) {
      var existing = document.getElementById("nl-badge-frame");
      if (existing) follow(existing);
      return;
    }

    if (typeof MutationObserver !== "function") return;

    var observer = new MutationObserver(function () {
      var badge = document.getElementById("nl-badge-frame");
      if (!badge) return;

      observer.disconnect();
      follow(badge);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(function () {
      observer.disconnect();
      measure();
    }, 20000);
  }

  /* ---------- Запуск ---------- */

  function bindRefresh() {
    var btn = document.getElementById("refresh");
    if (!btn) return;

    btn.addEventListener("click", function () {
      btn.classList.add("is-spinning");
      loadChannelHomework();
      fetchSchedule().then(function () {
        setTimeout(function () { btn.classList.remove("is-spinning"); }, 400);
      });
    });
  }

  var visibilityHandlers = [];
  function onVisibilityChange(fn) {
    if (typeof fn === "function") visibilityHandlers.push(fn);
  }

  /** Обновляем данные, если приложение вернулось на экран спустя время. */
  function bindVisibility() {
    document.addEventListener("visibilitychange", function () {
      var isVisible = document.visibilityState === "visible";
      document.body.classList.toggle("is-page-hidden", !isVisible);

      visibilityHandlers.forEach(function (h) {
        try { h(isVisible); } catch (e) {}
      });

      if (!isVisible) return;
      loadChannelHomework();
      if (!state.data || !state.data.cache_age) return;

      if (state.data.cache_age * 1000 > CACHE_TTL) fetchSchedule();
    });
  }

  /* ---------- Техподдержка ---------- */

  /**
   * Кнопка внизу страницы и сообщение по ней.
   *
   * Это шутка, поэтому сообщение закрывается крестиком и больше ничего
   * не делает: никаких ссылок и переходов.
   */
  function initSupport() {
    var btn = document.getElementById("supportBtn");
    var toast = document.getElementById("supportToast");
    var close = document.getElementById("supportClose");

    if (!btn || !toast || !close) return;

    function hide() {
      toast.hidden = true;
    }

    btn.addEventListener("click", function () {
      toast.hidden = false;
    });

    close.addEventListener("click", hide);

    // Escape закрывает — привычно для всплывающих сообщений
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !toast.hidden) hide();
    });
  }

  /* ---------- Казино ---------- */

  /**
   * «100 тугриков», «3 тугрика» — числительное с верным окончанием.
   *
   * Просто подставить слово нельзя: 1 тугрик, 2 тугрика, 5 тугриков.
   */
  function tugriks(n) {
    var value = Number(n) || 0;
    return value + " " + core.plural(value, "тугрик", "тугрика", "тугриков");
  }


  var CASINO_BET_KEY = "casino.bet";
  var CASINO_CYCLE_MS = 70;
  var CASINO_MIN_SPIN_MS = 1500;

  // Состояние игрока и то, что начислили при этом запуске
  var casinoPlayer = null;
  var casinoWelcome = null;

  // Единая синхронизация баланса игрока (тугриков) по всему приложению
  var globalUserBalance = null;
  var balanceSubscribers = [];

  function onBalanceUpdate(callback) {
    if (typeof callback === "function") {
      balanceSubscribers.push(callback);
      if (globalUserBalance !== null) {
        try { callback(globalUserBalance); } catch (e) {}
      }
    }
  }

  function getEffectiveBalance() {
    if (typeof globalUserBalance === "number") {
      return globalUserBalance;
    }
    if (casinoPlayer && typeof casinoPlayer.balance === "number") {
      return casinoPlayer.balance;
    }
    return 0;
  }

  function syncCasinoBalance(newBal) {
    if (typeof newBal !== "number" || isNaN(newBal)) return;
    newBal = Math.max(0, Math.floor(newBal));
    globalUserBalance = newBal;
    if (casinoPlayer) {
      casinoPlayer.balance = newBal;
    }
    if (typeof casinoRender === "function") {
      casinoRender();
    }
    for (var i = 0; i < balanceSubscribers.length; i++) {
      try {
        balanceSubscribers[i](newBal);
      } catch (err) {
        console.warn("[balance listener error]", err);
      }
    }
  }

  // Перерисовку ставит initCasino: тугрики за вход могут прийти как
  // до, так и после того, как раздел построен
  var casinoRender = null;

  /**
   * Монеты за сегодняшний вход.
   *
   * Зовётся при каждом запуске приложения: сервер сам решает, начислять
   * или нет, поэтому повторный вызов в тот же день безвреден — иначе
   * пришлось бы хранить отметку на клиенте, а её легко потерять.
   */
  /**
   * Показывает уведомление о подарке.
   *
   * Текст приходит с сервера: он же решает, положен ли подарок.
   * Если сервер вернул null, сюда просто не заходят.
   */
  function showGift(gift) {
    var box = document.getElementById("giftBox");
    var amount = document.getElementById("giftAmount");
    var text = document.getElementById("giftText");
    var ok = document.getElementById("giftOk");

    if (!box || !amount || !text || !ok) return;

    amount.textContent = "+" + tugriks(gift.amount);
    text.textContent = gift.text || "";
    box.hidden = false;

    function hide() {
      box.hidden = true;
      ok.removeEventListener("click", hide);
      box.removeEventListener("click", onBackdrop);
    }

    function onBackdrop(event) {
      if (event.target === box) hide();
    }

    ok.addEventListener("click", hide);
    box.addEventListener("click", onBackdrop);
  }

  function casinoClaimDaily() {
    fetchWithRetry((apiBase || "") + "/api/casino/claim", {
      method: "POST",
      headers: authHeaders(),
    }, LOAD_TIMEOUT_MS, 3)
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || data.ok !== true) return;

        casinoPlayer = data.player;
        if (data.player && typeof data.player.balance === "number") {
          syncCasinoBalance(data.player.balance);
          try {
            localStorage.setItem("schedule_casino_player_v1", JSON.stringify(data.player));
          } catch (e) {}
        }

        // Сервер сам решает, положен ли подарок: приходит только
        // при первом входе, дальше там null
        if (data.gift) showGift(data.gift);

        if (data.gained > 0) {
          casinoWelcome = { gained: data.gained, bonus: data.bonus || 0 };
        }

        if (typeof casinoRender === "function") casinoRender();
      })
      .catch(function (error) {
        console.warn("[casino] тугрики за вход не начислены:", error && error.message);
      });
  }

  function initCasino() {
    var box = document.getElementById("casino");
    if (!box) return;

    var balanceEl = document.getElementById("casinoBalance");
    var unitEl = document.getElementById("casinoUnit");
    var streakEl = document.getElementById("casinoStreak");
    var reelsBox = document.getElementById("casinoReels");
    var resultEl = document.getElementById("casinoResult");
    var ownInput = document.getElementById("casinoOwnBet");
    var ownOk = document.getElementById("casinoOwnOk");
    var spinBtn = document.getElementById("casinoSpin");

    if (!balanceEl || !reelsBox || !spinBtn || !ownInput || !ownOk) return;

    var reelEls = Array.prototype.slice.call(reelsBox.querySelectorAll(".reel"));
    var glyphs = {};
    var bet = 10;
    var spinning = false;
    var cycleTimer = null;
    var reelsFilled = false;

    try {
      var saved = parseInt(localStorage.getItem(CASINO_BET_KEY), 10);
      if (isFinite(saved) && saved > 0) bet = saved;
    } catch (e) {}

    function glyph(key) {
      return glyphs[key] || "❔";
    }

    /** Случайный символ для мелькания. Результат определяет сервер. */
    function flickerGlyph() {
      var keys = Object.keys(glyphs);
      if (!keys.length) return "❔";
      return glyphs[keys[Math.floor(Math.random() * keys.length)]];
    }

    function showNote(text, tone) {
      if (!text) {
        resultEl.textContent = "";
        resultEl.className = "casino__result";
        return;
      }

      resultEl.textContent = text;
      resultEl.className = "casino__result " + (tone || "");
    }

    function streakText(player) {
      var need = player.streakForBonus - player.streak;

      if (player.streak > 0 && need <= 0) {
        return "Серия " + player.streak + " дн. · в воскресенье бонус " +
          tugriks(player.sundayBonus);
      }

      if (player.streak > 0) {
        return "Серия " + player.streak + " " +
          core.plural(player.streak, "день", "дня", "дней") +
          " · до бонуса " + need;
      }

      return "Заходите каждый день · за неделю без пропусков бонус " +
        tugriks(player.sundayBonus);
    }

    /**
     * Настраивает поле ставки.
     *
     * Готовых сумм больше нет: сумму задаёт сам игрок. Границы берём
     * с сервера, чтобы подсказка совпадала с тем, что он примет.
     */
    function renderBets() {
      if (!casinoPlayer || !ownInput) return;

      ownInput.placeholder = "от " + (casinoPlayer.minBet || 10) +
        " до " + (casinoPlayer.maxBet || 100000);
      ownInput.value = String(bet);
    }

    /**
     * Ставит свою сумму.
     *
     * Границы берём с сервера: он всё равно зажмёт ставку в них,
     * но лучше показать человеку, что именно получилось, чем
     * молча списать другое.
     */
    function applyOwnBet() {
      if (spinning || !casinoPlayer || !ownInput) return;

      var raw = (ownInput.value || "").replace(/[^0-9]/g, "");
      if (!raw) {
        showNote("Введите сумму ставки", "is-error");
        return;
      }

      var wanted = parseInt(raw, 10);
      var low = casinoPlayer.minBet || 10;
      var high = casinoPlayer.maxBet || 100000;
      var value = Math.max(low, Math.min(high, wanted));

      bet = value;
      try {
        localStorage.setItem(CASINO_BET_KEY, String(value));
      } catch (e) {}

      ownInput.value = String(value);
      showNote(value === wanted
        ? "Ставка " + tugriks(value)
        : "Ставка " + tugriks(value) + " — границы от " + low + " до " + high,
        value === wanted ? "is-hint" : "is-error");

      render();
    }

    function render() {
      if (!casinoPlayer) return;

      // Символы приходят с сервера: список и выплаты должны совпадать
      casinoPlayer.symbols.forEach(function (symbol) {
        glyphs[symbol.key] = symbol.emoji;
      });

      renderBets();

      balanceEl.textContent = casinoPlayer.balance;

      // Окончание зависит от числа: 1 тугрик, 2 тугрика, 5 тугриков
      if (unitEl) {
        unitEl.textContent = core.plural(
          casinoPlayer.balance, "тугрик", "тугрика", "тугриков");
      }

      streakEl.textContent = streakText(casinoPlayer);

      // Пока не крутили, на барабанах стоит заглушка из разметки.
      // Заменяем её символами из набора сервера: иначе на автомате
      // висел бы символ, которого в игре нет. Берём разные, чтобы
      // это не выглядело выигрышной линией.
      if (!reelsFilled) {
        reelEls.forEach(function (reel, i) {
          var symbol = casinoPlayer.symbols[i % casinoPlayer.symbols.length];
          reel.querySelector(".reel__symbol").textContent = symbol.emoji;
        });
        reelsFilled = true;
      }

      // Во время прокрута поле ставки недоступно, как и кнопка
      if (ownInput) ownInput.disabled = spinning;
      if (ownOk) ownOk.disabled = spinning;

      var enough = casinoPlayer.balance >= bet;
      spinBtn.disabled = spinning || !enough;
      spinBtn.textContent = spinning ? "Дэпаем…" : (enough ? "Дэпнуть" : "Не хватает тугриков");

      // Приветствие за вход показываем один раз и до результата
      if (casinoWelcome && !spinning) {
        var text = "+" + tugriks(casinoWelcome.gained) + " за вход";
        if (casinoWelcome.bonus) {
          text += " · бонус за неделю +" + tugriks(casinoWelcome.bonus);
        }
        showNote(text, "is-win");
        casinoWelcome = null;
      }
    }

    function stopAndLand(reels) {
      reelEls.forEach(function (reel, i) {
        setTimeout(function () {
          reel.classList.remove("is-spinning");
          reel.querySelector(".reel__symbol").textContent = glyph(reels[i]);
        }, i * 170);
      });
    }

    function showResult(result) {
      if (result.multiplier >= 10) {
        haptic("success");
        showNote("Джекпот! +" + tugriks(result.win), "is-jackpot");
      } else if (result.multiplier > 1) {
        haptic("success");
        showNote("Выигрыш +" + tugriks(result.win), "is-win");
      } else if (result.multiplier === 1) {
        haptic("light");
        showNote("Ставка вернулась", "is-lose");
      } else {
        haptic("light");
        showNote("Мимо", "is-lose");
      }
    }

    function spin() {
      if (spinning) return;

      // Состояние ещё не пришло — молчать нельзя, иначе нажатие
      // выглядит как поломка
      if (!casinoPlayer) {
        showNote("Ждём ответа сервера — попробуйте через пару секунд");
        return;
      }

      if (casinoPlayer.balance < bet) {
        showNote("Не хватает тугриков — заходите завтра за новыми", "is-error");
        return;
      }

      haptic("medium");
      spinning = true;
      showNote("");
      render();

      reelEls.forEach(function (reel) { reel.classList.add("is-spinning"); });

      cycleTimer = setInterval(function () {
        reelEls.forEach(function (reel) {
          reel.querySelector(".reel__symbol").textContent = flickerGlyph();
        });
      }, CASINO_CYCLE_MS);

      var started = Date.now();

      // Если сервер просыпается, барабаны крутятся долго и это
      // выглядит как поломка — скажем словами, что происходит
      var wakeTimer = setTimeout(function () {
        if (spinning) showNote("Сервер просыпается — это может занять до минуты");
      }, 5000);

      fetchWithTimeout((apiBase || "") + "/api/casino/spin", {
        method: "POST",
        headers: chessHeaders(),
        body: JSON.stringify({ bet: bet }),
      })
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (!data || data.ok !== true) {
            throw new Error((data && data.error) || "Сервер не ответил");
          }

          casinoPlayer = data.player;
          if (data.player && typeof data.player.balance === "number") {
            syncCasinoBalance(data.player.balance);
          }
          var result = data.result;

          // Мгновенный результат выглядит как подделка, поэтому даём
          // барабанам покрутиться хотя бы полторы секунды
          var wait = Math.max(0, CASINO_MIN_SPIN_MS - (Date.now() - started));

          setTimeout(function () {
            clearTimeout(wakeTimer);
            clearInterval(cycleTimer);
            cycleTimer = null;

            stopAndLand(result.reels);
            showResult(result);

            setTimeout(function () {
              spinning = false;
              render();
            }, 700);
          }, wait);
        })
        .catch(function (error) {
          clearTimeout(wakeTimer);
          clearInterval(cycleTimer);
          cycleTimer = null;

          reelEls.forEach(function (reel) { reel.classList.remove("is-spinning"); });
          showNote(error.message, "is-error");

          spinning = false;
          render();
        });
    }

    var CASINO_CACHE_KEY = "schedule_casino_player_v1";
    var casinoLoaded = false;

    function readCasinoCache() {
      try {
        var raw = localStorage.getItem(CASINO_CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    function writeCasinoCache(player) {
      try {
        localStorage.setItem(CASINO_CACHE_KEY, JSON.stringify(player));
      } catch (e) {}
    }

    if (!casinoPlayer) {
      var cachedPlayer = readCasinoCache();
      if (cachedPlayer) {
        casinoPlayer = cachedPlayer;
        if (typeof casinoPlayer.balance === "number") {
          syncCasinoBalance(casinoPlayer.balance);
        }
      }
    }

    function loadState(force) {
      if (casinoLoaded && !force) return Promise.resolve();
      return fetchWithRetry((apiBase || "") + "/api/casino", { headers: authHeaders() },
                            LOAD_TIMEOUT_MS, 3)
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (!data || data.ok !== true) return;
          casinoLoaded = true;
          casinoPlayer = data.player;
          if (data.player && typeof data.player.balance === "number") {
            syncCasinoBalance(data.player.balance);
            writeCasinoCache(data.player);
          }
          render();
        })
        .catch(function (error) {
          console.warn("[casino] состояние не загрузилось:", error && error.message);
        });
    }

    casinoRender = render;

    // Своя сумма: по кнопке и по Enter в поле
    if (ownOk) ownOk.addEventListener("click", applyOwnBet);

    if (ownInput) {
      ownInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          applyOwnBet();
        }
      });
    }

    spinBtn.addEventListener("click", function () {
      if (!casinoLoaded) loadState(true);
      spin();
    });

    var casinoModal = document.getElementById("casinoModal");
    var casinoCard = document.getElementById("gameCardCasino");
    var casinoClose = document.getElementById("casinoModalClose");
    var casinoBackdrop = document.getElementById("casinoModalBackdrop");

    function openCasinoModal() {
      if (casinoModal) casinoModal.hidden = false;
      haptic("light");
      loadState(true);
    }

    function closeCasinoModal() {
      if (casinoModal) casinoModal.hidden = true;
    }

    if (casinoCard) casinoCard.addEventListener("click", openCasinoModal);
    if (casinoClose) casinoClose.addEventListener("click", closeCasinoModal);
    if (casinoBackdrop) casinoBackdrop.addEventListener("click", closeCasinoModal);

    if (casinoPlayer) render();
  }

  /* ---------- Секретный пароль ---------- */

  /**
   * Точка под кнопкой техподдержки: пароль даёт тугрики в казино.
   *
   * Проверяет пароль сервер. Если бы сверял браузер, любой посмотрел бы
   * исходники и получил тугрики без пароля — а в них ещё и лежит сам
   * ответ, что сводит секрет к нулю.
   */
  function initPromo() {
    var button = document.getElementById("promoBtn");
    var form = document.getElementById("promoForm");
    var input = document.getElementById("promoInput");
    var submit = document.getElementById("promoSubmit");
    var note = document.getElementById("promoNote");

    if (!button || !form || !input || !submit || !note) return;

    function showNote(text, tone) {
      note.textContent = text || "";
      note.className = "promo__note" + (tone ? " " + tone : "");
    }

    button.addEventListener("click", function () {
      form.hidden = !form.hidden;

      if (!form.hidden) {
        showNote("");
        input.focus();
      }
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var password = input.value.trim();
      if (!password) {
        showNote("Введите пароль", "is-error");
        return;
      }

      submit.disabled = true;
      showNote("Проверяю…");

      fetchWithTimeout((apiBase || "") + "/api/casino/promo", {
        method: "POST",
        headers: chessHeaders(),
        body: JSON.stringify({ password: password }),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            return { data: data };
          });
        })
        .then(function (result) {
          submit.disabled = false;

          if (!result.data || result.data.ok !== true) {
            showNote((result.data && result.data.error) || "Не получилось", "is-error");
            return;
          }

          showNote("+" + tugriks(result.data.gained) + " на счёт", "is-done");
          input.value = "";

          // Баланс в казино изменился — покажем это сразу
          if (result.data.player) {
            casinoPlayer = result.data.player;
            if (typeof result.data.player.balance === "number") {
              syncCasinoBalance(result.data.player.balance);
            } else if (typeof casinoRender === "function") {
              casinoRender();
            }
          }
        })
        .catch(function () {
          submit.disabled = false;
          showNote("Сеть недоступна — попробуйте ещё раз", "is-error");
        });
    });
  }

  /* ---------- Окно «что нового» ---------- */

  // Ключ с версией: чтобы показать следующий анонс, достаточно поднять
  // номер — отметка о прежнем не помешает
  var WHATS_NEW_KEY = "app.whatsnew.v1";

  /**
   * Окно с рассказом об обновлении.
   *
   * Показывается один раз. Рассылку в боте сделать нельзя: список
   * пользователей лежит на эфемерном диске Render и теряется при
   * каждом перезапуске, так что писать было бы некому. Окно в
   * приложении надёжнее — его увидят все, кто зайдёт.
   */
  function initWhatsNew() {
    var box = document.getElementById("whatsNew");
    var close = document.getElementById("whatsNewClose");

    if (!box || !close) return;

    var seen = false;
    try {
      seen = localStorage.getItem(WHATS_NEW_KEY) === "1";
    } catch (e) {}

    if (seen) return;

    function hide() {
      box.hidden = true;
      try {
        localStorage.setItem(WHATS_NEW_KEY, "1");
      } catch (e) {}
    }

    close.addEventListener("click", hide);

    // Тап по затемнению и Escape закрывают — привычно для окна
    box.addEventListener("click", function (event) {
      if (event.target === box) hide();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !box.hidden) hide();
    });

    // Небольшая задержка: пусть сначала отрисуется расписание,
    // иначе окно накроет пустой экран
    setTimeout(function () {
      box.hidden = false;
    }, 700);
  }

  /* ---------- ППРСД shop ---------- */

  /**
   * Магазин: обмен тугриков на подарки.
   *
   * Товар и баланс приходят с сервера, покупка уходит туда же.
   * Имя и контакт обязательны: без них заказ некому передать,
   * поэтому проверяет и клиент, и сервер.
   */
  function initShop() {
    var box = document.getElementById("shop");
    var list = document.getElementById("shopList");
    var form = document.getElementById("shopForm");
    var nameInput = document.getElementById("shopName");
    var contactInput = document.getElementById("shopContact");
    var submitBtn = document.getElementById("shopSubmit");
    var cancelBtn = document.getElementById("shopCancel");
    var note = document.getElementById("shopNote");

    if (!box || !list || !form || !nameInput || !contactInput || !submitBtn || !note) {
      return;
    }

    var products = [];
    var balance = 0;
    var chosen = null;
    var busy = false;

    function showNote(text, tone) {
      note.textContent = text || "";
      note.className = "shop__note" + (tone ? " " + tone : "");
    }

    function render() {
      list.textContent = "";

      products.forEach(function (item) {
        var card = document.createElement("div");
        card.className = "shop__card";

        var title = document.createElement("div");
        title.className = "shop__title";
        title.textContent = item.title;

        var nominal = document.createElement("div");
        nominal.className = "shop__nominal";
        nominal.textContent = "Номинал " + item.nominal + " ₽ · " + (item.note || "");

        if (!item.available) {
          var out = document.createElement("div");
          out.className = "shop__out";
          out.textContent = "Нет в наличии";
          card.appendChild(out);
        }

        var row = document.createElement("div");
        row.className = "shop__price-row";

        var price = document.createElement("span");
        price.className = "shop__price";
        price.textContent = tugriks(item.price);

        var left = document.createElement("span");
        left.className = "shop__balance";
        left.textContent = "у вас " + tugriks(balance);

        row.appendChild(price);
        row.appendChild(left);

        var buy = document.createElement("button");
        buy.className = "shop__buy";
        buy.type = "button";

        if (!item.available) {
          // Товар показываем, но купить нельзя. Сервер отклонит
          // покупку и в обход кнопки, здесь — чтобы не предлагать зря
          buy.textContent = "Нет в наличии";
          buy.disabled = true;
          buy.classList.add("is-out");
        } else {
          buy.textContent = balance >= item.price ? "Купить" : "Не хватает тугриков";
          buy.disabled = balance < item.price;
          buy.addEventListener("click", function () { openForm(item); });
        }

        card.appendChild(title);
        card.appendChild(nominal);
        card.appendChild(row);
        card.appendChild(buy);
        list.appendChild(card);
      });
    }

    function openForm(item) {
      chosen = item;
      form.hidden = false;
      showNote("");
      nameInput.focus();
    }

    function closeForm() {
      chosen = null;
      form.hidden = true;
      form.reset();
    }

    function load() {
      fetchWithRetry((apiBase || "") + "/api/shop", { headers: authHeaders() },
                     LOAD_TIMEOUT_MS, 3)
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (!data || data.ok !== true) return;

          products = data.products || [];
          balance = typeof data.balance === "number" ? data.balance : (balance || 0);
          if (typeof data.balance === "number") {
            syncCasinoBalance(data.balance);
          }
          render();
        })
        .catch(function (error) {
          showNote("Магазин не загрузился: " + (error && error.message ? error.message : "нет связи"), "is-error");
        });
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      if (busy || !chosen) return;

      var name = nameInput.value.trim();
      var contact = contactInput.value.trim();

      if (!name) {
        showNote("Укажите ваше имя", "is-error");
        nameInput.focus();
        return;
      }

      if (!contact) {
        showNote("Укажите ваш ID или ник в Telegram", "is-error");
        contactInput.focus();
        return;
      }

      busy = true;
      submitBtn.disabled = true;
      showNote("Покупаем…", "is-hint");

      fetchWithRetry((apiBase || "") + "/api/shop/buy", {
        method: "POST",
        headers: chessHeaders(),
        body: JSON.stringify({
          productId: chosen.id,
          name: name,
          contact: contact,
        }),
      }, LOAD_TIMEOUT_MS, 1)
        .then(function (response) { return response.json(); })
        .then(function (data) {
          busy = false;
          submitBtn.disabled = false;

          if (!data || data.ok !== true) {
            showNote((data && data.error) || "Не получилось", "is-error");
            return;
          }

          if (data.player && typeof data.player.balance === "number") {
            balance = data.player.balance;
            syncCasinoBalance(data.player.balance);
          } else if (typeof data.balance === "number") {
            balance = data.balance;
            syncCasinoBalance(data.balance);
          } else {
            balance = data.player ? data.player.balance : balance;
          }
          closeForm();
          render();
          showNote("Готово! Заказ " + data.order.id + " принят, с вами свяжутся.", "is-done");
        })
        .catch(function (error) {
          busy = false;
          submitBtn.disabled = false;
          showNote(error && error.message ? error.message : "Нет связи", "is-error");
        });
    });

    if (cancelBtn) cancelBtn.addEventListener("click", closeForm);

    onBalanceUpdate(function (bal) {
      balance = bal;
      render();
    });

    var shopLoaded = false;
    function loadOnce() {
      if (shopLoaded) return;
      shopLoaded = true;
      load();
    }

    onMenuToggle(function (open) {
      if (open) loadOnce();
    });
  }

  /* ---------- Таблица лидеров ---------- */

  function initLeaderboard() {
    var btn = document.getElementById("casinoLeaderboardBtn");
    var modal = document.getElementById("leaderboardModal");
    var backdrop = document.getElementById("leaderboardBackdrop");
    var closeBtn = document.getElementById("leaderboardClose");
    var list = document.getElementById("leaderboardList");
    var foot = document.getElementById("leaderboardFoot");

    if (!btn || !modal || !list) return;

    function open() {
      modal.hidden = false;
      list.innerHTML = '<div class="leaderboard__loading">Загрузка рейтинга…</div>';
      if (foot) foot.innerHTML = "";
      haptic("light");

      fetchWithRetry((apiBase || "") + "/api/casino/leaderboard", {
        headers: authHeaders()
      }, LOAD_TIMEOUT_MS, 2)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || data.ok !== true) {
            list.innerHTML = '<div class="leaderboard__empty">Не удалось загрузить рейтинг</div>';
            return;
          }

          var leaders = data.leaders || [];
          var you = data.you || null;

          if (leaders.length === 0) {
            list.innerHTML = '<div class="leaderboard__empty">Пока нет участников</div>';
            return;
          }

          list.innerHTML = "";
          leaders.forEach(function (item, idx) {
            var row = document.createElement("div");
            row.className = "leaderboard__item";
            if (you && String(item.user_id) === String(you.user_id)) {
              row.classList.add("is-you");
            }

            var rankBadge = "#" + (idx + 1);
            if (idx === 0) rankBadge = "🥇";
            else if (idx === 1) rankBadge = "🥈";
            else if (idx === 2) rankBadge = "🥉";

            var rankEl = document.createElement("span");
            rankEl.className = "leaderboard__rank";
            rankEl.textContent = rankBadge;

            var infoEl = document.createElement("div");
            infoEl.className = "leaderboard__info";

            var nameEl = document.createElement("div");
            nameEl.className = "leaderboard__name";
            nameEl.textContent = item.name || "Аноним";
            if (you && String(item.user_id) === String(you.user_id)) {
              nameEl.textContent += " (Вы)";
            }

            var extraEl = document.createElement("div");
            extraEl.className = "leaderboard__extra";
            if (item.streak > 0) {
              extraEl.textContent = "🔥 Серия: " + item.streak + " " + core.plural(item.streak, "день", "дня", "дней");
            }

            infoEl.appendChild(nameEl);
            if (item.streak > 0) infoEl.appendChild(extraEl);

            var balanceEl = document.createElement("span");
            balanceEl.className = "leaderboard__balance";
            balanceEl.textContent = tugriks(item.balance);

            row.appendChild(rankEl);
            row.appendChild(infoEl);
            row.appendChild(balanceEl);
            list.appendChild(row);
          });

          if (foot && you) {
            var rankStr = you.rank ? ("Ваше место: #" + you.rank + " • ") : "";
            foot.textContent = rankStr + "Баланс: " + tugriks(you.balance);
          }
        })
        .catch(function (err) {
          list.innerHTML = '<div class="leaderboard__empty">Ошибка загрузки: ' + (err && err.message ? err.message : "нет связи") + '</div>';
        });
    }

    function close() {
      modal.hidden = true;
    }

    btn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (backdrop) backdrop.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) close();
    });
  }

  /* ---------- Крестики-нолики 3х3 ---------- */

  var TTT_GAME_KEY = "ttt.game";
  var TTT_POLL_MS = 2000;
  var TTT_IDLE_MS = 6000;

  function tttFetch(path, options) {
    var request = options || {};
    request.headers = chessHeaders();

    return fetchWithTimeout((apiBase || "") + "/api/ttt" + path, request,
                            CHESS_TIMEOUT_MS)
      .then(function (response) {
        return response.json().catch(function () {
          return { ok: false, error: "Сервер ответил кодом " + response.status };
        }).then(function (data) {
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || ("Ошибка " + response.status));
          }
          return data;
        });
      });
  }

  function initTTT() {
    var box = document.getElementById("ttt");
    if (!box) return;

    var modeSoloBtn = document.getElementById("tttModeSolo");
    var modeMultiBtn = document.getElementById("tttModeMulti");
    var soloBox = document.getElementById("tttSoloBox");
    var multiBox = document.getElementById("tttMultiBox");

    var soloStatus = document.getElementById("tttSoloStatus");
    var soloBoard = document.getElementById("tttSoloBoard");
    var soloReset = document.getElementById("tttSoloReset");
    var soloCells = soloBoard ? Array.prototype.slice.call(soloBoard.querySelectorAll(".ttt__cell")) : [];

    var multiIntro = document.getElementById("tttMultiIntro");
    var multiGame = document.getElementById("tttMultiGame");
    var multiNewBtn = document.getElementById("tttMultiNew");
    var multiPlayerX = document.getElementById("tttPlayerX");
    var multiPlayerO = document.getElementById("tttPlayerO");
    var multiStatus = document.getElementById("tttMultiStatus");
    var multiBoard = document.getElementById("tttMultiBoard");
    var multiInviteBtn = document.getElementById("tttMultiInvite");
    var multiResignBtn = document.getElementById("tttMultiResign");
    var multiAgainBtn = document.getElementById("tttMultiAgain");
    var multiError = document.getElementById("tttMultiError");
    var multiCells = multiBoard ? Array.prototype.slice.call(multiBoard.querySelectorAll(".ttt__cell")) : [];

    /* --- Переключение режимов --- */
    function switchMode(mode) {
      if (mode === "solo") {
        if (modeSoloBtn) modeSoloBtn.classList.add("is-active");
        if (modeMultiBtn) modeMultiBtn.classList.remove("is-active");
        if (soloBox) soloBox.hidden = false;
        if (multiBox) multiBox.hidden = true;
      } else {
        if (modeSoloBtn) modeSoloBtn.classList.remove("is-active");
        if (modeMultiBtn) modeMultiBtn.classList.add("is-active");
        if (soloBox) soloBox.hidden = true;
        if (multiBox) multiBox.hidden = false;
        maybePollMulti();
      }
    }

    if (modeSoloBtn) modeSoloBtn.addEventListener("click", function () { switchMode("solo"); });
    if (modeMultiBtn) modeMultiBtn.addEventListener("click", function () { switchMode("multi"); });

    /* --- Линии победы --- */
    var WIN_LINES = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6]
    ];

    function checkWinner(board) {
      for (var i = 0; i < WIN_LINES.length; i++) {
        var line = WIN_LINES[i];
        var a = board[line[0]];
        var b = board[line[1]];
        var c = board[line[2]];
        if (a && a === b && a === c) {
          return { winner: a, line: line };
        }
      }
      var full = board.every(function (c) { return c !== null && c !== ""; });
      if (full) return { winner: null, draw: true };
      return null;
    }

    /* === ОДИНОЧНЫЙ РЕЖИМ (С БОТОМ) === */
    var soloState = [null, null, null, null, null, null, null, null, null];
    var soloTurn = "X";
    var soloOver = false;

    function renderSolo() {
      soloCells.forEach(function (cell, idx) {
        var val = soloState[idx];
        cell.textContent = val || "";
        cell.classList.remove("is-x", "is-o", "is-winner");
        if (val === "X") cell.classList.add("is-x");
        if (val === "O") cell.classList.add("is-o");
        cell.disabled = !!val || soloOver || soloTurn !== "X";
      });
    }

    function resetSolo() {
      soloState = [null, null, null, null, null, null, null, null, null];
      soloTurn = "X";
      soloOver = false;
      if (soloStatus) {
        soloStatus.textContent = "Ваш ход (X)";
        soloStatus.className = "ttt__status";
      }
      renderSolo();
    }

    function soloBotMove() {
      if (soloOver) return;

      var chosen = -1;

      // 1. Попытка выиграть (O) или блокировать игрока (X)
      var checkSymbols = ["O", "X"];
      for (var s = 0; s < checkSymbols.length; s++) {
        var sym = checkSymbols[s];
        for (var i = 0; i < WIN_LINES.length; i++) {
          var line = WIN_LINES[i];
          var a = soloState[line[0]], b = soloState[line[1]], c = soloState[line[2]];
          var count = (a === sym ? 1 : 0) + (b === sym ? 1 : 0) + (c === sym ? 1 : 0);
          var empties = line.filter(function (idx) { return !soloState[idx]; });
          if (count === 2 && empties.length === 1) {
            chosen = empties[0];
            break;
          }
        }
        if (chosen !== -1) break;
      }

      // 2. Центр, затем углы, затем случайная
      if (chosen === -1) {
        if (!soloState[4]) {
          chosen = 4;
        } else {
          var corners = [0, 2, 6, 8].filter(function (idx) { return !soloState[idx]; });
          if (corners.length > 0) {
            chosen = corners[Math.floor(Math.random() * corners.length)];
          } else {
            var left = [];
            for (var k = 0; k < 9; k++) {
              if (!soloState[k]) left.push(k);
            }
            if (left.length > 0) chosen = left[Math.floor(Math.random() * left.length)];
          }
        }
      }

      if (chosen !== -1) {
        soloState[chosen] = "O";
        var res = checkWinner(soloState);
        if (res) {
          soloOver = true;
          if (res.winner === "O") {
            if (soloStatus) {
              soloStatus.textContent = "Бот победил! 🤖";
              soloStatus.className = "ttt__status is-over";
            }
            if (res.line) {
              res.line.forEach(function (idx) {
                if (soloCells[idx]) soloCells[idx].classList.add("is-winner");
              });
            }
            haptic("warning");
          } else if (res.draw) {
            if (soloStatus) {
              soloStatus.textContent = "Ничья! 🤝";
              soloStatus.className = "ttt__status is-over";
            }
            haptic("light");
          }
        } else {
          soloTurn = "X";
          if (soloStatus) soloStatus.textContent = "Ваш ход (X)";
        }
      }
      renderSolo();
    }

    function onSoloCellClick(e) {
      if (soloOver || soloTurn !== "X") return;
      var idx = parseInt(e.currentTarget.dataset.idx, 10);
      if (isNaN(idx) || soloState[idx]) return;

      soloState[idx] = "X";
      haptic("light");
      renderSolo();

      var res = checkWinner(soloState);
      if (res) {
        soloOver = true;
        if (res.winner === "X") {
          if (soloStatus) {
            soloStatus.textContent = "Победа! 🎉 +25 тугриков";
            soloStatus.className = "ttt__status is-over";
          }
          if (res.line) {
            res.line.forEach(function (i) {
              if (soloCells[i]) soloCells[i].classList.add("is-winner");
            });
          }
          haptic("success");

          tttFetch("/solo_reward", { method: "POST" })
            .then(function (data) {
              if (data && data.player) {
                casinoPlayer = data.player;
                if (typeof data.player.balance === "number") {
                  syncCasinoBalance(data.player.balance);
                } else if (typeof casinoRender === "function") {
                  casinoRender();
                }
              }
            })
            .catch(function () {});
        } else if (res.draw) {
          if (soloStatus) {
            soloStatus.textContent = "Ничья! 🤝";
            soloStatus.className = "ttt__status is-over";
          }
          haptic("light");
        }
        renderSolo();
        return;
      }

      soloTurn = "O";
      if (soloStatus) soloStatus.textContent = "Ход бота (O)…";
      renderSolo();

      setTimeout(soloBotMove, 400);
    }

    soloCells.forEach(function (cell) {
      cell.addEventListener("click", onSoloCellClick);
    });
    if (soloReset) soloReset.addEventListener("click", resetSolo);

    /* === СЕТЕВОЙ МУЛЬТИПЛЕЕР === */
    var multiGameId = null;
    var multiGameData = null;
    var multiPollTimer = null;
    var multiBusy = false;

    function rememberMulti(id) {
      multiGameId = id;
      try {
        if (id) localStorage.setItem(TTT_GAME_KEY, id);
        else localStorage.removeItem(TTT_GAME_KEY);
      } catch (e) {}
    }

    function savedMultiId() {
      try { return localStorage.getItem(TTT_GAME_KEY); } catch (e) { return null; }
    }

    function showMultiError(msg) {
      if (!multiError) return;
      multiError.hidden = !msg;
      multiError.textContent = msg || "";
    }

    function renderMulti() {
      if (!multiGameData) {
        if (multiIntro) multiIntro.hidden = false;
        if (multiGame) multiGame.hidden = true;
        return;
      }

      if (multiIntro) multiIntro.hidden = true;
      if (multiGame) multiGame.hidden = false;

      var g = multiGameData;
      var you = g.you;

      if (multiPlayerX) {
        multiPlayerX.textContent = "❌ " + (g.player_x ? g.player_x.name : "Ожидание…");
        multiPlayerX.classList.toggle("is-turn", g.turn === "X" && g.status === "active");
      }
      if (multiPlayerO) {
        multiPlayerO.textContent = "⭕ " + (g.player_o ? g.player_o.name : "Ожидание…");
        multiPlayerO.classList.toggle("is-turn", g.turn === "O" && g.status === "active");
      }

      var board = g.board || ["", "", "", "", "", "", "", "", ""];
      multiCells.forEach(function (cell, idx) {
        var val = board[idx] || "";
        cell.textContent = val;
        cell.classList.remove("is-x", "is-o", "is-winner");
        if (val === "X") cell.classList.add("is-x");
        if (val === "O") cell.classList.add("is-o");

        var canMove = g.status === "active" && g.turn === you && !val && !multiBusy;
        cell.disabled = !canMove;
      });

      if (multiInviteBtn) multiInviteBtn.hidden = true;
      if (multiResignBtn) multiResignBtn.hidden = true;
      if (multiAgainBtn) multiAgainBtn.hidden = true;

      if (multiStatus) {
        if (g.status === "waiting") {
          multiStatus.textContent = "Ожидание соперника… Отправьте ссылку!";
          if (multiInviteBtn) multiInviteBtn.hidden = false;
        } else if (g.status === "active") {
          if (multiResignBtn) multiResignBtn.hidden = !you;
          if (g.turn === you) {
            multiStatus.textContent = "Ваш ход (" + you + ")!";
          } else {
            var opp = you === "X" ? "O" : "X";
            multiStatus.textContent = "Ходит соперник (" + opp + ")…";
          }
        } else if (g.status === "finished") {
          if (multiAgainBtn) multiAgainBtn.hidden = false;
          if (g.winner === "draw") {
            multiStatus.textContent = "Ничья! 🤝";
          } else if (g.winner === you) {
            multiStatus.textContent = "Вы победили! 🏆 +100 тугриков";
          } else if (you) {
            multiStatus.textContent = "Победил соперник (" + g.winner + ")";
          } else {
            multiStatus.textContent = "Партия завершена. Победитель: " + g.winner;
          }

          var winCheck = checkWinner(board);
          if (winCheck && winCheck.line) {
            winCheck.line.forEach(function (i) {
              if (multiCells[i]) multiCells[i].classList.add("is-winner");
            });
          }
        }
      }
    }

    function stopPollingMulti() {
      if (multiPollTimer) {
        clearTimeout(multiPollTimer);
        multiPollTimer = null;
      }
    }

    function maybePollMulti() {
      stopPollingMulti();
      if (!multiGameId || !multiGameData) return;
      if (multiGameData.status === "finished") return;

      var delay = (multiGameData.status === "active" && multiGameData.turn !== multiGameData.you)
        ? TTT_POLL_MS
        : TTT_IDLE_MS;

      multiPollTimer = setTimeout(function tick() {
        if (document.visibilityState === "visible") {
          refreshMulti();
        }
        if (multiGameId && multiGameData && multiGameData.status !== "finished") {
          multiPollTimer = setTimeout(tick, delay);
        }
      }, delay);
    }

    function refreshMulti() {
      if (!multiGameId) return Promise.resolve();
      return tttFetch("/" + multiGameId)
        .then(function (data) {
          var prevTurn = multiGameData ? multiGameData.turn : null;
          var prevStatus = multiGameData ? multiGameData.status : null;
          multiGameData = data.game;
          renderMulti();
          if (multiGameData.status === "active" && multiGameData.turn === multiGameData.you && prevTurn !== multiGameData.turn) {
            haptic("selection");
          }
          if (multiGameData.status === "finished" && prevStatus !== "finished") {
            if (multiGameData.winner === multiGameData.you) haptic("success");
            else haptic("light");
          }
        })
        .catch(function (err) {
          showMultiError(err.message);
        });
    }

    function createMultiGame() {
      if (multiBusy) return;
      multiBusy = true;
      if (multiNewBtn) {
        multiNewBtn.disabled = true;
        multiNewBtn.textContent = "Создаю партию…";
      }
      showMultiError("");

      tttFetch("/new", { method: "POST" })
        .then(function (data) {
          rememberMulti(data.game.id);
          multiGameData = data.game;
          renderMulti();
          maybePollMulti();
        })
        .catch(function (err) {
          showMultiError(err.message);
        })
        .then(function () {
          multiBusy = false;
          if (multiNewBtn) {
            multiNewBtn.disabled = false;
            multiNewBtn.textContent = "Создать партию";
          }
        });
    }

    function joinMultiGame(id) {
      showMultiError("");
      tttFetch("/" + id + "/join", { method: "POST" })
        .then(function (data) {
          rememberMulti(id);
          multiGameData = data.game;
          renderMulti();
          maybePollMulti();
        })
        .catch(function (err) {
          rememberMulti(id);
          refreshMulti().then(function () {
            maybePollMulti();
            showMultiError(err.message);
          });
        });
    }

    function inviteMulti() {
      if (!multiGameId) return;
      var bot = (window.TTT && window.TTT.bot) || (window.CHESS && window.CHESS.bot) || "pprsd23_bot";
      var link = "https://t.me/" + bot + "?start=ttt_" + multiGameId;
      var share = "https://t.me/share/url?url=" + encodeURIComponent(link) +
        "&text=" + encodeURIComponent("Сыграем в крестики-нолики? За победу — 100 тугриков!");

      if (inTelegram && supports("openTelegramLink")) {
        try { tg.openTelegramLink(share); return; } catch (e) {}
      }
      window.open(share, "_blank");
    }

    function resignMulti() {
      if (multiBusy || !multiGameId) return;
      multiBusy = true;
      tttFetch("/" + multiGameId + "/resign", { method: "POST" })
        .then(function (data) {
          multiGameData = data.game;
          renderMulti();
        })
        .catch(function (err) { showMultiError(err.message); })
        .then(function () { multiBusy = false; });
    }

    function onMultiCellClick(e) {
      if (multiBusy || !multiGameId || !multiGameData) return;
      if (multiGameData.status !== "active" || multiGameData.turn !== multiGameData.you) return;

      var idx = parseInt(e.currentTarget.dataset.idx, 10);
      if (isNaN(idx)) return;

      multiBusy = true;
      haptic("light");

      tttFetch("/" + multiGameId + "/move", {
        method: "POST",
        body: JSON.stringify({ cell: idx })
      })
        .then(function (data) {
          multiGameData = data.game;
          renderMulti();
          maybePollMulti();
          if (data.game.status === "finished" && data.game.winner === data.game.you) {
            haptic("success");
          }
        })
        .catch(function (err) {
          showMultiError(err.message);
        })
        .then(function () {
          multiBusy = false;
          renderMulti();
        });
    }

    multiCells.forEach(function (cell) {
      cell.addEventListener("click", onMultiCellClick);
    });

    if (multiNewBtn) multiNewBtn.addEventListener("click", createMultiGame);
    if (multiInviteBtn) multiInviteBtn.addEventListener("click", inviteMulti);
    if (multiResignBtn) multiResignBtn.addEventListener("click", resignMulti);
    if (multiAgainBtn) multiAgainBtn.addEventListener("click", function () {
      rememberMulti(null);
      multiGameData = null;
      renderMulti();
    });

    var tttModal = document.getElementById("tttModal");
    var tttCard = document.getElementById("gameCardTTT");
    var tttClose = document.getElementById("tttModalClose");
    var tttBackdrop = document.getElementById("tttModalBackdrop");

    function openTTTModal() {
      if (tttModal) tttModal.hidden = false;
      haptic("light");
    }

    function closeTTTModal() {
      if (tttModal) tttModal.hidden = true;
      stopPollingMulti();
    }

    if (tttCard) tttCard.addEventListener("click", openTTTModal);
    if (tttClose) tttClose.addEventListener("click", closeTTTModal);
    if (tttBackdrop) tttBackdrop.addEventListener("click", closeTTTModal);

    var invitedTTT = null;
    try {
      invitedTTT = new URLSearchParams(location.search).get("ttt");
    } catch (e) {}

    if (invitedTTT) {
      switchMode("multi");
      joinMultiGame(invitedTTT);
      openTTTModal();
    } else {
      var saved = savedMultiId();
      if (saved) {
        multiGameId = saved;
        refreshMulti();
      }
    }

    renderSolo();
  }

  /* ---------- Block Blast (Взрыв блоков) ---------- */

  function initBlockBlast() {
    var launchCard = document.getElementById("bbLaunchCard");
    var playBtn = document.getElementById("bbPlayBtn");
    var menuBestVal = document.getElementById("bbMenuBestVal");

    var arenaModal = document.getElementById("bbArenaModal");
    var arenaBackdrop = document.getElementById("bbArenaBackdrop");
    var arenaClose = document.getElementById("bbArenaClose");
    var arenaReset = document.getElementById("bbArenaReset");

    if (!arenaModal) return;

    var gameInstance = null;

    function updateMenuBest() {
      if (menuBestVal && window.BlockBlast) {
        menuBestVal.textContent = window.BlockBlast.getBestScore().toLocaleString();
      }
    }
    updateMenuBest();

    function openArena() {
      arenaModal.hidden = false;
      haptic("light");

      if (!gameInstance && window.BlockBlast) {
        gameInstance = window.BlockBlast.initGame({
          board: document.getElementById("bbBoard"),
          rack: document.getElementById("bbRack"),
          scoreVal: document.getElementById("bbScoreVal"),
          bestVal: document.getElementById("bbBestVal"),
          comboPill: document.getElementById("bbComboPill"),
          comboText: document.getElementById("bbComboText"),
          particles: document.getElementById("bbParticles"),
          gameOverModal: document.getElementById("bbGameOverModal"),
          overScore: document.getElementById("bbOverScore"),
          overLines: document.getElementById("bbOverLines"),
          overMaxCombo: document.getElementById("bbOverMaxCombo"),
          overReward: document.getElementById("bbOverReward"),
          overRewardRow: document.getElementById("bbOverRewardRow"),
          overRestartBtn: document.getElementById("bbOverRestartBtn"),
          resetBtn: arenaReset
        }, {
          apiBase: apiBase,
          authHeaders: authHeaders,
          onScoreUpdate: function (best) {
            if (menuBestVal) menuBestVal.textContent = best.toLocaleString();
          },
          onReward: function (coins, newBalance) {
            if (typeof newBalance === "number") {
              syncCasinoBalance(newBalance);
            }
          }
        });
      }
    }

    function closeArena() {
      arenaModal.hidden = true;
      updateMenuBest();
    }

    var gameCardBB = document.getElementById("gameCardBB");
    if (gameCardBB) gameCardBB.addEventListener("click", openArena);
    if (playBtn) playBtn.addEventListener("click", openArena);
    if (launchCard) {
      launchCard.addEventListener("click", function (e) {
        if (e.target !== playBtn) openArena();
      });
    }
    if (arenaClose) arenaClose.addEventListener("click", closeArena);
    if (arenaBackdrop) arenaBackdrop.addEventListener("click", closeArena);
  }

  /* ---------- Заметки и задания к парам ---------- */

  function initNotes() {
    loadStoredNotes();

    var addBtn = document.getElementById("addNoteBtn");
    var menuNotesBtn = document.getElementById("menuNotesBtn");
    var modal = document.getElementById("noteModal");
    var backdrop = document.getElementById("noteModalBackdrop");
    var closeBtn = document.getElementById("noteModalClose");

    var tabList = document.getElementById("noteTabList");
    var tabForm = document.getElementById("noteTabForm");
    var tabCount = document.getElementById("noteTabCount");

    var form = document.getElementById("noteForm");
    var subjectInput = document.getElementById("noteSubjectInput");
    var textInput = document.getElementById("noteTextInput");
    var dateInput = document.getElementById("noteDateInput");
    var timeInput = document.getElementById("noteTimeInput");
    var chipToday = document.getElementById("noteChipToday");
    var chipTomorrow = document.getElementById("noteChipTomorrow");
    var chipWeek = document.getElementById("noteChipWeek");
    var chipClear = document.getElementById("noteChipClear");
    var cancelBtn = document.getElementById("noteCancelBtn");

    var listWrap = document.getElementById("noteListWrap");
    var listEl = document.getElementById("noteList");
    var filterBtns = document.querySelectorAll(".notelist__filter");

    if (!modal) return;

    function openModal() {
      modal.hidden = false;
      showTab("list");
      populateSubjectDatalist();
      renderNoteList();
      haptic("light");
    }

    function closeModal() {
      modal.hidden = true;
    }

    function showTab(tab) {
      if (tab === "form") {
        if (tabForm) tabForm.classList.add("is-active");
        if (tabList) tabList.classList.remove("is-active");
        if (form) form.hidden = false;
        if (listWrap) listWrap.hidden = true;
        if (textInput) textInput.focus();
      } else {
        if (tabForm) tabForm.classList.remove("is-active");
        if (tabList) tabList.classList.add("is-active");
        if (form) form.hidden = true;
        if (listWrap) listWrap.hidden = false;
        renderNoteList();
      }
    }

    openNoteModal = openModal;
    openNoteFormForSubject = function (subj) {
      modal.hidden = false;
      showTab("form");
      if (subjectInput) subjectInput.value = subj || "";
      if (textInput) textInput.focus();
      haptic("light");
    };

    toggleNote = function (id) {
      for (var i = 0; i < notesList.length; i++) {
        if (notesList[i].id === id) {
          notesList[i].done = !notesList[i].done;
          haptic("light");
          break;
        }
      }
      saveStoredNotes();
      renderDays();

      fetchWithTimeout((apiBase || "") + "/api/notes/toggle", {
        method: "POST",
        headers: chessHeaders(),
        body: JSON.stringify({ id: id })
      }, 10000).catch(function () {});
    };

    deleteNote = function (id) {
      notesList = notesList.filter(function (n) { return n.id !== id; });
      saveStoredNotes();
      renderDays();
      renderNoteList();
      showToast("Задание удалено");
      haptic("warning");

      fetchWithTimeout((apiBase || "") + "/api/notes/" + id, {
        method: "DELETE",
        headers: chessHeaders()
      }, 10000).catch(function () {});
    };

    function renderNoteListImpl() {
      if (!listEl) return;

      var activeCount = notesList.filter(function (n) { return !n.done; }).length;
      if (tabCount) tabCount.textContent = activeCount > 0 ? "(" + activeCount + ")" : "";

      var filtered = notesList.filter(function (n) {
        if (noteFilter === "active") return !n.done;
        if (noteFilter === "done") return n.done;
        return true;
      });

      if (filtered.length === 0) {
        var msg = noteFilter === "done" ? "Выполненных заданий пока нет." :
                  noteFilter === "active" ? "Все задания выполнены! Отличная работа 🎉" :
                  "Заметок пока нет. Нажмите «+ Новая заметка», чтобы записать задание к паре.";
        listEl.innerHTML = '<div class="notelist__empty"><div class="notelist__empty-icon">📝</div>' + msg + '</div>';
        return;
      }

      listEl.innerHTML = "";
      filtered.forEach(function (n) {
        var card = document.createElement("div");
        card.className = "note-item" + (n.done ? " is-done" : "");

        var check = document.createElement("input");
        check.type = "checkbox";
        check.className = "note-item__checkbox";
        check.checked = !!n.done;
        check.title = n.done ? "Отметить невыполненным" : "Отметить выполненным";
        check.addEventListener("change", function (e) {
          e.stopPropagation();
          toggleNote(n.id);
        });

        var body = document.createElement("div");
        body.className = "note-item__body";

        var top = document.createElement("div");
        top.className = "note-item__top";

        var subj = document.createElement("span");
        subj.className = "note-item__subject";
        subj.textContent = n.subject || "Общая заметка";
        top.appendChild(subj);

        if (n.deadline) {
          var due = formatDeadline(n.deadline);
          if (due) {
            var dueEl = document.createElement("span");
            dueEl.className = "note-item__deadline" + (due.isOverdue ? " is-overdue" : "") + (due.isToday ? " is-today" : "");
            dueEl.textContent = due.text;
            top.appendChild(dueEl);
          }
        }

        body.appendChild(top);

        var textEl = document.createElement("div");
        textEl.className = "note-item__text";
        textEl.textContent = n.text;
        body.appendChild(textEl);

        var delBtn = document.createElement("button");
        delBtn.className = "note-item__delete";
        delBtn.type = "button";
        delBtn.setAttribute("aria-label", "Удалить");
        delBtn.title = "Удалить задание";
        delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
        delBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          deleteNote(n.id);
        });

        card.appendChild(check);
        card.appendChild(body);
        card.appendChild(delBtn);
        listEl.appendChild(card);
      });

      var hasDone = notesList.some(function (n) { return n.done; });
      if (hasDone && (noteFilter === "all" || noteFilter === "done")) {
        var clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "notelist__clear-done";
        clearBtn.textContent = "🗑 Очистить выполненные задания";
        clearBtn.addEventListener("click", function () {
          var toRemove = notesList.filter(function (n) { return n.done; });
          notesList = notesList.filter(function (n) { return !n.done; });
          saveStoredNotes();
          renderDays();
          renderNoteList();
          showToast("Выполненные задания очищены");
          haptic("warning");
          toRemove.forEach(function (n) {
            fetchWithTimeout((apiBase || "") + "/api/notes/" + n.id, {
              method: "DELETE",
              headers: chessHeaders()
            }, 10000).catch(function () {});
          });
        });
        listEl.appendChild(clearBtn);
      }
    }

    renderNoteList = renderNoteListImpl;

    updateNoteBadge = function () {
      var badge = document.getElementById("noteBadge");
      if (!badge) return;
      var activeCount = notesList.filter(function (n) { return !n.done; }).length;
      badge.hidden = activeCount === 0;
    };

    populateSubjectDatalist = function () {
      var datalist = document.getElementById("noteSubjectList");
      if (!datalist || !state.data || !state.data.days) return;
      var subjects = {};
      state.data.days.forEach(function (d) {
        if (d.lessons) {
          d.lessons.forEach(function (l) {
            if (l.subject && l.subject.trim()) subjects[l.subject.trim()] = true;
          });
        }
      });
      datalist.innerHTML = "";
      Object.keys(subjects).sort().forEach(function (s) {
        var opt = document.createElement("option");
        opt.value = s;
        datalist.appendChild(opt);
      });
    };

    if (addBtn) {
      addBtn.addEventListener("click", function () {
        modal.hidden = false;
        if (notesList.length === 0) showTab("form");
        else showTab("list");
        populateSubjectDatalist();
        haptic("light");
      });
    }

    if (menuNotesBtn) {
      menuNotesBtn.addEventListener("click", function () {
        var menuClose = document.getElementById("menuClose");
        if (menuClose) menuClose.click();
        openModal();
      });
    }

    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (backdrop) backdrop.addEventListener("click", closeModal);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closeModal();
    });

    if (tabList) tabList.addEventListener("click", function () { showTab("list"); });
    if (tabForm) tabForm.addEventListener("click", function () { showTab("form"); });

    if (chipToday) {
      chipToday.addEventListener("click", function () {
        dateInput.value = core.moscowToday();
        if (!timeInput.value) timeInput.value = "18:00";
        haptic("selection");
      });
    }
    if (chipTomorrow) {
      chipTomorrow.addEventListener("click", function () {
        dateInput.value = core.addDays(core.moscowToday(), 1);
        if (!timeInput.value) timeInput.value = "18:00";
        haptic("selection");
      });
    }
    if (chipWeek) {
      chipWeek.addEventListener("click", function () {
        dateInput.value = core.addDays(core.moscowToday(), 7);
        if (!timeInput.value) timeInput.value = "18:00";
        haptic("selection");
      });
    }
    if (chipClear) {
      chipClear.addEventListener("click", function () {
        dateInput.value = "";
        timeInput.value = "";
        haptic("selection");
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        showTab("list");
      });
    }

    if (filterBtns && filterBtns.length) {
      Array.prototype.forEach.call(filterBtns, function (btn) {
        btn.addEventListener("click", function () {
          Array.prototype.forEach.call(filterBtns, function (b) { b.classList.remove("is-active"); });
          btn.classList.add("is-active");
          noteFilter = btn.dataset.filter || "all";
          renderNoteList();
          haptic("selection");
        });
      });
    }

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var subj = subjectInput ? subjectInput.value.trim() : "";
        var text = textInput ? textInput.value.trim() : "";
        var date = dateInput ? dateInput.value.trim() : "";
        var time = timeInput ? timeInput.value.trim() : "";

        if (!text) {
          if (textInput) textInput.focus();
          return;
        }

        var deadline = "";
        if (date) {
          deadline = date + "T" + (time || "18:00");
        }

        var newNote = {
          id: "note_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
          subject: subj,
          text: text,
          deadline: deadline,
          done: false,
          created_at: Math.floor(Date.now() / 1000)
        };

        notesList.unshift(newNote);
        saveStoredNotes();
        renderDays();

        form.reset();
        if (timeInput) timeInput.value = "18:00";
        closeModal();
        showToast("✓ Задание сохранено!");
        haptic("success");

        fetchWithTimeout((apiBase || "") + "/api/notes", {
          method: "POST",
          headers: chessHeaders(),
          body: JSON.stringify(newNote)
        }, 10000).catch(function () {});
      });
    }

    fetchWithRetry((apiBase || "") + "/api/notes", {
      headers: authHeaders()
    }, LOAD_TIMEOUT_MS, 1)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok && Array.isArray(data.notes)) {
          var map = {};
          notesList.forEach(function (n) { map[n.id] = n; });
          data.notes.forEach(function (n) { map[n.id] = n; });
          notesList = Object.keys(map).map(function (k) { return map[k]; });
          notesList.sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
          saveStoredNotes();
          renderDays();
        }
      })
      .catch(function () {});

    updateNoteBadge();
  }

  /* ---------- ЧЕЛИК ---------- */

  function initPet() {
    var section = document.getElementById("petSection");
    if (!section) return;

    var loadingEl = document.getElementById("petLoading");
    var adoptBox = document.getElementById("petAdoptBox");
    var nameInput = document.getElementById("petNameInput");
    var adoptBtn = document.getElementById("petAdoptBtn");
    var adoptErr = document.getElementById("petAdoptError");

    var activeBox = document.getElementById("petActiveBox");
    var nameEl = document.getElementById("petName");
    var ageEl = document.getElementById("petAge");
    var heartsEl = document.getElementById("petHearts");
    var timerEl = document.getElementById("petTimer");

    var petChar = document.getElementById("petChar");
    var levelBadge = document.getElementById("petLevelBadge");
    var upgradeCard = document.getElementById("petUpgradeCard");
    var upgradeStep = document.getElementById("petUpgradeStep");
    var upgradeText = document.getElementById("petUpgradeText");
    var upgradeBtn = document.getElementById("petUpgradeBtn");
    var upgradeBtnText = document.getElementById("petUpgradeBtnText");
    var upgradeBtnPrice = document.getElementById("petUpgradeBtnPrice");
    var pill1 = document.getElementById("petLevelPill1");
    var pill2 = document.getElementById("petLevelPill2");
    var pill3 = document.getElementById("petLevelPill3");

    var layerBack = document.getElementById("petLayerBack");
    var layerBody = document.getElementById("petLayerBody");
    var layerFace = document.getElementById("petLayerFace");
    var layerFront = document.getElementById("petLayerFront");
    var layerHat = document.getElementById("petLayerHat");
    var layerNeck = document.getElementById("petLayerNeck");
    var reactionBox = document.getElementById("petReaction");

    var aliveBox = document.getElementById("petAliveBox");
    var feedBtn = document.getElementById("petFeedBtn");
    var itemsGrid = document.getElementById("petItemsGrid");

    var deadBox = document.getElementById("petDeadBox");
    var reviveInput = document.getElementById("petReviveNameInput");
    var reviveBtn = document.getElementById("petReviveBtn");
    var reviveErr = document.getElementById("petReviveError");

    var layerWork = document.getElementById("petLayerWork");
    var mineCard = document.getElementById("petMineCard");
    var mineSubtitle = document.getElementById("petMineSubtitle");
    var mineShift1 = document.getElementById("petMineShift1");
    var mineShift2 = document.getElementById("petMineShift2");
    var mineShift3 = document.getElementById("petMineShift3");
    var mineStatusBadge = document.getElementById("petMineStatusBadge");
    var mineStatusText = document.getElementById("petMineStatusText");
    var mineHeartCost = document.getElementById("petMineHeartCost");
    var mineProgressBox = document.getElementById("petMineProgressBox");
    var mineProgressFill = document.getElementById("petMineProgressFill");
    var mineTimer = document.getElementById("petMineTimer");
    var mineBtn = document.getElementById("petMineBtn");
    var mineBtnIcon = document.getElementById("petMineBtnIcon");
    var mineBtnText = document.getElementById("petMineBtnText");
    var mineBtnReward = document.getElementById("petMineBtnReward");
    var mineLimitHint = document.getElementById("petMineLimitHint");

    var workTimerInterval = null;

    var MINER_HELMET_SVG =
      '<g class="pet__miner-helmet">' +
        '<path d="M 48 38 C 48 18, 112 18, 112 38 Z" fill="#facc15" stroke="#ca8a04" stroke-width="1.8" />' +
        '<path d="M 42 38 C 42 35, 118 35, 118 38 C 118 42, 42 42, 42 38 Z" fill="#eab308" stroke="#a16207" stroke-width="1.2" />' +
        '<rect x="76" y="16" width="8" height="18" rx="3" fill="#fde047" stroke="#ca8a04" stroke-width="1" />' +
        '<rect x="73" y="30" width="14" height="11" rx="3" fill="#475569" />' +
        '<circle cx="80" cy="35" r="5" fill="#38bdf8" stroke="#0284c7" stroke-width="1.2" />' +
        '<circle cx="80" cy="35" r="3" fill="#ffffff" />' +
        '<polygon points="76,38 20,135 140,135 84,38" fill="url(#minerLampGlow)" opacity="0.35" />' +
      '</g>';

    var navBtn = document.getElementById("menuPetNavBtn");

    var DEFAULT_CATALOG = [
      { id: "cap", name: "Кепка", emoji: "🧢", type: "hat", price: 300, description: "Стильная бейсболка на бок" },
      { id: "shades", name: "Крутые очки", emoji: "🕶", type: "hat", price: 400, description: "Тёмные очки для важных переговоров" },
      { id: "grad", name: "Шапка выпускника", emoji: "🎓", type: "hat", price: 500, description: "Конфедератка отличника" },
      { id: "crown", name: "Золотая корона", emoji: "👑", type: "hat", price: 1500, description: "Настоящее королевское величие" },
      { id: "headphones", name: "Наушники", emoji: "🎧", type: "hat", price: 600, description: "Геймерские неоновые наушники" },
      { id: "bow", name: "Бантик", emoji: "🎀", type: "neck", price: 200, description: "Милый розовый бантик" },
      { id: "tie", name: "Галстук", emoji: "👔", type: "neck", price: 450, description: "Деловой красный галстук" },
      { id: "scarf", name: "Тёплый шарф", emoji: "🧣", type: "neck", price: 350, description: "Согревает на зимней сессии" }
    ];

    var petData = null;
    var petCatalog = DEFAULT_CATALOG.slice();
    var busy = false;
    var petLoaded = false;
    var PET_CACHE_KEY = "schedule_pet_cache_v1";

    function readPetCache() {
      try {
        var raw = localStorage.getItem(PET_CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    function writePetCache(data) {
      try {
        localStorage.setItem(PET_CACHE_KEY, JSON.stringify(data));
      } catch (e) {}
    }

    var cachedPet = readPetCache();
    if (cachedPet && cachedPet.pet) {
      petData = cachedPet.pet;
      if (Array.isArray(cachedPet.catalog)) {
        petCatalog = cachedPet.catalog;
      }
    }

    function renderPetBalance() {
      var badgeVal = document.getElementById("petBalanceVal");
      if (badgeVal) {
        badgeVal.textContent = tugriks(getEffectiveBalance());
      }
    }

    onBalanceUpdate(function () {
      renderPetBalance();
    });

    var ITEM_SVGS = {
      cap: '<path d="M 50 36 C 50 20 110 20 110 36 Z" fill="#2563eb" />' +
           '<path d="M 44 36 C 44 34 76 28 116 34 C 122 36 120 40 112 40 C 80 40 44 38 44 36 Z" fill="#1d4ed8" />' +
           '<circle cx="80" cy="22" r="3" fill="#60a5fa" />',
      shades: '<line x1="72" y1="82" x2="88" y2="82" stroke="#111827" stroke-width="3" stroke-linecap="round" />' +
              '<path d="M 48 76 L 73 76 L 71 91 C 70 94 51 94 50 91 Z" fill="#111827" stroke="#374151" stroke-width="1.5" />' +
              '<path d="M 87 76 L 112 76 L 110 91 C 109 94 90 94 89 91 Z" fill="#111827" stroke="#374151" stroke-width="1.5" />' +
              '<line x1="52" y1="79" x2="68" y2="89" stroke="#ffffff" stroke-width="1.5" opacity="0.6" stroke-linecap="round" />' +
              '<line x1="91" y1="79" x2="107" y2="89" stroke="#ffffff" stroke-width="1.5" opacity="0.6" stroke-linecap="round" />',
      grad: '<polygon points="80,12 120,24 80,36 40,24" fill="#1e1e24" stroke="#3f3f46" stroke-width="1" />' +
            '<path d="M 62 29 Q 80 25 98 29 L 96 38 Q 80 42 64 38 Z" fill="#18181b" />' +
            '<circle cx="80" cy="24" r="2" fill="#eab308" />' +
            '<path d="M 80 24 Q 105 28 108 42" fill="none" stroke="#eab308" stroke-width="1.5" />' +
            '<circle cx="108" cy="43" r="2" fill="#eab308" />',
      crown: '<path d="M 52 32 L 56 16 L 68 25 L 80 12 L 92 25 L 104 16 L 108 32 Z" fill="#fbbf24" stroke="#d97706" stroke-width="1.5" />' +
             '<circle cx="56" cy="16" r="2.5" fill="#ef4444" />' +
             '<circle cx="80" cy="12" r="3" fill="#3b82f6" />' +
             '<circle cx="104" cy="16" r="2.5" fill="#10b981" />' +
             '<circle cx="80" cy="27" r="2" fill="#ffffff" opacity="0.8" />',
      headphones: '<path d="M 44 80 C 44 14 116 14 116 80" fill="none" stroke="#22c55e" stroke-width="4.5" stroke-linecap="round" />' +
                  '<rect x="36" y="68" width="11" height="24" rx="5" fill="#16a34a" stroke="#15803d" stroke-width="1.5" />' +
                  '<rect x="113" y="68" width="11" height="24" rx="5" fill="#16a34a" stroke="#15803d" stroke-width="1.5" />',
      bow: '<circle cx="80" cy="112" r="4" fill="#ec4899" />' +
           '<polygon points="80,112 65,104 65,120" fill="#f472b6" stroke="#db2777" stroke-width="1" />' +
           '<polygon points="80,112 95,104 95,120" fill="#f472b6" stroke="#db2777" stroke-width="1" />',
      tie: '<polygon points="76,108 84,108 82,114 78,114" fill="#dc2626" />' +
           '<polygon points="78,114 82,114 85,135 80,141 75,135" fill="#ef4444" stroke="#b91c1c" stroke-width="1" />' +
           '<line x1="77" y1="120" x2="83" y2="124" stroke="#fca5a5" stroke-width="1.2" stroke-linecap="round" />' +
           '<line x1="76" y1="128" x2="84" y2="132" stroke="#fca5a5" stroke-width="1.2" stroke-linecap="round" />',
      scarf: '<rect x="52" y="106" width="56" height="13" rx="6.5" fill="#f97316" stroke="#c2410c" stroke-width="1" />' +
             '<path d="M 88 116 L 98 116 L 96 138 L 86 138 Z" fill="#ea580c" />' +
             '<line x1="87" y1="138" x2="87" y2="142" stroke="#fff7ed" stroke-width="1" />' +
             '<line x1="91" y1="138" x2="91" y2="142" stroke="#fff7ed" stroke-width="1" />' +
             '<line x1="95" y1="138" x2="95" y2="142" stroke="#fff7ed" stroke-width="1" />'
    };

    function petFetch(path, options) {
      var opt = options || {};
      opt.headers = chessHeaders();
      return fetchWithRetry((apiBase || "") + "/api/pet" + path, opt, LOAD_TIMEOUT_MS, 1)
        .then(function (r) { return r.json(); });
    }

    function formatPetAge(adoptedAt) {
      if (!adoptedAt) return "";
      var diffSec = Math.max(0, Math.floor(Date.now() / 1000) - adoptedAt);
      var days = Math.floor(diffSec / 86400);
      if (days === 0) return "родился сегодня";
      var rem10 = days % 10;
      var rem100 = days % 100;
      var word = "дней";
      if (rem10 === 1 && rem100 !== 11) word = "день";
      else if (rem10 >= 2 && rem10 <= 4 && (rem100 < 10 || rem100 >= 20)) word = "дня";
      return days + " " + word + " с вами";
    }

    function spawnReaction(emoji) {
      if (!reactionBox) return;
      var el = document.createElement("span");
      el.className = "pet__reaction-heart";
      el.textContent = emoji || "❤️";
      var offset = 30 + Math.random() * 100;
      el.style.left = offset + "px";
      reactionBox.appendChild(el);
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 1000);
    }

    function cheerPet() {
      if (!petChar) return;
      petChar.classList.remove("is-happy");
      void petChar.offsetWidth;
      petChar.classList.add("is-happy");
      setTimeout(function () {
        petChar.classList.remove("is-happy");
      }, 700);
    }

    function renderPetCharacter(level, isDead) {
      if (!layerBody || !layerFace) return;
      var lvl = Math.max(1, Math.min(3, parseInt(level, 10) || 1));

      if (isDead) {
        if (layerBack) layerBack.innerHTML = "";
        if (layerFront) layerFront.innerHTML = "";
        layerBody.innerHTML = '<path class="pet__body pet__body--dead" d="M 80 26 C 112 26 132 58 132 94 C 132 126 108 144 80 144 C 52 144 28 126 28 94 C 28 58 48 26 80 26 Z" fill="url(#petGhostGradient)" />';
        layerFace.innerHTML = '<path d="M 54 84 Q 62 76 70 84" fill="none" stroke="#0e7490" stroke-width="2.5" stroke-linecap="round" />' +
          '<path d="M 90 84 Q 98 76 106 84" fill="none" stroke="#0e7490" stroke-width="2.5" stroke-linecap="round" />' +
          '<path d="M 76 98 Q 80 94 84 98" fill="none" stroke="#0e7490" stroke-width="2.2" stroke-linecap="round" />' +
          '<ellipse cx="52" cy="94" rx="6" ry="4" fill="#a5f3fc" opacity="0.6" />' +
          '<ellipse cx="108" cy="94" rx="6" ry="4" fill="#a5f3fc" opacity="0.6" />';
        return;
      }

      if (lvl === 1) {
        if (layerBack) {
          layerBack.innerHTML =
            '<path class="pet__ear pet__ear--left" d="M 52 38 C 40 20 54 12 64 26 C 60 30 56 34 52 38 Z" fill="#ff758c" />' +
            '<path d="M 53 35 C 45 23 54 17 61 27 Z" fill="#fed7aa" opacity="0.9" />' +
            '<path class="pet__ear pet__ear--right" d="M 108 38 C 120 20 106 12 96 26 C 100 30 104 34 108 38 Z" fill="#ff758c" />' +
            '<path d="M 107 35 C 115 23 106 17 99 27 Z" fill="#fed7aa" opacity="0.9" />' +
            '<path class="pet__tail pet__tail--lvl1" d="M 116 118 C 132 112 136 124 124 128 C 118 130 114 126 116 118 Z" fill="#ff6b8b" />';
        }
        layerBody.innerHTML =
          '<path class="pet__body pet__body--lvl1" d="M 80 26 C 114 26 134 58 134 94 C 134 126 110 144 80 144 C 50 144 26 126 26 94 C 26 58 46 26 80 26 Z" fill="url(#petGradLvl1)" />' +
          '<path d="M 62 33 C 72 29 88 29 98 33 C 94 37 66 37 62 33 Z" fill="#ffffff" opacity="0.32" />' +
          '<ellipse cx="80" cy="116" rx="34" ry="22" fill="#fff5f5" opacity="0.55" />';
        layerFace.innerHTML =
          '<ellipse class="pet__blush" cx="52" cy="95" rx="8" ry="5.5" fill="#ff3366" opacity="0.45" />' +
          '<ellipse class="pet__blush" cx="108" cy="95" rx="8" ry="5.5" fill="#ff3366" opacity="0.45" />' +
          '<polygon points="45,92 46.5,95 45,98 43.5,95" fill="#ffffff" opacity="0.85" />' +
          '<polygon points="115,92 116.5,95 115,98 113.5,95" fill="#ffffff" opacity="0.85" />' +
          '<g class="pet__eyes">' +
            '<circle cx="62" cy="84" r="8" fill="#1e1e24" />' +
            '<circle cx="62" cy="84" r="7" fill="#3b0764" />' +
            '<circle cx="60" cy="81" r="3.2" fill="#ffffff" />' +
            '<circle cx="64.5" cy="86" r="1.5" fill="#ffffff" />' +
            '<circle cx="59.5" cy="86.5" r="1.1" fill="#f472b6" opacity="0.8" />' +
            '<circle cx="98" cy="84" r="8" fill="#1e1e24" />' +
            '<circle cx="98" cy="84" r="7" fill="#3b0764" />' +
            '<circle cx="96" cy="81" r="3.2" fill="#ffffff" />' +
            '<circle cx="100.5" cy="86" r="1.5" fill="#ffffff" />' +
            '<circle cx="95.5" cy="86.5" r="1.1" fill="#f472b6" opacity="0.8" />' +
          '</g>' +
          '<path class="pet__mouth" d="M 73 97 Q 77 101 80 98 Q 83 101 87 97" fill="none" stroke="#2d1b36" stroke-width="2.3" stroke-linecap="round" />' +
          '<path d="M 76 27 C 77 20 83 20 84 27 C 82 24 78 24 76 27 Z" fill="#ff758c" />';
        if (layerFront) {
          layerFront.innerHTML =
            '<ellipse cx="64" cy="138" rx="7.5" ry="5.5" fill="#ff6b8b" />' +
            '<circle cx="63" cy="136.5" r="2" fill="#ffffff" opacity="0.4" />' +
            '<ellipse cx="96" cy="138" rx="7.5" ry="5.5" fill="#ff6b8b" />' +
            '<circle cx="95" cy="136.5" r="2" fill="#ffffff" opacity="0.4" />';
        }
      } else if (lvl === 2) {
        if (layerBack) {
          layerBack.innerHTML =
            '<g class="pet__ear pet__ear--lvl2-left">' +
              '<path d="M 44 46 C 30 16 44 4 58 24 C 52 30 46 38 44 46 Z" fill="url(#petGradLvl2Ear)" />' +
              '<path d="M 46 42 C 38 20 46 12 54 26 Z" fill="#c4b5fd" opacity="0.85" />' +
              '<path d="M 45 38 L 51 34 L 47 44 Z" fill="#ffffff" opacity="0.75" />' +
            '</g>' +
            '<g class="pet__ear pet__ear--lvl2-right">' +
              '<path d="M 116 46 C 130 16 116 4 102 24 C 108 30 114 38 116 46 Z" fill="url(#petGradLvl2Ear)" />' +
              '<path d="M 114 42 C 122 20 114 12 106 26 Z" fill="#c4b5fd" opacity="0.85" />' +
              '<path d="M 115 38 L 109 34 L 113 44 Z" fill="#ffffff" opacity="0.75" />' +
            '</g>' +
            '<g class="pet__tail pet__tail--lvl2">' +
              '<path d="M 118 114 C 150 102 162 124 144 140 C 128 148 110 134 116 120 Z" fill="url(#petGradLvl2Tail)" />' +
              '<path d="M 136 114 C 152 120 148 134 140 138 C 132 134 130 124 136 114 Z" fill="#ffffff" opacity="0.85" />' +
            '</g>' +
            '<path d="M 28 88 L 16 94 L 28 98 L 20 104 L 32 106 Z" fill="#4338ca" />' +
            '<path d="M 132 88 L 144 94 L 132 98 L 140 104 L 128 106 Z" fill="#4338ca" />';
        }
        layerBody.innerHTML =
          '<path class="pet__body pet__body--lvl2" d="M 80 26 C 114 26 134 58 134 94 C 134 126 110 144 80 144 C 50 144 26 126 26 94 C 26 58 46 26 80 26 Z" fill="url(#petGradLvl2)" />' +
          '<path d="M 64 32 C 72 28 88 28 96 32 C 92 36 68 36 64 32 Z" fill="#ffffff" opacity="0.3" />' +
          '<path d="M 64 102 C 72 112 80 114 80 114 C 80 114 88 112 96 102 C 92 116 80 124 80 124 C 80 124 68 116 64 102 Z" fill="#e0e7ff" opacity="0.9" />';
        layerFace.innerHTML =
          '<g class="pet__rune">' +
            '<polygon points="80,36 83,44 91,48 83,52 80,60 77,52 69,48 77,44" fill="#38bdf8" stroke="#ffffff" stroke-width="0.8" />' +
            '<circle cx="80" cy="48" r="2" fill="#ffffff" />' +
          '</g>' +
          '<path d="M 38 92 Q 48 94 42 99" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" opacity="0.9" />' +
          '<path d="M 122 92 Q 112 94 118 99" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" opacity="0.9" />' +
          '<g class="pet__eyes">' +
            '<circle cx="62" cy="84" r="8" fill="#0f172a" />' +
            '<circle cx="62" cy="84" r="7" fill="url(#petGradEyeLvl2)" />' +
            '<circle cx="59.5" cy="81" r="3" fill="#ffffff" />' +
            '<polygon points="65,85 66.5,83.5 68,85 66.5,86.5" fill="#38bdf8" />' +
            '<circle cx="98" cy="84" r="8" fill="#0f172a" />' +
            '<circle cx="98" cy="84" r="7" fill="url(#petGradEyeLvl2)" />' +
            '<circle cx="95.5" cy="81" r="3" fill="#ffffff" />' +
            '<polygon points="101,85 102.5,83.5 104,85 102.5,86.5" fill="#38bdf8" />' +
          '</g>' +
          '<polygon points="80,94 78,92 82,92" fill="#38bdf8" />' +
          '<path class="pet__mouth" d="M 74 98 Q 80 103 86 98" fill="none" stroke="#1e1b4b" stroke-width="2.2" stroke-linecap="round" />';
        if (layerFront) {
          layerFront.innerHTML =
            '<ellipse cx="62" cy="138" rx="8" ry="5.5" fill="#312e81" />' +
            '<circle cx="62" cy="137" r="2" fill="#38bdf8" opacity="0.7" />' +
            '<ellipse cx="98" cy="138" rx="8" ry="5.5" fill="#312e81" />' +
            '<circle cx="98" cy="137" r="2" fill="#38bdf8" opacity="0.7" />';
        }
      } else if (lvl >= 3) {
        if (layerBack) {
          layerBack.innerHTML =
            '<circle class="pet__astral-ring" cx="80" cy="80" r="66" fill="none" stroke="url(#petGradAstralRing)" stroke-width="2" stroke-dasharray="8 6" opacity="0.65" />' +
            '<g class="pet__wing pet__wing--left">' +
              '<path d="M 38 68 C 6 36 -2 64 6 82 C 12 96 32 94 36 86 Z" fill="url(#petGradWingLvl3)" />' +
              '<path d="M 28 72 C 12 50 8 68 14 80 C 20 86 30 84 32 78 Z" fill="#ffffff" opacity="0.6" />' +
            '</g>' +
            '<g class="pet__wing pet__wing--right">' +
              '<path d="M 122 68 C 154 36 162 64 154 82 C 148 96 128 94 124 86 Z" fill="url(#petGradWingLvl3)" />' +
              '<path d="M 132 72 C 148 50 152 68 146 80 C 140 86 130 84 128 78 Z" fill="#ffffff" opacity="0.6" />' +
            '</g>' +
            '<g class="pet__tail pet__tail--lvl3">' +
              '<path d="M 116 116 C 150 104 164 126 146 142 C 132 150 112 138 114 124 Z" fill="url(#petGradTailLvl3A)" />' +
              '<path d="M 44 116 C 10 104 -4 126 14 142 C 28 150 48 138 46 124 Z" fill="url(#petGradTailLvl3B)" />' +
            '</g>' +
            '<path class="pet__horn pet__horn--left" d="M 52 36 C 32 12 42 2 52 10 C 58 16 56 26 52 36 Z" fill="url(#petGradHorn)" stroke="#fbbf24" stroke-width="1" />' +
            '<circle cx="44" cy="5" r="2.5" fill="#fde047" />' +
            '<path class="pet__horn pet__horn--right" d="M 108 36 C 128 12 118 2 108 10 C 102 16 104 26 108 36 Z" fill="url(#petGradHorn)" stroke="#fbbf24" stroke-width="1" />' +
            '<circle cx="116" cy="5" r="2.5" fill="#fde047" />';
        }
        layerBody.innerHTML =
          '<path class="pet__body pet__body--lvl3" d="M 80 26 C 114 26 134 58 134 94 C 134 126 110 144 80 144 C 50 144 26 126 26 94 C 26 58 46 26 80 26 Z" fill="url(#petGradLvl3)" />' +
          '<circle cx="52" cy="60" r="1.2" fill="#ffffff" opacity="0.8" />' +
          '<circle cx="108" cy="64" r="1.5" fill="#ffffff" opacity="0.85" />' +
          '<circle cx="40" cy="110" r="1.2" fill="#fde047" opacity="0.9" />' +
          '<circle cx="120" cy="114" r="1.2" fill="#fde047" opacity="0.9" />' +
          '<polygon points="70,44 71,46 73,46 71.5,47.5 72,49.5 70,48 68,49.5 68.5,47.5 67,46 69,46" fill="#ffffff" opacity="0.9" />' +
          '<polygon points="90,44 91,46 93,46 91.5,47.5 92,49.5 90,48 88,49.5 88.5,47.5 87,46 89,46" fill="#ffffff" opacity="0.9" />' +
          '<g class="pet__core">' +
            '<circle cx="80" cy="120" r="10" fill="#fbbf24" opacity="0.35" class="pet__core-pulse" />' +
            '<polygon points="80,111 88,120 80,129 72,120" fill="#fbbf24" stroke="#ffffff" stroke-width="1.2" />' +
            '<polygon points="80,114 85,120 80,126 75,120" fill="#ffffff" />' +
          '</g>';
        layerFace.innerHTML =
          '<polygon points="80,18 84,26 92,28 85,34 87,42 80,37 73,42 75,34 68,28 76,26" fill="#f59e0b" stroke="#ffffff" stroke-width="0.8" />' +
          '<circle cx="80" cy="30" r="2.2" fill="#ffffff" />' +
          '<ellipse class="pet__blush" cx="52" cy="95" rx="7" ry="5" fill="#fbbf24" opacity="0.35" />' +
          '<ellipse class="pet__blush" cx="108" cy="95" rx="7" ry="5" fill="#fbbf24" opacity="0.35" />' +
          '<g class="pet__eyes">' +
            '<circle cx="62" cy="84" r="8" fill="#18181b" />' +
            '<circle cx="62" cy="84" r="7" fill="url(#petGradEyeLvl3)" />' +
            '<circle cx="60" cy="81" r="3.2" fill="#ffffff" />' +
            '<polygon points="65,85 67,83 69,85 67,87" fill="#fbbf24" />' +
            '<circle cx="98" cy="84" r="8" fill="#18181b" />' +
            '<circle cx="98" cy="84" r="7" fill="url(#petGradEyeLvl3)" />' +
            '<circle cx="96" cy="81" r="3.2" fill="#ffffff" />' +
            '<polygon points="101,85 103,83 105,85 103,87" fill="#fbbf24" />' +
          '</g>' +
          '<polygon points="80,94 78,92 82,92" fill="#fbbf24" />' +
          '<path class="pet__mouth" d="M 74 98 Q 80 102 86 98" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" />';
        if (layerFront) {
          layerFront.innerHTML =
            '<ellipse cx="62" cy="138" rx="8" ry="5.5" fill="#1e1b4b" stroke="#fbbf24" stroke-width="0.8" />' +
            '<circle cx="62" cy="137" r="2" fill="#fde047" opacity="0.85" />' +
            '<ellipse cx="98" cy="138" rx="8" ry="5.5" fill="#1e1b4b" stroke="#fbbf24" stroke-width="0.8" />' +
            '<circle cx="98" cy="137" r="2" fill="#fde047" opacity="0.85" />';
        }
      }
    }

    function renderPet() {
      if (loadingEl) loadingEl.hidden = true;
      if (petData) {
        writePetCache({ pet: petData, catalog: petCatalog });
      }

      if (!petData) {
        if (adoptBox) adoptBox.hidden = false;
        if (activeBox) activeBox.hidden = true;
        return;
      }

      if (adoptBox) adoptBox.hidden = true;
      if (activeBox) activeBox.hidden = false;

      var isDead = !!petData.dead;
      var lvl = Math.max(1, Math.min(3, parseInt(petData.level, 10) || 1));

      if (nameEl) nameEl.textContent = petData.name || "Стрики";
      if (ageEl) ageEl.textContent = formatPetAge(petData.adopted_at);

      if (levelBadge) {
        levelBadge.textContent = (lvl === 3 ? "⭐⭐⭐ Ур. 3" : (lvl === 2 ? "⭐⭐ Ур. 2" : "⭐ Ур. 1"));
        levelBadge.className = "pet__level-badge is-lvl-" + lvl;
      }

      if (petChar) {
        petChar.classList.toggle("is-dead", isDead);
        petChar.classList.remove("is-lvl-1", "is-lvl-2", "is-lvl-3");
        petChar.classList.add("is-lvl-" + lvl);
      }

      var petStage = document.getElementById("petStage");
      if (petStage) {
        petStage.classList.toggle("is-dead", isDead);
        petStage.classList.remove("is-lvl-1", "is-lvl-2", "is-lvl-3");
        petStage.classList.add("is-lvl-" + lvl);
      }

      renderPetCharacter(lvl, isDead);

      if (heartsEl) {
        heartsEl.innerHTML = "";
        var h = Math.max(0, Math.min(5, petData.health || 0));
        for (var i = 0; i < 5; i++) {
          var sp = document.createElement("span");
          var filled = i < h;
          sp.className = "pet__heart " + (filled ? "is-filled" : "is-lost");
          sp.style.animationDelay = (i * 0.18) + "s";
          sp.textContent = filled ? "❤️" : "🤍";
          heartsEl.appendChild(sp);
        }
      }

      if (timerEl) {
        if (isDead) {
          timerEl.textContent = "Погиб 🪦";
        } else if (petData.health >= 5) {
          timerEl.textContent = "Сыт и счастлив ✨";
        } else {
          var nowSec = Math.floor(Date.now() / 1000);
          var elapsed = Math.max(0, nowSec - (petData.last_fed_at || nowSec));
          var leftSec = Math.max(0, 86400 - (elapsed % 86400));
          var hrs = Math.floor(leftSec / 3600);
          var mins = Math.floor((leftSec % 3600) / 60);
          timerEl.textContent = "До потери ❤️: " + hrs + "ч " + mins + "м";
        }
      }

      if (isDead) {
        if (aliveBox) aliveBox.hidden = true;
        if (deadBox) deadBox.hidden = false;
        if (layerHat) layerHat.innerHTML = "";
        if (layerNeck) layerNeck.innerHTML = "";
        if (layerWork) layerWork.innerHTML = "";
        stopWorkTimer();
        return;
      }

      if (aliveBox) aliveBox.hidden = false;
      if (deadBox) deadBox.hidden = true;

      // Обновление карточки улучшения уровня
      if (upgradeCard) {
        upgradeCard.hidden = false;
        if (pill1) pill1.className = "pet__level-pill is-active" + (lvl >= 3 ? " is-max" : "");
        if (pill2) pill2.className = "pet__level-pill" + (lvl >= 2 ? " is-active" : "") + (lvl >= 3 ? " is-max" : "");
        if (pill3) pill3.className = "pet__level-pill" + (lvl >= 3 ? " is-active is-max" : "");

        var evoVal = document.getElementById("petEvolutionVal");
        var evoFill = document.getElementById("petEvolutionFill");
        var curBal = getEffectiveBalance();

        if (lvl === 1) {
          if (upgradeStep) upgradeStep.textContent = "Уровень 1 из 3";
          if (upgradeText) upgradeText.textContent = "Откройте 2-й уровень: форма Магического Лиса-Хранителя с пушистым хвостом, ушками и светящимися рунами!";
          if (upgradeBtn) {
            upgradeBtn.disabled = false;
            upgradeBtn.className = "pet__upgrade-btn";
          }
          if (upgradeBtnText) upgradeBtnText.textContent = "Улучшить до 2 уровня";
          if (upgradeBtnPrice) upgradeBtnPrice.textContent = "3 000 тугриков";

          var pct1 = Math.min(100, Math.max(0, Math.floor((curBal / 3000) * 100)));
          if (evoVal) evoVal.textContent = curBal.toLocaleString("ru-RU") + " / 3 000 💰 (" + pct1 + "%)";
          if (evoFill) {
            evoFill.style.width = pct1 + "%";
            evoFill.className = "pet__evolution-fill is-lvl-1";
          }
        } else if (lvl === 2) {
          if (upgradeStep) upgradeStep.textContent = "Уровень 2 из 3";
          if (upgradeText) upgradeText.textContent = "Откройте 3-й уровень: Легендарный Космический Хранитель с парящими крыльями, звездным сиянием и небесными рогами!";
          if (upgradeBtn) {
            upgradeBtn.disabled = false;
            upgradeBtn.className = "pet__upgrade-btn pet__upgrade-btn--gold";
          }
          if (upgradeBtnText) upgradeBtnText.textContent = "Улучшить до 3 уровня";
          if (upgradeBtnPrice) upgradeBtnPrice.textContent = "6 000 тугриков";

          var pct2 = Math.min(100, Math.max(0, Math.floor((curBal / 6000) * 100)));
          if (evoVal) evoVal.textContent = curBal.toLocaleString("ru-RU") + " / 6 000 💰 (" + pct2 + "%)";
          if (evoFill) {
            evoFill.style.width = pct2 + "%";
            evoFill.className = "pet__evolution-fill is-lvl-2";
          }
        } else {
          if (upgradeStep) upgradeStep.textContent = "Уровень 3 из 3 (МАКС)";
          if (upgradeText) upgradeText.textContent = "★ Питомец достиг максимального 3-го уровня! Легендарный облик активен.";
          if (upgradeBtn) {
            upgradeBtn.disabled = true;
            upgradeBtn.className = "pet__upgrade-btn is-max";
          }
          if (upgradeBtnText) upgradeBtnText.textContent = "Максимальный уровень";
          if (upgradeBtnPrice) upgradeBtnPrice.textContent = "⭐⭐⭐";

          if (evoVal) evoVal.textContent = "Максимальный уровень ⭐⭐⭐";
          if (evoFill) {
            evoFill.style.width = "100%";
            evoFill.className = "pet__evolution-fill is-max";
          }
        }
      }

      var equippedHat = "";
      var equippedNeck = "";

      if (petData && petData.equipped) {
        if (typeof petData.equipped === "object" && !Array.isArray(petData.equipped)) {
          equippedHat = petData.equipped.hat || "";
          equippedNeck = petData.equipped.neck || "";
        } else if (Array.isArray(petData.equipped)) {
          petData.equipped.forEach(function (id) {
            petCatalog.forEach(function (it) {
              if (it.id === id) {
                if (it.type === "hat") equippedHat = id;
                if (it.type === "neck") equippedNeck = id;
              }
            });
          });
        }
      }

      var isMiningState = petData && petData.work && (petData.work.status === "working" || petData.work.status === "ready");
      if (isMiningState) {
        if (layerHat) layerHat.innerHTML = "";
        if (layerWork) layerWork.innerHTML = MINER_HELMET_SVG;
      } else {
        if (layerHat) layerHat.innerHTML = equippedHat ? (ITEM_SVGS[equippedHat] || "") : "";
        if (layerWork) layerWork.innerHTML = "";
      }
      if (layerNeck) layerNeck.innerHTML = equippedNeck ? (ITEM_SVGS[equippedNeck] || "") : "";

      if (feedBtn) {
        feedBtn.disabled = petData.health >= 5;
        var feedText = feedBtn.querySelector(".pet__feed-text");
        if (feedText) {
          feedText.textContent = petData.health >= 5 ? "Питомец полностью сыт" : "Покормить яблоком";
        }
      }

      renderPetWork(petData.work);
      renderWardrobe();
      renderPetBalance();
    }

    function formatWorkTime(seconds) {
      var s = Math.max(0, Math.floor(seconds));
      var m = Math.floor(s / 60);
      var remS = s % 60;
      return (m < 10 ? "0" + m : m) + ":" + (remS < 10 ? "0" + remS : remS);
    }

    function stopWorkTimer() {
      if (workTimerInterval) {
        clearInterval(workTimerInterval);
        workTimerInterval = null;
      }
    }

    function renderPetWork(work) {
      if (!mineCard) return;
      if (!petData || petData.dead || !work) {
        mineCard.hidden = true;
        stopWorkTimer();
        if (layerWork) layerWork.innerHTML = "";
        return;
      }

      mineCard.hidden = false;

      var status = work.status || "idle";
      var reward = work.reward || 100;
      var shiftsToday = Math.max(0, Math.min(3, parseInt(work.shifts_today, 10) || 0));
      var maxShifts = work.max_shifts || 3;
      var canWork = !!work.can_work;
      var heartLostToday = !!work.heart_lost_today;
      var startedAt = work.started_at;
      var shiftSec = work.shift_seconds || 3600;

      if (mineSubtitle) {
        mineSubtitle.textContent = "Добыча: " + reward + " 💰 / час (Ур. " + (petData.level || 1) + ")";
      }

      // Обновляем индикаторы смен
      var shiftEls = [mineShift1, mineShift2, mineShift3];
      for (var sIdx = 0; sIdx < 3; sIdx++) {
        var el = shiftEls[sIdx];
        if (!el) continue;
        var shiftNum = sIdx + 1;
        if (shiftNum <= shiftsToday) {
          el.className = "pet__mine-shift is-done";
          el.textContent = shiftNum + " ✓";
        } else if (shiftNum === shiftsToday + 1 && status === "working") {
          el.className = "pet__mine-shift is-in-progress";
          el.textContent = shiftNum + " ⛏️";
        } else if (shiftNum === shiftsToday + 1 && status === "ready") {
          el.className = "pet__mine-shift is-in-progress";
          el.textContent = shiftNum + " 🎁";
        } else {
          el.className = "pet__mine-shift";
          el.textContent = shiftNum + " ч";
        }
      }

      // Информация о сердечках
      if (mineHeartCost) {
        if (heartLostToday) {
          mineHeartCost.textContent = "❤️ за сегодня уже списано (смена бесплатна)";
        } else {
          mineHeartCost.textContent = "Расход: 1 ❤️ за первую смену дня";
        }
      }

      // Каска и анимации
      if (status === "working") {
        if (petChar) {
          petChar.classList.add("is-mining");
          petChar.classList.remove("is-mining-ready");
        }
        if (layerWork) layerWork.innerHTML = MINER_HELMET_SVG;
        if (layerHat) layerHat.innerHTML = "";
      } else if (status === "ready") {
        if (petChar) {
          petChar.classList.remove("is-mining");
          petChar.classList.add("is-mining-ready");
        }
        if (layerWork) layerWork.innerHTML = MINER_HELMET_SVG;
        if (layerHat) layerHat.innerHTML = "";
      } else {
        if (petChar) {
          petChar.classList.remove("is-mining", "is-mining-ready");
        }
        if (layerWork) layerWork.innerHTML = "";
      }

      if (status === "working") {
        stopWorkTimer();
        if (mineProgressBox) mineProgressBox.hidden = false;
        if (mineLimitHint) mineLimitHint.hidden = true;
        if (mineStatusBadge) mineStatusBadge.className = "pet__mine-status-badge is-working";
        if (mineStatusText) mineStatusText.textContent = "В шахте (смена " + (shiftsToday + 1) + " из " + maxShifts + ")";

        if (mineBtn) {
          mineBtn.disabled = true;
          mineBtn.className = "pet__mine-btn";
        }
        if (mineBtnIcon) mineBtnIcon.textContent = "⛏️";
        if (mineBtnText) mineBtnText.textContent = "Идёт добыча тугриков…";
        if (mineBtnReward) mineBtnReward.textContent = "+" + reward + " 💰";

        function tick() {
          var nowSec = Math.floor(Date.now() / 1000);
          var elapsed = Math.max(0, nowSec - (startedAt || nowSec));
          var remaining = Math.max(0, shiftSec - elapsed);

          var pct = Math.min(100, Math.max(0, Math.floor(((shiftSec - remaining) / shiftSec) * 100)));
          if (mineProgressFill) mineProgressFill.style.width = pct + "%";
          if (mineTimer) mineTimer.textContent = formatWorkTime(remaining);

          if (remaining <= 0) {
            stopWorkTimer();
            if (petData && petData.work) {
              petData.work.status = "ready";
              cheerPet();
              spawnReaction("✨");
              haptic("success");
              renderPetWork(petData.work);
            }
          }
        }

        tick();
        stopWorkTimer();
        var menu = document.getElementById("menu");
        var isMineVisible = document.visibilityState === "visible" &&
                            menu && !menu.hidden;
        if (isMineVisible) {
          workTimerInterval = setInterval(tick, 1000);
        }

      } else if (status === "ready") {
        stopWorkTimer();
        if (mineProgressBox) mineProgressBox.hidden = true;
        if (mineLimitHint) mineLimitHint.hidden = true;
        if (mineStatusBadge) mineStatusBadge.className = "pet__mine-status-badge is-ready";
        if (mineStatusText) mineStatusText.textContent = "🎉 Добыча готова!";

        if (mineBtn) {
          mineBtn.disabled = false;
          mineBtn.className = "pet__mine-btn pet__mine-btn--claim";
        }
        if (mineBtnIcon) mineBtnIcon.textContent = "🎁";
        if (mineBtnText) mineBtnText.textContent = "Забрать добычу!";
        if (mineBtnReward) mineBtnReward.textContent = "+" + reward + " 💰";

      } else {
        // Idle
        stopWorkTimer();
        if (mineProgressBox) mineProgressBox.hidden = true;

        if (shiftsToday >= maxShifts) {
          if (mineLimitHint) mineLimitHint.hidden = false;
          if (mineStatusBadge) mineStatusBadge.className = "pet__mine-status-badge is-limit";
          if (mineStatusText) mineStatusText.textContent = "Все 3 смены завершены";
          if (mineBtn) {
            mineBtn.disabled = true;
            mineBtn.className = "pet__mine-btn";
          }
          if (mineBtnIcon) mineBtnIcon.textContent = "🌙";
          if (mineBtnText) mineBtnText.textContent = "Отдых до завтра (00:00 МСК)";
          if (mineBtnReward) mineBtnReward.textContent = "3/3";
        } else if (petData.health < 2 && !heartLostToday) {
          if (mineLimitHint) mineLimitHint.hidden = true;
          if (mineStatusBadge) mineStatusBadge.className = "pet__mine-status-badge";
          if (mineStatusText) mineStatusText.textContent = "Мало ❤️ для работы";
          if (mineBtn) {
            mineBtn.disabled = true;
            mineBtn.className = "pet__mine-btn";
          }
          if (mineBtnIcon) mineBtnIcon.textContent = "❤️";
          if (mineBtnText) mineBtnText.textContent = "Нужно минимум 2 ❤️ (покормите)";
          if (mineBtnReward) mineBtnReward.textContent = "+" + reward + " 💰";
        } else {
          if (mineLimitHint) mineLimitHint.hidden = true;
          if (mineStatusBadge) mineStatusBadge.className = "pet__mine-status-badge is-idle";
          if (mineStatusText) mineStatusText.textContent = "Готов к смене (" + (shiftsToday + 1) + "-я из " + maxShifts + ")";
          if (mineBtn) {
            mineBtn.disabled = false;
            mineBtn.className = "pet__mine-btn";
          }
          if (mineBtnIcon) mineBtnIcon.textContent = "⛏️";
          if (mineBtnText) mineBtnText.textContent = "Отправить в шахту (1 ч)";
          if (mineBtnReward) mineBtnReward.textContent = "+" + reward + " 💰";
        }
      }
    }

    function onMineBtnClick() {
      if (busy || !petData || !petData.work) return;
      var status = petData.work.status;
      if (status === "ready") {
        claimPetWorkAction();
      } else if (status === "idle" && petData.work.can_work) {
        startPetWorkAction();
      }
    }

    function startPetWorkAction() {
      if (busy) return;
      busy = true;
      petFetch("/work/start", {
        method: "POST",
        body: JSON.stringify({})
      })
        .then(function (res) {
          busy = false;
          if (!res || !res.ok) {
            showToast((res && res.error) || "Не удалось отправить в шахту", true);
            haptic("error");
            renderPet();
            return;
          }
          petData = res.pet;
          cheerPet();
          spawnReaction("⛏️");
          setTimeout(function () { spawnReaction("💪"); }, 150);
          showToast(res.message || "⛏️ ЧЕЛИК отправился в шахту на 1 час!");
          haptic("success");
          renderPet();
        })
        .catch(function (err) {
          busy = false;
          showToast(err && err.message ? err.message : "Ошибка отправки в шахту", true);
          haptic("error");
        });
    }

    function claimPetWorkAction() {
      if (busy) return;
      busy = true;
      petFetch("/work/claim", {
        method: "POST",
        body: JSON.stringify({})
      })
        .then(function (res) {
          busy = false;
          if (res && typeof res.balance === "number") {
            syncCasinoBalance(res.balance);
          }
          if (!res || !res.ok) {
            showToast((res && res.error) || "Не удалось забрать награду", true);
            haptic("error");
            renderPet();
            return;
          }
          petData = res.pet;
          cheerPet();
          spawnReaction("💰");
          setTimeout(function () { spawnReaction("⛏️"); }, 120);
          setTimeout(function () { spawnReaction("🎉"); }, 240);

          var drop = res.lucky_drop;
          if (drop && drop.type === "gem") {
            setTimeout(function () { spawnReaction("💎"); }, 360);
            showToast("💎 УДАЧА! В шахте найден " + drop.name + " (+" + drop.reward + " 💰)!");
          } else if (drop && drop.type === "apple") {
            setTimeout(function () { spawnReaction("🍏"); }, 360);
            setTimeout(function () { spawnReaction("❤️"); }, 450);
            showToast("🍏 НАХОДКА! Шахтёрское яблоко восстановило здоровье (+1 ❤️)!");
          } else {
            showToast("💰 Смена завершена! Добыто " + res.reward + " тугриков!");
          }

          haptic("success");
          renderPet();
        })
        .catch(function (err) {
          busy = false;
          showToast(err && err.message ? err.message : "Ошибка сбора награды", true);
          haptic("error");
        });
    }

    function renderWardrobe() {
      if (!itemsGrid) return;
      itemsGrid.innerHTML = "";

      if (!petData) return;

      var catalog = (petCatalog && petCatalog.length > 0) ? petCatalog : DEFAULT_CATALOG;

      var owned = [];
      if (Array.isArray(petData.items)) {
        owned = petData.items;
      } else if (Array.isArray(petData.inventory)) {
        owned = petData.inventory;
      }

      var eqMap = {};
      if (petData.equipped) {
        if (Array.isArray(petData.equipped)) {
          petData.equipped.forEach(function (id) { if (id) eqMap[id] = true; });
        } else if (typeof petData.equipped === "object") {
          if (petData.equipped.hat) eqMap[petData.equipped.hat] = true;
          if (petData.equipped.neck) eqMap[petData.equipped.neck] = true;
        }
      }

      catalog.forEach(function (item) {
        var isOwned = owned.indexOf(item.id) !== -1;
        var isEq = !!eqMap[item.id];

        var card = document.createElement("div");
        card.className = "pet-card" + (isEq ? " is-equipped" : "");

        var top = document.createElement("div");
        top.className = "pet-card__top";

        var emoji = document.createElement("div");
        emoji.className = "pet-card__emoji";
        emoji.textContent = item.emoji || "✨";

        var info = document.createElement("div");
        info.className = "pet-card__info";

        var name = document.createElement("div");
        name.className = "pet-card__name";
        name.textContent = item.name;

        var price = document.createElement("div");
        price.className = "pet-card__price";
        price.textContent = isOwned ? "В гардеробе" : (item.price + " тугриков");

        info.appendChild(name);
        info.appendChild(price);
        top.appendChild(emoji);
        top.appendChild(info);

        var btn = document.createElement("button");
        btn.type = "button";

        if (!isOwned) {
          btn.className = "pet-card__btn is-buy";
          btn.textContent = "Купить (" + item.price + " 💰)";
          btn.addEventListener("click", function () {
            buyItem(item);
          });
        } else if (isEq) {
          btn.className = "pet-card__btn is-equipped";
          btn.textContent = "✓ Надет (снять)";
          btn.addEventListener("click", function () {
            toggleEquip(item);
          });
        } else {
          btn.className = "pet-card__btn";
          btn.textContent = "Надеть";
          btn.addEventListener("click", function () {
            toggleEquip(item);
          });
        }

        card.appendChild(top);
        card.appendChild(btn);
        itemsGrid.appendChild(card);
      });
    }

    function buyItem(item) {
      if (busy) return;
      var curBal = getEffectiveBalance();
      if (globalUserBalance !== null && curBal < item.price) {
        showToast("Нужно " + item.price + " тугриков (у вас " + curBal + "). Не хватает!", true);
        haptic("error");
        return;
      }

      busy = true;
      petFetch("/buy", {
        method: "POST",
        body: JSON.stringify({ item_id: item.id, itemId: item.id })
      })
        .then(function (res) {
          busy = false;
          if (res && typeof res.balance === "number") {
            syncCasinoBalance(res.balance);
          }
          if (!res || !res.ok) {
            showToast((res && res.error) || "Не удалось купить", true);
            haptic("error");
            renderPet();
            return;
          }
          petData = res.pet;
          cheerPet();
          spawnReaction("✨");
          showToast("Куплено: " + item.name + " 🎉");
          haptic("success");
          renderPet();
        })
        .catch(function (err) {
          busy = false;
          showToast(err && err.message ? err.message : "Ошибка покупки", true);
          haptic("error");
        });
    }

    function toggleEquip(item) {
      if (busy) return;
      busy = true;

      petFetch("/equip", {
        method: "POST",
        body: JSON.stringify({ item_id: item.id, itemId: item.id })
      })
        .then(function (res) {
          busy = false;
          if (!res || !res.ok) {
            showToast((res && res.error) || "Не удалось надеть", true);
            haptic("error");
            return;
          }
          petData = res.pet;
          cheerPet();
          spawnReaction("✨");
          haptic("selection");
          renderPet();
        })
        .catch(function (err) {
          busy = false;
          showToast(err && err.message ? err.message : "Ошибка", true);
          haptic("error");
        });
    }

    function adoptPet(name, errEl) {
      if (busy) return;
      var cleanName = (name || "").trim();
      if (!cleanName) {
        if (errEl) {
          errEl.textContent = "Укажите имя для питомца";
          errEl.hidden = false;
        }
        return;
      }
      if (errEl) errEl.hidden = true;

      var curBal = getEffectiveBalance();
      if (globalUserBalance !== null && curBal < 10) {
        var msg = "Нужно 10 тугриков для создания (у вас " + curBal + "). Сыграйте в казино!";
        if (errEl) {
          errEl.textContent = msg;
          errEl.hidden = false;
        }
        showToast(msg, true);
        haptic("error");
        return;
      }

      busy = true;
      petFetch("/adopt", {
        method: "POST",
        body: JSON.stringify({ name: cleanName })
      })
        .then(function (res) {
          busy = false;
          if (res && typeof res.balance === "number") {
            syncCasinoBalance(res.balance);
          }
          if (!res || !res.ok) {
            var msg = (res && res.error) || "Не удалось завести питомца";
            if (errEl) {
              errEl.textContent = msg;
              errEl.hidden = false;
            }
            showToast(msg, true);
            haptic("error");
            return;
          }
          petData = res.pet;
          cheerPet();
          spawnReaction("🎉");
          spawnReaction("❤️");
          showToast("🎉 Поздравляем с новым питомцем: " + res.pet.name + "!");
          haptic("success");
          renderPet();
        })
        .catch(function (err) {
          busy = false;
          var msg = err && err.message ? err.message : "Ошибка сети";
          if (errEl) {
            errEl.textContent = msg;
            errEl.hidden = false;
          }
          showToast(msg, true);
          haptic("error");
        });
    }

    function feedPet() {
      if (busy || !petData || petData.dead) return;
      if (petData.health >= 5) {
        showToast("Питомец уже сыт и счастлив! (5/5 ❤️)");
        haptic("warning");
        return;
      }
      var curBal = getEffectiveBalance();
      if (globalUserBalance !== null && curBal < 100) {
        showToast("Нужно 100 тугриков на яблоко (у вас " + curBal + "). Сыграйте в казино!", true);
        haptic("error");
        return;
      }

      busy = true;
      petFetch("/feed", {
        method: "POST",
        body: JSON.stringify({})
      })
        .then(function (res) {
          busy = false;
          if (res && typeof res.balance === "number") {
            syncCasinoBalance(res.balance);
          }
          if (!res || !res.ok) {
            showToast((res && res.error) || "Не удалось покормить", true);
            haptic("error");
            renderPet();
            return;
          }
          petData = res.pet;
          cheerPet();
          spawnReaction("🍏");
          setTimeout(function () { spawnReaction("❤️"); }, 150);
          setTimeout(function () { spawnReaction("🥰"); }, 300);
          showToast("🍏 Хрум-хрум! " + petData.name + " подкрепился (+1 ❤️)");
          haptic("success");
          renderPet();
        })
        .catch(function (err) {
          busy = false;
          showToast(err && err.message ? err.message : "Ошибка кормления", true);
          haptic("error");
        });
    }

    function upgradePetAction() {
      if (busy || !petData || petData.dead) return;
      var curLvl = Math.max(1, Math.min(3, parseInt(petData.level, 10) || 1));
      if (curLvl >= 3) {
        showToast("Питомец уже достиг максимального уровня! ⭐⭐⭐");
        return;
      }
      var cost = curLvl === 1 ? 3000 : 6000;
      var curBal = getEffectiveBalance();
      if (globalUserBalance !== null && curBal < cost) {
        showToast("Нужно " + cost + " тугриков для улучшения (у вас " + curBal + "). Не хватает!", true);
        haptic("error");
        return;
      }

      busy = true;
      petFetch("/upgrade", {
        method: "POST",
        body: JSON.stringify({})
      })
        .then(function (res) {
          busy = false;
          if (res && typeof res.balance === "number") {
            syncCasinoBalance(res.balance);
          }
          if (!res || !res.ok) {
            showToast((res && res.error) || "Не удалось улучшить питомца", true);
            haptic("error");
            renderPet();
            return;
          }
          petData = res.pet;
          cheerPet();
          spawnReaction("⚡");
          setTimeout(function () { spawnReaction("⭐"); }, 150);
          setTimeout(function () { spawnReaction("✨"); }, 300);
          setTimeout(function () { spawnReaction("🎉"); }, 450);
          var lvlTitle = (petData && petData.level_title) || ("Уровень " + petData.level);
          showToast("🎉 Питомец эволюционировал! Новая форма: " + lvlTitle + "!");
          haptic("success");
          renderPet();
        })
        .catch(function (err) {
          busy = false;
          showToast(err && err.message ? err.message : "Ошибка улучшения", true);
          haptic("error");
        });
    }

    // Обработчики кликов
    if (upgradeBtn) {
      upgradeBtn.addEventListener("click", upgradePetAction);
    }

    if (petChar) {
      petChar.addEventListener("click", function () {
        if (!petData || petData.dead) return;
        cheerPet();
        var emojis = ["❤️", "💖", "🥰", "✨", "🐾"];
        spawnReaction(emojis[Math.floor(Math.random() * emojis.length)]);
        haptic("light");
      });
    }

    if (adoptBtn) {
      adoptBtn.addEventListener("click", function () {
        adoptPet(nameInput ? nameInput.value : "", adoptErr);
      });
    }

    if (nameInput) {
      nameInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          adoptPet(nameInput.value, adoptErr);
        }
      });
    }

    if (reviveBtn) {
      reviveBtn.addEventListener("click", function () {
        adoptPet(reviveInput ? reviveInput.value : "", reviveErr);
      });
    }

    if (reviveInput) {
      reviveInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          adoptPet(reviveInput.value, reviveErr);
        }
      });
    }

    if (feedBtn) {
      feedBtn.addEventListener("click", feedPet);
    }

    if (mineBtn) {
      mineBtn.addEventListener("click", onMineBtnClick);
    }

    if (navBtn) {
      navBtn.addEventListener("click", function () {
        section.scrollIntoView({ behavior: "smooth", block: "center" });
        cheerPet();
        haptic("light");
        loadPetServer();
      });
    }

    function loadPetServer(force) {
      if (petLoaded && !force) return Promise.resolve();
      return fetchWithRetry((apiBase || "") + "/api/pet", {
        headers: authHeaders()
      }, LOAD_TIMEOUT_MS, 2)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok) {
            petLoaded = true;
            petData = data.pet || null;
            if (typeof data.balance === "number") {
              syncCasinoBalance(data.balance);
            }
            petCatalog = Array.isArray(data.catalog) ? data.catalog : DEFAULT_CATALOG;
            writePetCache({ pet: petData, catalog: petCatalog });
          }
          renderPet();
        })
        .catch(function () {
          if (!petData && loadingEl) loadingEl.textContent = "Не удалось загрузить питомца";
        });
    }

    onMenuToggle(function (open) {
      if (!open) {
        stopWorkTimer();
      } else {
        loadPetServer();
        if (petData && petData.work) renderPetWork(petData.work);
      }
    });

    onVisibilityChange(function (isVisible) {
      if (isVisible) {
        var menu = document.getElementById("menu");
        var isMenuVisible = menu && !menu.hidden;
        if (isMenuVisible && petData && petData.work) {
          renderPetWork(petData.work);
        }
      } else {
        stopWorkTimer();
      }
    });
  }

  function start() {
    initTelegram();
    watchNetlifyBadge();
    bindRefresh();
    bindVisibility();

    // Сначала показываем кэш — экран заполняется мгновенно,
    // даже если бесплатный Render сейчас просыпается.
    var cached = readCache();
    if (cached) {
      state.data = cached.data;
      state.cached = true;
    }

    render();
    initMenu();
    initFun();
    initSupport();
    initChess();
    initTTT();
    initCasino();
    initLeaderboard();
    initPromo();
    initShop();
    initNotes();
    initPet();
    initBlockBlast();
    initWhatsNew();

    // Первичные запросы — только критичные для экрана расписания
    loadChannelHomework();
    fetchSchedule();

    // Монеты за вход начисляем с лёгкой задержкой, чтобы освободить
    // сетевой пул для первого рендера расписания
    setTimeout(casinoClaimDaily, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
