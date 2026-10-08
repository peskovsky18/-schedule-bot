/**
 * Чистая логика мини-приложения: без DOM и без сети.
 *
 * Файл работает и в браузере (window.ScheduleCore), и в Node
 * (module.exports), поэтому его можно покрыть тестами без браузера.
 */
(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ScheduleCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MSK = "Europe/Moscow";

  var WEEKDAYS = [
    "понедельник", "вторник", "среда", "четверг",
    "пятница", "суббота", "воскресенье",
  ];

  var MONTHS_GENITIVE = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];

  /* ---------- Даты ---------- */

  /**
   * Сегодняшняя дата по Москве в формате YYYY-MM-DD.
   * Устройство пользователя может стоять в любом часовом поясе,
   * а расписание учебное, поэтому считаем строго по Москве.
   */
  function moscowToday(now) {
    var d = now ? new Date(now) : new Date();

    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: MSK,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);

    var map = {};
    parts.forEach(function (p) {
      map[p.type] = p.value;
    });

    return map.year + "-" + map.month + "-" + map.day;
  }

  /** Прибавляет дни к ISO-дате, не завися от часового пояса. */
  function addDays(iso, count) {
    var p = String(iso).split("-").map(Number);
    var d = new Date(Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1));
    d.setUTCDate(d.getUTCDate() + count);
    return d.toISOString().slice(0, 10);
  }

  /** '2026-10-06' → '6 октября, вторник' */
  function humanDate(iso) {
    var p = String(iso).split("-").map(Number);
    if (p.length !== 3 || isNaN(p[0])) return String(iso);

    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return p[2] + " " + MONTHS_GENITIVE[p[1] - 1] + ", " + WEEKDAYS[weekdayIndex(d)];
  }

  /** 0 = понедельник … 6 = воскресенье */
  function weekdayIndex(d) {
    return (d.getUTCDay() + 6) % 7;
  }

  /**
   * Понедельник следующей календарной недели.
   *
   * Считаем именно календарную неделю, а не «сегодня плюс семь дней»:
   * расписание в вузе недельное, и неделя начинается в понедельник.
   * В среду «сегодня плюс семь» дало бы следующую среду, и блок
   * «Следующая неделя» начинался бы со среды — это сбивает с толку.
   *
   * Если сегодня понедельник, вернём понедельник через неделю:
   * текущая неделя ещё идёт, и «следующая» — не сегодняшний день.
   */
  function startOfNextWeek(iso) {
    var parts = String(iso).split("-").map(Number);
    if (parts.length !== 3 || isNaN(parts[0])) return iso;

    var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    var shift = 7 - weekdayIndex(d);

    return addDays(iso, shift);
  }

  /** '6 октября, вторник' → '6 октября' (без дня недели) */
  function humanDateShort(iso) {
    return humanDate(iso).split(",")[0];
  }

  /* ---------- Склонения ---------- */

  function plural(n, one, few, many) {
    var mod10 = n % 10;
    var mod100 = n % 100;

    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function lessonsWord(n) {
    return plural(n, "пара", "пары", "пар");
  }

  function minutesWord(n) {
    return plural(n, "минуту", "минуты", "минут");
  }

  /* ---------- Время ---------- */

  /** '11:20–12:50' → 680 (минут от полуночи), для сортировки. */
  function startMinutes(timeStr) {
    var m = /^\s*(\d{1,2}):(\d{2})/.exec(String(timeStr || ""));
    if (!m) return 99 * 60;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function sortLessons(lessons) {
    return (Array.isArray(lessons) ? lessons.slice() : []).sort(function (a, b) {
      return startMinutes(a && a.time) - startMinutes(b && b.time);
    });
  }

  /** «обновлено 5 минут назад» */
  function formatAge(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return "";
    if (seconds < 60) return "только что";

    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " " + minutesWord(minutes) + " назад";

    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " ч назад";

    return Math.floor(hours / 24) + " дн назад";
  }

  /** Секунды в вид «1:23» или «1:02:05» — для плеера. */
  function formatTime(seconds) {
    var total = Math.floor(Number(seconds));

    if (!isFinite(total) || total < 0) total = 0;

    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;

    var mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
    var ss = String(secs).padStart(2, "0");

    return hours > 0 ? hours + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  /* ---------- Виды ---------- */

  function moodleLink(lesson) {
    var url = lesson && lesson.moodle;
    if (!url) return null;
    return /^https:\/\//i.test(url) ? url : null;
  }

  /** CSS-класс для бейджа типа занятия. */
  function typeClass(type) {
    var t = String(type || "").toLowerCase();
    if (t.indexOf("лекц") === 0) return "lecture";
    if (t.indexOf("практ") === 0) return "practice";
    if (t.indexOf("лаб") === 0) return "lab";
    return "other";
  }

  /** Подпись дня: «Сегодня», «Завтра» или человеческая дата. */
  function dayLabel(iso, todayIso) {
    if (iso === todayIso) return "Сегодня";
    if (iso === addDays(todayIso, 1)) return "Завтра";
    return humanDate(iso);
  }

  /**
   * Строит список дней для выбранного режима.
   *
   * Для «Сегодня», «Завтра» и «Недели» дни показываются всегда — даже если
   * пар нет, чтобы пользователь видел ответ, а не пустой экран.
   */
  function buildView(days, mode, todayIso) {
    var today = todayIso || moscowToday();
    var byDate = {};

    (Array.isArray(days) ? days : []).forEach(function (day) {
      if (day && day.date) byDate[day.date] = day;
    });

    function makeDay(iso) {
      var found = byDate[iso];
      var lessons = sortLessons(found && found.lessons);

      return {
        date: iso,
        label: dayLabel(iso, today),
        human: found && found.human ? found.human : humanDate(iso),
        lessons: lessons,
        isEmpty: lessons.length === 0,
        isToday: iso === today,
        isTomorrow: iso === addDays(today, 1),
      };
    }

    if (mode === "today") return [makeDay(today)];
    if (mode === "tomorrow") return [makeDay(addDays(today, 1))];

    if (mode === "week") {
      var week = [];
      for (var i = 0; i < 7; i++) week.push(makeDay(addDays(today, i)));
      return week;
    }

    // Следующая неделя — календарная, с понедельника по воскресенье.
    // Раньше здесь было окно «+7…+13 дней от сегодня», и оно начиналось
    // с того же дня недели, что и сегодня: в среду — со среды.
    if (mode === "next") {
      var nextMonday = startOfNextWeek(today);
      var next = [];
      for (var j = 0; j < 7; j++) next.push(makeDay(addDays(nextMonday, j)));
      return next;
    }

    // Всё, что есть в данных, начиная с сегодня
    return Object.keys(byDate)
      .filter(function (iso) { return iso >= today; })
      .sort()
      .map(makeDay);
  }

  /* ---------- Рулетка ---------- */

  /**
   * Случайное число в [0, 1).
   *
   * Берём криптографический источник, если он доступен: Math.random()
   * даёт предсказуемую последовательность, а тут важно, чтобы результат
   * не зависел от того, сколько раз крутили до этого.
   */
  function randomUnit() {
    if (typeof crypto !== "undefined" && crypto && crypto.getRandomValues) {
      var buffer = new Uint32Array(1);
      crypto.getRandomValues(buffer);
      return buffer[0] / 4294967296;
    }

    return Math.random();
  }

  /**
   * Номер сектора по случайному числу.
   * Границы обрабатываются отдельно: ровно 1 не должно давать лишний индекс.
   */
  function rouletteIndex(unit, count) {
    var n = Math.floor(count);
    if (!isFinite(n) || n < 1) n = 1;

    var value = Number(unit);
    if (!isFinite(value) || value < 0) value = 0;
    if (value >= 1) value = 0.9999999;

    return Math.min(n - 1, Math.floor(value * n));
  }

  /**
   * На какой угол повернуть колесо, чтобы сектор index встал
   * под указателем сверху. Указатель смотрит вниз, в 12 часов.
   *
   * jitter (0…1) сдвигает остановку внутри сектора: без него стрелка
   * всегда вставала бы ровно в середину, и это выглядело бы поддельно.
   */
  function rouletteStopAngle(index, count, jitter) {
    var n = Math.floor(count);
    if (!isFinite(n) || n < 1) n = 1;

    var i = Math.min(n - 1, Math.max(0, Math.floor(index)));
    var span = 360 / n;
    var center = (i + 0.5) * span;

    var j = Number(jitter);
    if (!isFinite(j)) j = 0.5;
    j = Math.max(0, Math.min(1, j));

    // Не даём остановиться у самой кромки сектора
    var offset = (j * 2 - 1) * span * 0.35;

    return ((-center + offset) % 360 + 360) % 360;
  }

  return {
    MSK: MSK,
    WEEKDAYS: WEEKDAYS,
    MONTHS_GENITIVE: MONTHS_GENITIVE,
    moscowToday: moscowToday,
    addDays: addDays,
    humanDate: humanDate,
    humanDateShort: humanDateShort,
    weekdayIndex: weekdayIndex,
    startOfNextWeek: startOfNextWeek,
    plural: plural,
    lessonsWord: lessonsWord,
    startMinutes: startMinutes,
    sortLessons: sortLessons,
    formatAge: formatAge,
    formatTime: formatTime,
    moodleLink: moodleLink,
    typeClass: typeClass,
    dayLabel: dayLabel,
    buildView: buildView,
    randomUnit: randomUnit,
    rouletteIndex: rouletteIndex,
    rouletteStopAngle: rouletteStopAngle,
  };
});
