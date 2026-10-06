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

  /* ---------- Плеер ---------- */

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

  /**
   * Netlify добавляет в правый нижний угол плашку «Powered by Netlify»
   * (iframe #nl-badge-frame) с максимальным z-index. Она показывается
   * всем посетителям и перекрывает низ экрана: кнопка списка треков
   * и правая половина полосы перемотки становятся некликабельными.
   *
   * Плашку стоит отключить в настройках проекта, но приложение должно
   * работать и с ней. Поэтому измеряем её высоту и поднимаем плеер
   * ровно на столько — через переменную --badge-offset.
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

    if (measure()) return;

    // Плашку вставляет скрипт Netlify, возможно уже после загрузки
    if (typeof MutationObserver !== "function") return;

    var observer = new MutationObserver(function () {
      if (measure()) observer.disconnect();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Бесконечно следить не нужно
    setTimeout(function () {
      observer.disconnect();
      measure();
    }, 20000);
  }

  /**
   * Полоса плеера внизу экрана: список треков из config.js.
   * Включается вручную — автовоспроизведение в мобильных WebView
   * всё равно заблокировано до касания экрана.
   */
  function initPlayer() {
    var cfg = window.PLAYER || {};
    if (cfg.enabled !== true) return;

    var tracks = playerTracks(cfg);
    if (!tracks.length) return;

    var box = document.getElementById("player");
    var toggle = document.getElementById("playerToggle");
    var titleEl = document.getElementById("playerTitle");
    var bar = document.getElementById("playerBar");
    var progress = document.getElementById("playerProgress");
    var timeEl = document.getElementById("playerTime");
    var queueBtn = document.getElementById("playerQueueBtn");
    var queue = document.getElementById("queue");
    var queueList = document.getElementById("queueList");
    var backdrop = document.getElementById("queueBackdrop");

    if (!box || !toggle || !bar || !progress || !timeEl) return;

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

    box.hidden = false;
    document.body.classList.add("has-player");

    function current() {
      return tracks[index];
    }

    /** Ставит трек по номеру. play — начинать ли воспроизведение. */
    function select(number, play) {
      index = number;
      audio.src = current().src;
      titleEl.textContent = current().title;
      progress.style.width = "0%";
      timeEl.textContent = "0:00";

      if (cfg.rememberLast === true) {
        try {
          localStorage.setItem(LAST_TRACK_KEY, String(index));
        } catch (e) {}
      }

      renderQueue();

      if (play) {
        var started = audio.play();
        if (started && typeof started.catch === "function") {
          started.catch(function (e) {
            console.warn("[player] не удалось начать воспроизведение:", e && e.message);
            render();
          });
        }
      }

      render();
    }

    function render() {
      var duration = audio.duration;
      var ratio = 0;

      if (isFinite(duration) && duration > 0) {
        ratio = Math.max(0, Math.min(1, audio.currentTime / duration));
      }

      progress.style.width = (ratio * 100).toFixed(2) + "%";
      bar.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      timeEl.textContent = core.formatTime(audio.currentTime);

      var playing = !audio.paused;
      box.classList.toggle("is-playing", playing);
      toggle.setAttribute("aria-label", playing ? "Пауза" : "Воспроизвести");
    }

    function renderQueue() {
      if (!queueList) return;

      queueList.textContent = "";

      tracks.forEach(function (track, i) {
        var item = el("button", "queue__item");
        item.type = "button";
        item.classList.toggle("is-current", i === index);

        item.appendChild(el("span", "queue__num", i === index ? "♪" : String(i + 1)));
        item.appendChild(el("span", "queue__name", track.title));
        item.setAttribute("aria-current", i === index ? "true" : "false");

        item.addEventListener("click", function () {
          // Если играл другой трек — новый тоже начнём сразу
          select(i, !audio.paused || i !== index);
          closeQueue();
        });

        queueList.appendChild(item);
      });
    }

    function openQueue() {
      if (!queue || !backdrop) return;

      // Панель встаёт вплотную над полосой плеера. Считаем от низа окна
      // до верха плеера: так учитываются и safe-area, и подъём из-за
      // плашки Netlify — в CSS это не выразить.
      queue.style.bottom = (window.innerHeight - box.getBoundingClientRect().top) + "px";
      queue.hidden = false;
      backdrop.hidden = false;
      queueBtn.setAttribute("aria-expanded", "true");
    }

    function closeQueue() {
      if (!queue || !backdrop) return;

      queue.hidden = true;
      backdrop.hidden = true;
      queueBtn.setAttribute("aria-expanded", "false");
    }

    select(index, false);

    // Кнопка списка нужна, только если треков больше одного
    if (queueBtn && queue && tracks.length > 1) {
      queueBtn.hidden = false;
      queueBtn.addEventListener("click", function () {
        if (queue.hidden) openQueue();
        else closeQueue();
      });
      if (backdrop) backdrop.addEventListener("click", closeQueue);
    }

    toggle.addEventListener("click", function () {
      if (!audio.paused) {
        audio.pause();
        return;
      }

      // play() возвращает промис и может отклониться, если WebView
      // запретил воспроизведение — тогда просто вернём кнопку в исходный вид
      var started = audio.play();

      if (started && typeof started.catch === "function") {
        started.catch(function (e) {
          console.warn("[player] не удалось начать воспроизведение:", e && e.message);
          render();
        });
      }
    });

    bar.addEventListener("click", function (event) {
      if (!isFinite(audio.duration) || audio.duration <= 0) return;

      var rect = bar.getBoundingClientRect();
      if (!rect.width) return;

      var ratio = (event.clientX - rect.left) / rect.width;
      audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
      render();
    });

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
      timeEl.textContent = "ошибка";
      console.warn("[player] не удалось загрузить трек:", current().src);
    });

    render();
    renderQueue();
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
    initPlayer();

    fetchSchedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
