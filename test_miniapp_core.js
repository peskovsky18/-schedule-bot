/**
 * Тесты чистой логики мини-приложения. Зависимостей нет — только Node.
 *
 *     node test_miniapp_core.js
 *
 * Проверяет арифметику, которую легко сломать: даты по Москве, склонения,
 * сортировку пар и режимы «Сегодня / Завтра / Неделя / Всё».
 */

const core = require("./miniapp/assets/js/core.js");

let failed = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${name}` +
      (ok ? "" : `\n      получили: ${JSON.stringify(got)}\n      ждали:    ${JSON.stringify(want)}`)
  );
}

function truthy(name, got, extra) {
  const ok = !!got;
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}` + (extra ? ` — ${extra}` : ""));
}

/* Фиксированные данные, чтобы тест не зависел от сайта */
const TODAY = "2026-10-06";

const DAYS = [
  {
    date: "2026-10-06",
    human: "6 октября, вторник",
    lessons: [
      { time: "15:10–16:40", subject: "Третья", type: "практика", teacher: "—", room: "—" },
      { time: "9:40–11:10", subject: "Вторая", type: "лекция", teacher: "—", room: "—" },
    ],
  },
  {
    date: "2026-10-09",
    human: "9 октября, пятница",
    lessons: [
      { time: "11:20–12:50", subject: "Четвёртая", type: "практика", teacher: "—", room: "—" },
    ],
  },
  {
    // Попадает в окно «Следующая неделя» (сегодня + 8 дней)
    date: "2026-10-14",
    human: "14 октября, среда",
    lessons: [
      { time: "13:30–15:00", subject: "Пятая", type: "лабораторная", teacher: "—", room: "—" },
    ],
  },
];

console.log("=== Даты по Москве ===");
check("полдень UTC — тот же день", core.moscowToday("2026-10-06T12:00:00Z"), "2026-10-06");
check("21:30 UTC — уже следующий день в Москве", core.moscowToday("2026-10-06T21:30:00Z"), "2026-10-07");
check("20:59 UTC — ещё тот же день", core.moscowToday("2026-10-06T20:59:00Z"), "2026-10-06");
check("сложение дней через конец месяца", core.addDays("2026-10-30", 3), "2026-11-02");
check("сложение дней через новый год", core.addDays("2026-12-31", 1), "2027-01-01");
check("человеческая дата", core.humanDate("2026-10-06"), "6 октября, вторник");
check("1 января", core.humanDate("2027-01-01"), "1 января, пятница");

console.log("\n=== Русские склонения ===");
check("1 пара", core.lessonsWord(1), "пара");
check("2 пары", core.lessonsWord(2), "пары");
check("5 пар", core.lessonsWord(5), "пар");
check("11 пар", core.lessonsWord(11), "пар");
check("21 пара", core.lessonsWord(21), "пара");
check("22 пары", core.lessonsWord(22), "пары");

console.log("\n=== Возраст данных ===");
check("меньше минуты", core.formatAge(30), "только что");
check("1 минуту", core.formatAge(60), "1 минуту назад");
check("5 минут", core.formatAge(300), "5 минут назад");
check("2 часа", core.formatAge(7200), "2 ч назад");
check("пустое значение", core.formatAge(null), "");

console.log("\n=== Время трека ===");
check("ноль", core.formatTime(0), "0:00");
check("9 секунд", core.formatTime(9), "0:09");
check("1:05", core.formatTime(65), "1:05");
check("1:53 (длина трека)", core.formatTime(113.76), "1:53");
check("ровно минута", core.formatTime(60), "1:00");
check("час", core.formatTime(3600), "1:00:00");
check("час две минуты пять секунд", core.formatTime(3725), "1:02:05");
check("дробные округляются вниз", core.formatTime(59.9), "0:59");
check("отрицательное не ломает", core.formatTime(-5), "0:00");
check("NaN не ломает", core.formatTime(NaN), "0:00");
check("undefined не ломает", core.formatTime(undefined), "0:00");
check("строка превращается в число", core.formatTime("75"), "1:15");

console.log("\n=== Сортировка пар ===");
check(
  "утренние пары идут первыми",
  core.sortLessons(DAYS[0].lessons).map((l) => l.time),
  ["9:40–11:10", "15:10–16:40"]
);
check("исходный массив не изменён", DAYS[0].lessons[0].time, "15:10–16:40");

console.log("\n=== Режимы ===");
check("«Сегодня» — один день", core.buildView(DAYS, "today", TODAY).length, 1);
check("«Сегодня» — это нужная дата", core.buildView(DAYS, "today", TODAY)[0].date, TODAY);
check("«Сегодня» — подпись", core.buildView(DAYS, "today", TODAY)[0].label, "Сегодня");
check(
  "«Сегодня» — пары отсортированы",
  core.buildView(DAYS, "today", TODAY)[0].lessons.map((l) => l.time),
  ["9:40–11:10", "15:10–16:40"]
);
check("«Завтра» — пустой день", core.buildView(DAYS, "tomorrow", TODAY)[0].isEmpty, true);
check("«Завтра» — подпись", core.buildView(DAYS, "tomorrow", TODAY)[0].label, "Завтра");
check("«Неделя» — семь дней", core.buildView(DAYS, "week", TODAY).length, 7);
check("«Всё» — только дни из данных", core.buildView(DAYS, "all", TODAY).length, 3);
check(
  "«Всё» пропускает прошедшие дни",
  core.buildView(
    [{ date: "2026-10-01", lessons: [] }].concat(DAYS),
    "all",
    TODAY
  ).length,
  3
);

console.log("\n=== Следующая неделя ===");
const next = core.buildView(DAYS, "next", TODAY);
check("семь дней", next.length, 7);
check("начинается с сегодня + 7", next[0].date, "2026-10-13");
check("заканчивается сегодня + 13", next[6].date, "2026-10-19");
check(
  "пары из этого окна на месте",
  next.filter((d) => !d.isEmpty).map((d) => d.date),
  ["2026-10-14"]
);
check(
  "подписи — не «Сегодня» и не «Завтра»",
  next.some((d) => d.label === "Сегодня" || d.label === "Завтра"),
  false
);
check("ни один день не помечен как сегодня", next.some((d) => d.isToday), false);

const week = core.buildView(DAYS, "week", TODAY);
const overlap = week.filter((w) => next.some((n) => n.date === w.date));
check("«Неделя» и «Следующая» не пересекаются", overlap.length, 0);
check(
  "вместе покрывают 14 дней подряд",
  week.length + next.length,
  14
);
check("«Следующая» без данных — 7 пустых дней", core.buildView([], "next", TODAY).length, 7);
check(
  "все дни пустые без данных",
  core.buildView([], "next", TODAY).every((d) => d.isEmpty),
  true
);

console.log("\n=== Пустые данные не ломают интерфейс ===");
check("«Неделя» без данных — 7 дней", core.buildView([], "week", TODAY).length, 7);
check("все дни пустые", core.buildView([], "week", TODAY).every((d) => d.isEmpty), true);
check("«Всё» без данных", core.buildView([], "all", TODAY).length, 0);
check("мусор вместо данных", core.buildView(null, "week", TODAY).length, 7);
check("мусор в «Следующей»", core.buildView(null, "next", TODAY).length, 7);

console.log("\n=== Типы занятий и ссылки ===");
check("лекция", core.typeClass("лекция"), "lecture");
check("практика", core.typeClass("практика"), "practice");
check("лабораторная", core.typeClass("лабораторная"), "lab");
check("зачёт", core.typeClass("зачёт"), "other");
check("пустой тип", core.typeClass(undefined), "other");
check("http-ссылка отброшена", core.moodleLink({ moodle: "http://moodle.herzen.spb.ru" }), null);
check(
  "https-ссылка принята",
  core.moodleLink({ moodle: "https://moodle.herzen.spb.ru/course/view.php?id=1" }),
  "https://moodle.herzen.spb.ru/course/view.php?id=1"
);
check("без ссылки", core.moodleLink({}), null);

console.log("\n=== Рулетка: выбор сектора ===");
check("0 → первый", core.rouletteIndex(0, 2), 0);
check("0.49 → первый", core.rouletteIndex(0.49, 2), 0);
check("0.5 → второй", core.rouletteIndex(0.5, 2), 1);
check("0.999 → второй", core.rouletteIndex(0.999, 2), 1);
check("ровно 1 не выходит за границы", core.rouletteIndex(1, 2), 1);
check("больше 1 тоже безопасно", core.rouletteIndex(1.7, 2), 1);
check("отрицательное → первый", core.rouletteIndex(-3, 2), 0);
check("NaN → первый", core.rouletteIndex(NaN, 2), 0);
check("четыре сектора: 0.3 → второй", core.rouletteIndex(0.3, 4), 1);
check("четыре сектора: 0.99 → четвёртый", core.rouletteIndex(0.99, 4), 3);
check("один сектор", core.rouletteIndex(0.7, 1), 0);
check("нулевое число секторов не ломает", core.rouletteIndex(0.5, 0), 0);

console.log("\n=== Рулетка: честность распределения ===");
// Проверяем не «случайность» (её не доказать), а то, что раскладка
// по секторам равномерная и не смещена к одному краю
[2, 3, 7].forEach(function (n) {
  const hits = new Array(n).fill(0);
  const runs = 60000;
  for (let i = 0; i < runs; i++) hits[core.rouletteIndex(core.randomUnit(), n)]++;

  const expected = runs / n;
  const worst = Math.max(...hits.map((h) => Math.abs(h - expected) / expected));
  truthy(`${n} сектора: перекос ${(worst * 100).toFixed(1)}%`, worst < 0.06,
    hits.map((h) => (h / runs * 100).toFixed(1) + "%").join(" / "));
});

let unitOk = true;
for (let i = 0; i < 5000; i++) {
  const u = core.randomUnit();
  if (!(u >= 0 && u < 1)) { unitOk = false; break; }
}
check("randomUnit всегда в [0, 1)", unitOk, true);

console.log("\n=== Рулетка: угол остановки ===");
const norm = (deg) => ((deg % 360) + 360) % 360;

// Два сектора: центры на 90° и 270°. Указатель сверху, поэтому
// чтобы сектор встал под ним, колесо поворачивается на -центр.
const a0 = core.rouletteStopAngle(0, 2, 0.5);
const a1 = core.rouletteStopAngle(1, 2, 0.5);
truthy(`сектор 0 встаёт под указатель (${a0.toFixed(0)}°)`, Math.abs(norm(a0) - 270) < 1);
truthy(`сектор 1 встаёт под указатель (${a1.toFixed(0)}°)`, Math.abs(norm(a1) - 90) < 1);

// jitter не должен выводить за пределы сектора (полуширина 90°)
let inSector = true;
for (let i = 0; i <= 20; i++) {
  const angle = norm(core.rouletteStopAngle(0, 2, i / 20));
  const diff = Math.abs(((angle - 270 + 540) % 360) - 180);
  if (diff > 90) { inSector = false; break; }
}
check("дрожание не выходит за сектор", inSector, true);

let rangeOk = true;
for (let n = 2; n <= 8; n++) {
  for (let i = 0; i < n; i++) {
    for (const j of [0, 0.5, 1]) {
      const angle = core.rouletteStopAngle(i, n, j);
      if (!(angle >= 0 && angle < 360)) rangeOk = false;
    }
  }
}
check("угол всегда в [0, 360)", rangeOk, true);

console.log(
  failed === 0
    ? "\n✅ Все проверки пройдены"
    : `\n❌ Провалено проверок: ${failed}`
);

process.exit(failed === 0 ? 0 : 1);
