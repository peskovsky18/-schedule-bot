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

    view.forEach(function (day) {
      box.appendChild(dayCard(day));
    });
  }

  function skeleton() {
    var wrap = el("div", "skeleton");
    for (var i = 0; i < 3; i++) wrap.appendChild(el("div", "skeleton__row"));
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
      list.appendChild(lessonCard(lesson));
    });
    card.appendChild(list);

    return card;
  }

  function lessonCard(lesson) {
    var card = el("article", "lesson");

    card.appendChild(el("div", "lesson__time", lesson.time));

    var body = el("div", "lesson__body");
    body.appendChild(el("h3", "lesson__subject", lesson.subject));

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

    card.appendChild(body);
    return card;
  }

  /* ---------- Треки в меню ---------- */

  var LAST_TRACK_KEY = "player.track";

  /**
   * Приводит настройки к единому виду: список треков.
   * Поддерживает старый формат с одной дорожкой (src + title).
   */
  function playerTracks(cfg) {
    if (Array.isArray(cfg.tracks) && cfg.tracks.length) {
      return cfg.tracks.filter(function (t) {
        return t && t.src;
      });
    }

    if (cfg.src) {
      return [{ title: cfg.title || "Трек", src: cfg.src }];
    }

    return [];
  }

  function playIcon(className) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);

    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute(
      "d",
      className === "icon-pause" ? "M6 5h4v14H6zM14 5h4v14h-4z" : "M8 5v14l11-7z"
    );

    svg.appendChild(path);
    return svg;
  }

  /**
   * Треки живут в меню, а не в полосе внизу экрана.
   * Воспроизведение переживает закрытие меню: элемент один на всё
   * приложение, а список лишь отражает его состояние.
   */
  function initTracks() {
    var cfg = window.PLAYER || {};
    var box = document.getElementById("tracks");

    if (!box || cfg.enabled !== true) return;

    var builtin = playerTracks(cfg);
    var tracks = builtin.slice(); // дополняется треками из приложения

    if (!tracks.length) return;

    var index = 0;

    // Возвращаемся к треку, который слушали в прошлый раз
    if (cfg.rememberLast === true) {
      try {
        var saved = parseInt(localStorage.getItem(LAST_TRACK_KEY), 10);
        if (isFinite(saved) && saved >= 0 && saved < tracks.length) index = saved;
      } catch (e) {}
    }

    var audio = new Audio();
    // preload="none": файл скачивается только после нажатия play,
    // поэтому общий вес дорожек не влияет на скорость открытия
    audio.preload = "none";

    var volume = Number(cfg.volume);
    if (isFinite(volume) && volume >= 0 && volume <= 1) audio.volume = volume;

    var rows = [];

    function current() {
      return tracks[index];
    }

    /** Строит строки один раз; дальше только обновляем состояние. */
    function build() {
      box.textContent = "";
      rows = [];

      tracks.forEach(function (track, i) {
        // Строка — не кнопка, а контейнер с role="button": внутрь кнопки
        // нельзя вложить кнопку удаления, это неверная разметка
        var row = el("div", "track");
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");

        row.appendChild(el("span", "track__num", String(i + 1)));

        var body = el("span", "track__body");

        if (track.custom) {
          body.appendChild(el("span", "track__name", track.title));
          body.appendChild(el("span", "track__author",
            "добавил " + (track.author || "кто-то")));
        } else {
          body.appendChild(el("span", "track__name", track.title));
        }

        var bar = el("span", "track__bar");
        var progress = el("span", "track__progress");
        bar.appendChild(progress);
        body.appendChild(bar);

        body.appendChild(el("span", "track__time", "0:00"));
        row.appendChild(body);

        var icon = el("span", "track__icon");
        icon.appendChild(playIcon("icon-play"));
        icon.appendChild(playIcon("icon-pause"));
        row.appendChild(icon);

        function activate() {
          if (i === index) {
            toggle();
            return;
          }
          // Другой трек — переключаемся и сразу играем
          select(i, true);
        }

        row.addEventListener("click", activate);
        row.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate();
          }
        });

        if (track.canDelete) {
          var remove = el("button", "track__remove", "✕");
          remove.type = "button";
          remove.setAttribute("aria-label", "Удалить трек «" + track.title + "»");
          remove.addEventListener("click", function (event) {
            event.stopPropagation();
            requestDelete(track);
          });
          row.appendChild(remove);
        }

        box.appendChild(row);
        rows.push({ row: row, progress: progress, time: body.querySelector(".track__time") });
      });
    }

    function select(number, play) {
      index = number;
      audio.src = current().src;

      if (cfg.rememberLast === true) {
        try {
          localStorage.setItem(LAST_TRACK_KEY, String(index));
        } catch (e) {}
      }

      if (play) {
        // Явный load() перед play(): без него элемент иногда навсегда
        // застревает в состоянии загрузки (readyState 0) — новый src
        // не запрашивается, и трек молчит. Проверено на живом сайте.
        try {
          audio.load();
        } catch (e) {}

        var started = audio.play();
        if (started && typeof started.catch === "function") {
          started.catch(function (e) {
            console.warn("[tracks] не удалось начать воспроизведение:", e && e.message);
            render();
          });
        }
      }

      render();
    }

    function toggle() {
      if (!audio.paused) {
        audio.pause();
        return;
      }

      var started = audio.play();
      if (started && typeof started.catch === "function") {
        started.catch(function (e) {
          console.warn("[tracks] не удалось начать воспроизведение:", e && e.message);
          render();
        });
      }
    }

    function render() {
      var duration = audio.duration;
      var ratio = 0;

      if (isFinite(duration) && duration > 0) {
        ratio = Math.max(0, Math.min(1, audio.currentTime / duration));
      }

      rows.forEach(function (item, i) {
        var isCurrent = i === index;

        item.row.classList.toggle("is-current", isCurrent);
        item.row.classList.toggle("is-playing", isCurrent && !audio.paused);
        item.row.setAttribute("aria-current", isCurrent ? "true" : "false");
        item.row.querySelector(".track__num").textContent = isCurrent ? "♪" : String(i + 1);

        if (isCurrent) {
          item.progress.style.width = (ratio * 100).toFixed(2) + "%";
          item.time.textContent = core.formatTime(audio.currentTime);
        }
      });
    }

    select(index, false);
    build();
    render();

    audio.addEventListener("timeupdate", render);
    audio.addEventListener("durationchange", render);
    audio.addEventListener("play", render);
    audio.addEventListener("pause", render);
    audio.addEventListener("ended", function () {
      // autoNext выключен по умолчанию: трек просто останавливается
      if (cfg.autoNext === true && index < tracks.length - 1) {
        select(index + 1, true);
        return;
      }

      audio.currentTime = 0;
      render();
    });
    audio.addEventListener("error", function () {
      console.warn("[tracks] не удалось загрузить трек:", current().src);
    });

    /* ---- треки, добавленные через приложение ---- */

    /** Путь с сервера превращаем в полный адрес. */
    function withApiBase(src) {
      return src && src.charAt(0) === "/" ? (apiBase || "") + src : src;
    }

    function loadCustom() {
      // Подпись обязательна: по ней сервер решает, можно ли удалять
      // трек. Без неё свои же треки помечались как чужие.
      return fetchWithRetry((apiBase || "") + "/api/music", { headers: authHeaders() },
                            LOAD_TIMEOUT_MS, 3)
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (!data || data.ok !== true) return;

          if (data.maxUploadBytes) musicMaxBytes = data.maxUploadBytes;

          var added = (data.tracks || []).map(function (track) {
            return {
              id: track.id,
              title: track.title,
              src: withApiBase(track.src),
              custom: true,
              author: track.addedBy,
              canDelete: track.canDelete,
            };
          });

          tracks = builtin.concat(added);
          build();
          render();
        })
        .catch(function (error) {
          console.warn("[music] добавленные треки не загрузились:", error && error.message);
        });
    }

    // Форма добавления живёт отдельно, но после успешной загрузки
    // ей нужно обновить этот список
    reloadCustomTracks = loadCustom;

    /**
     * Удаление в два нажатия.
     *
     * Первое нажатие показывает предупреждение, второе удаляет.
     * Так обходимся без системного окна подтверждения: в WebView
     * Telegram оно может не показаться вовсе, и удаление просто
     * не сработает.
     */
    function requestDelete(track) {
      if (pendingDelete === track.id) {
        clearTimeout(pendingTimer);
        pendingDelete = null;
        removeTrack(track);
        return;
      }

      pendingDelete = track.id;
      showMusicNote("Нажмите ✕ ещё раз, чтобы удалить «" + track.title + "»");

      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {
        pendingDelete = null;
        showMusicNote("");
      }, 5000);
    }

    function removeTrack(track) {
      showMusicNote("Удаляю…");

      fetchWithTimeout((apiBase || "") + "/api/music/" + encodeURIComponent(track.id) + "/delete", {
        method: "POST",
        headers: authHeaders(),
      })
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (!data || data.ok !== true) {
            throw new Error((data && data.error) || "Не получилось удалить");
          }

          showMusicNote("Трек удалён", "is-done");
          return loadCustom();
        })
        .catch(function (error) {
          showMusicNote(error.message, "is-error");
        });
    }
  }

  /* ---------- Добавление музыки ---------- */

  // Обновление списка добавленных треков. Ставит initTracks.
  var reloadCustomTracks = null;

  // Отметка о треке, который ждёт подтверждения удаления
  var pendingDelete = null;
  var pendingTimer = null;

  // Предел размера файла. Значение приходит с сервера вместе со списком,
  // чтобы не держать одно и то же число в двух местах.
  var musicMaxBytes = 6 * 1024 * 1024;

  function showMusicNote(text, tone) {
    var note = document.getElementById("musicNote");
    if (!note) return;

    note.textContent = text || "";
    note.className = "music__note" + (tone ? " " + tone : "");
  }

  /**
   * Форма добавления трека.
   *
   * Файл уходит на сервер и хранится в Redis: мини-приложение
   * статическое, файлы ему хранить негде.
   */
  function initMusic() {
    var cfg = window.PLAYER || {};
    var box = document.getElementById("music");

    if (!box || cfg.enabled !== true) return;

    var addBtn = document.getElementById("musicAdd");
    var form = document.getElementById("musicForm");
    var titleInput = document.getElementById("musicTitle");
    var fileInput = document.getElementById("musicFile");
    var urlInput = document.getElementById("musicUrl");
    var submitBtn = document.getElementById("musicSubmit");
    var cancelBtn = document.getElementById("musicCancel");
    var pickText = document.getElementById("musicPickText");
    var pickLabel = box.querySelector(".music__pick");

    if (!addBtn || !form || !titleInput || !fileInput || !submitBtn) return;

    function openForm() {
      form.hidden = false;
      addBtn.hidden = true;
      showMusicNote("");
      titleInput.focus();
    }

    function closeForm() {
      form.hidden = true;
      addBtn.hidden = false;
      form.reset();
      showMusicNote("");
      showPickedFile();
    }

    /** Подписываем кнопку выбранным файлом, чтобы выбор был виден. */
    function showPickedFile() {
      var file = fileInput.files && fileInput.files[0];

      if (pickText) {
        pickText.textContent = file
          ? file.name
          : "Выбрать файл на телефоне";
      }

      if (pickLabel) {
        pickLabel.classList.toggle("is-chosen", !!file);
      }
    }

    addBtn.addEventListener("click", openForm);
    if (cancelBtn) cancelBtn.addEventListener("click", closeForm);

    fileInput.addEventListener("change", showPickedFile);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      upload();
    });

    function upload() {
      var title = titleInput.value.trim();
      var file = fileInput.files && fileInput.files[0];
      var url = urlInput ? urlInput.value.trim() : "";

      if (!title) {
        showMusicNote("Укажите название трека", "is-error");
        return;
      }

      if (!file && !url) {
        showMusicNote("Выберите файл или вставьте ссылку", "is-error");
        return;
      }

      if (file && file.size > musicMaxBytes) {
        showMusicNote("Файл больше " + Math.round(musicMaxBytes / 1024 / 1024) +
          " МБ — выберите поменьше", "is-error");
        return;
      }

      var data = new FormData();
      data.append("title", title);
      if (file) data.append("audio", file);
      else data.append("url", url);

      // XHR, а не fetch: только он умеет сообщать о ходе загрузки,
      // а несколько мегабайт по мобильной сети идут заметное время
      var request = new XMLHttpRequest();
      request.open("POST", (apiBase || "") + "/api/music");

      var initData = telegramInitData();
      if (initData) request.setRequestHeader("X-Telegram-Init-Data", initData);
      // Content-Type не задаём: браузер сам добавит границу multipart

      submitBtn.disabled = true;
      showMusicNote("Загружаю…");

      request.upload.onprogress = function (event) {
        if (!event.lengthComputable) return;
        showMusicNote("Загружаю: " + Math.round((event.loaded / event.total) * 100) + "%");
      };

      request.onload = function () {
        submitBtn.disabled = false;

        var answer = null;
        try {
          answer = JSON.parse(request.responseText);
        } catch (e) {}

        if (request.status !== 200 || !answer || answer.ok !== true) {
          showMusicNote((answer && answer.error) || ("Сервер ответил " + request.status), "is-error");
          return;
        }

        closeForm();
        showMusicNote("Трек добавлен", "is-done");

        if (typeof reloadCustomTracks === "function") reloadCustomTracks();
      };

      request.onerror = function () {
        submitBtn.disabled = false;
        showMusicNote("Сеть недоступна — попробуйте ещё раз", "is-error");
      };

      request.send(data);
    }
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

    if (prefersReducedMotion()) {
      wheel.style.transition = "none";
    } else {
      wheel.style.transitionDuration = (spinMs / 1000) + "s";
      wheel.style.transitionTimingFunction = "cubic-bezier(0.17, 0.67, 0.16, 1)";
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

    /** Доска видна, только когда открыто меню и раскрыты «Приколы». */
    function boardVisible() {
      return menuOpen && funOpen;
    }

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

    // Опрашиваем, только пока доска на экране: нужно и открытое меню,
    // и раскрытые «Приколы». В свёрнутом виде запросы были бы впустую.
    onMenuToggle(function (open) {
      menuOpen = open;
      if (open && funOpen) refresh().then(maybePoll);
      else stopPolling();
    });

    onFunToggle(function (open) {
      funOpen = open;
      if (open && menuOpen) refresh().then(maybePoll);
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
      fetchSchedule().then(function () {
        setTimeout(function () { btn.classList.remove("is-spinning"); }, 400);
      });
    });
  }

  /** Обновляем данные, если приложение вернулось на экран спустя время. */
  function bindVisibility() {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
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
    var betsBox = document.getElementById("casinoBets");
    var spinBtn = document.getElementById("casinoSpin");

    if (!balanceEl || !reelsBox || !betsBox || !spinBtn) return;

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

    function renderBets() {
      if (!casinoPlayer || betsBox.childElementCount) return;

      casinoPlayer.bets.forEach(function (value) {
        var button = el("button", "casino__bet", String(value));
        button.type = "button";
        button.dataset.bet = value;

        button.addEventListener("click", function () {
          if (spinning) return;
          bet = value;
          try {
            localStorage.setItem(CASINO_BET_KEY, String(value));
          } catch (e) {}
          render();
        });

        betsBox.appendChild(button);
      });
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

      Array.prototype.forEach.call(betsBox.children, function (button) {
        button.classList.toggle("is-active", Number(button.dataset.bet) === bet);
        button.disabled = spinning;
      });

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
        showNote("Джекпот! +" + tugriks(result.win), "is-jackpot");
      } else if (result.multiplier > 1) {
        showNote("Выигрыш +" + tugriks(result.win), "is-win");
      } else if (result.multiplier === 1) {
        showNote("Ставка вернулась", "is-lose");
      } else {
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

    function loadState() {
      return fetchWithRetry((apiBase || "") + "/api/casino", { headers: authHeaders() },
                            LOAD_TIMEOUT_MS, 3)
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (!data || data.ok !== true) return;
          casinoPlayer = data.player;
          render();
        })
        .catch(function (error) {
          console.warn("[casino] состояние не загрузилось:", error && error.message);
        });
    }

    casinoRender = render;

    spinBtn.addEventListener("click", spin);

    if (casinoPlayer) render();
    loadState();
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
          if (result.data.player && typeof casinoRender === "function") {
            casinoPlayer = result.data.player;
            casinoRender();
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
        buy.textContent = balance >= item.price ? "Купить" : "Не хватает тугриков";
        buy.disabled = balance < item.price;
        buy.addEventListener("click", function () { openForm(item); });

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
          balance = data.balance || 0;
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

          balance = data.player ? data.player.balance : balance;
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

    load();
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
    initRoulette();
    initTracks();
    initMusic();
    initCasino();
    initPromo();
    initShop();
    initWhatsNew();

    // Список треков из config.js уже нарисован; дополняем его тем,
    // что добавлено через приложение
    if (typeof reloadCustomTracks === "function") reloadCustomTracks();

    // Монеты за вход начисляем при каждом запуске: сервер сам решит,
    // положено ли что-то сегодня
    casinoClaimDaily();

    fetchSchedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
