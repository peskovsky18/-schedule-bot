/**
 * Интерфейс мини-приложения: сеть, кэш, отрисовка.
 *
 * Вся арифметика вынесена в core.js — здесь только DOM и запросы.
 */
(function () {
  "use strict";

  var core = window.ScheduleCore;

  var CACHE_KEY = "schedule.cache.v2";
  var API_KEY = "schedule.apiBase";
  var CACHE_TTL = 5 * 60 * 1000; // 5 минут, как и на сервере

  var MODES = [
    { id: "today", title: "Сегодня" },
    { id: "tomorrow", title: "Завтра" },
    { id: "week", title: "Неделя" },
    { id: "next", title: "Следующая" },
    { id: "all", title: "Всё" },
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

        state.data = data;
        state.cached = false;
        state.loading = false;
        writeCache(data);
        render();
      })
      .catch(function (err) {
        state.loading = false;
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
    var sub = document.getElementById("groupSub");
    if (!box) return;

    var info = (state.data && state.data.group) || {};
    var name = info.name || "Расписание";

    box.textContent = name;

    var parts = [];
    if (info.institute) parts.push(info.institute);
    if (info.program) parts.push(info.program);

    sub.textContent = parts.join(" · ");
    sub.hidden = parts.length === 0;

    document.title = name + " — расписание";
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

  /* ---------- Скример ---------- */

  /**
   * Розыгрыш: через delayMs после открытия на весь экран появляется
   * картинка. Закрывается крестиком, тапом в любом месте или сама
   * через durationMs.
   *
   * Настройки — в config.js (window.SCREAMER). Выключить: enabled: false.
   */
  function initScreamer() {
    var cfg = window.SCREAMER || {};
    if (cfg.enabled !== true) return;

    var delay = Number(cfg.delayMs);
    var duration = Number(cfg.durationMs);
    var src = cfg.image || "assets/img/scare.jpg";

    if (!isFinite(delay) || delay < 0) delay = 30000;
    if (!isFinite(duration) || duration <= 0) duration = 3000;

    // Картинку готовим заранее и показываем ровно этот элемент.
    // Если создать новый <img> в момент показа, он начнёт загрузку
    // заново, и вместо лица на мгновение мелькнёт чёрный экран.
    var imgEl = new Image();
    imgEl.className = "screamer__img";
    imgEl.alt = "";
    // cover заполняет экран с обрезкой краёв, contain показывает целиком
    imgEl.style.objectFit = cfg.fit === "contain" ? "contain" : "cover";
    imgEl.src = src;

    var overlay = null;
    var autoClose = null;
    var timer = null;

    // Отсчитываем время только пока приложение на экране. В Telegram
    // WebView затормаживает таймеры в фоне, и без этого розыгрыш мог
    // сработать при заблокированном экране — то есть пропасть зря.
    var remaining = delay;
    var startedAt = 0;

    function startTimer() {
      if (timer || overlay || remaining <= 0) return;
      startedAt = Date.now();
      timer = setTimeout(show, remaining);
    }

    function pauseTimer() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      remaining -= Date.now() - startedAt;
      if (remaining < 0) remaining = 0;
    }

    function close() {
      if (autoClose) {
        clearTimeout(autoClose);
        autoClose = null;
      }
      if (!overlay) return;

      overlay.remove();
      overlay = null;
    }

    function show() {
      timer = null;
      if (overlay) return;

      overlay = el("div", "screamer");

      // Уже загруженный заранее элемент — показывается мгновенно
      overlay.appendChild(imgEl);

      var btn = el("button", "screamer__close", "✕");
      btn.type = "button";
      btn.setAttribute("aria-label", "Закрыть");
      btn.addEventListener("click", function (event) {
        event.stopPropagation();
        close();
      });
      overlay.appendChild(btn);

      // Тап в любом месте тоже закрывает — так розыгрыш не затягивается
      overlay.addEventListener("click", close);

      document.body.appendChild(overlay);

      // Класс добавляем после вставки в документ, иначе переход
      // прозрачности не сработает и картинка останется невидимой.
      var reveal = function () {
        if (overlay) overlay.classList.add("is-visible");
      };

      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(reveal);
      } else {
        reveal();
      }

      autoClose = setTimeout(close, duration);
    }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") startTimer();
      else pauseTimer();
    });

    // Если страница открылась в фоне, отсчёт начнётся при возвращении
    if (document.visibilityState === "visible") startTimer();
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

    var tracks = playerTracks(cfg);
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
        var row = el("button", "track");
        row.type = "button";

        row.appendChild(el("span", "track__num", String(i + 1)));

        var body = el("span", "track__body");
        body.appendChild(el("span", "track__name", track.title));

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

        row.addEventListener("click", function () {
          if (i === index) {
            toggle();
            return;
          }
          // Другой трек — переключаемся и сразу играем
          select(i, true);
        });

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
  }

  /* ---------- Меню ---------- */

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
    }

    function close() {
      menu.hidden = true;
      if (backdrop) backdrop.hidden = true;
      openBtn.setAttribute("aria-expanded", "false");
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
    initScreamer();
    initMenu();
    initTracks();

    fetchSchedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
