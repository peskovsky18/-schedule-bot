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
check("«Всё» — только дни из данных", core.buildView(DAYS, "all", TODAY).length, 2);
check(
  "«Всё» пропускает прошедшие дни",
  core.buildView(
    [{ date: "2026-10-01", lessons: [] }].concat(DAYS),
    "all",
    TODAY
  ).length,
  2
);

console.log("\n=== Пустые данные не ломают интерфейс ===");
check("«Неделя» без данных — 7 дней", core.buildView([], "week", TODAY).length, 7);
check("все дни пустые", core.buildView([], "week", TODAY).every((d) => d.isEmpty), true);
check("«Всё» без данных", core.buildView([], "all", TODAY).length, 0);
check("мусор вместо данных", core.buildView(null, "week", TODAY).length, 7);

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

console.log(
  failed === 0
    ? "\n✅ Все проверки пройдены"
    : `\n❌ Провалено проверок: ${failed}`
);

process.exit(failed === 0 ? 0 : 1);
