/**
 * Тесты чистой логики мини-приложения. Зависимостей нет — только Node.
 *
 *     node test_miniapp_core.js
 *
 * Проверяет арифметику, которую легко сломать: даты по Москве, склонения,
 * сортировку пар, режимы расписания, рулетку и разбор шахматной доски.
 */

const core = require("./miniapp/assets/js/core.js");
const chess = require("./miniapp/assets/js/chess.js");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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

console.log("\n=== Шахматы: разбор FEN ===");
const startBoard = chess.parseFen(START_FEN);
truthy("стартовая позиция разобрана", startBoard !== null);
check("восемь строк", startBoard.length, 8);
check("восемь клеток в строке", startBoard[0].length, 8);
check("первая строка — чёрные фигуры", startBoard[0].join(""), "rnbqkbnr");
check("последняя — белые", startBoard[7].join(""), "RNBQKBNR");
check("третья строка пуста", startBoard[2].every((c) => c === null), true);

check("битый FEN — null", chess.parseFen("чепуха"), null);
check("неполный FEN — null", chess.parseFen("rnbqkbnr/pppppppp"), null);
check("лишние клетки в строке — null", chess.parseFen("rnbqkbnrr/8/8/8/8/8/8/8"), null);
check("пустая строка — null", chess.parseFen(""), null);
check("полный FEN с полями разбирается", chess.parseFen("8/8/8/4k3/8/8/8/4K3 w - - 0 1") !== null, true);

console.log("\n=== Шахматы: клетки ===");
check("e4 → file 4, rank 3", chess.parseSquare("e4"), { file: 4, rank: 3 });
check("a1 → file 0, rank 0", chess.parseSquare("a1"), { file: 0, rank: 0 });
check("h8 → file 7, rank 7", chess.parseSquare("h8"), { file: 7, rank: 7 });
check("заглавные приводятся", chess.parseSquare("E4"), { file: 4, rank: 3 });
check("лишние пробелы не мешают", chess.parseSquare("  e4 "), { file: 4, rank: 3 });
check("мусор → null", chess.parseSquare("z9"), null);
check("короткая строка → null", chess.parseSquare("e"), null);

check("обратно в имя", chess.squareName(4, 3), "e4");
check("за границей → null", chess.squareName(8, 0), null);

check("a1 тёмная", chess.isLightSquare(0, 0), false);
check("h1 светлая", chess.isLightSquare(7, 0), true);
check("a8 светлая", chess.isLightSquare(0, 7), true);
check("e4 светлая", chess.isLightSquare(4, 3), true);

console.log("\n=== Шахматы: отрисовка доски ===");
const cells = chess.boardCells(START_FEN);
check("всего 64 клетки", cells.length, 64);
check("первая клетка — a8", cells[0].square, "a8");
check("последняя — h1", cells[63].square, "h1");
check("на a8 чёрная ладья", cells[0].code, "r");
check("на e1 белый король", cells[60].code, "K");
check("пустая клетка — null", cells[16].code, null);
check("цвет клетки a8", cells[0].light, true);
check("цвет клетки a1", cells[56].light, false);

console.log("\n=== Шахматы: фигуры ===");
check("символ короля", chess.pieceGlyph("k"), "♚");

// Пешка — единственный шахматный символ, который входит в набор эмодзи
// (U+265F, см. emoji-data.txt). Без селектора U+FE0E телефоны рисуют её
// эмодзи, а эмодзи игнорирует CSS-заливку: белая пешка выглядела чёрной.
truthy("у пешки селектор текстового начертания",
  chess.pieceGlyph("p").endsWith("\uFE0E"),
  JSON.stringify(chess.pieceGlyph("p")));
check("белая пешка — тот же символ с селектором", chess.pieceGlyph("P"), chess.pieceGlyph("p"));
check("сам символ пешки не изменился", chess.pieceGlyph("p")[0], "♟");

// Остальные фигуры в набор эмодзи не входят, и селектор им не нужен:
// для неэмодзи-символов вариационные селекторы не определены
["k", "q", "r", "b", "n"].forEach(function (code) {
  truthy("у «" + chess.pieceName(code) + "» лишнего селектора нет",
    !chess.pieceGlyph(code).endsWith("\uFE0E"));
});
check("регистр не важен", chess.pieceGlyph("Q"), "♛");
check("пустая клетка — пусто", chess.pieceGlyph(null), "");
check("название фигуры", chess.pieceName("n"), "конь");
check("неизвестный код — пусто", chess.pieceGlyph("x"), "");

check("заглавная — белая", chess.isWhitePiece("K"), true);
check("строчная — чёрная", chess.isWhitePiece("k"), false);
check("пустая клетка не фигура", chess.isWhitePiece(null), false);
check("цвет белой", chess.pieceColor("R"), "white");
check("цвет чёрной", chess.pieceColor("r"), "black");

console.log("\n=== Шахматы: король и превращение ===");
check("белый король на e1", chess.findKing(START_FEN, "white"), "e1");
check("чёрный король на e8", chess.findKing(START_FEN, "black"), "e8");
check("на пустой доске короля нет", chess.findKing("8/8/8/8/8/8/8/8 w - - 0 1", "white"), null);

// Белая пешка на e7 может пойти на e8 с превращением
const promo = "8/4P3/8/8/8/8/8/8 w - - 0 1";
check("пешка на предпоследней — нужно превращение", chess.needsPromotion(promo, "e7", "e8"), true);
check("обычный ход пешки — не нужно", chess.needsPromotion(START_FEN, "e2", "e4"), false);
check("ход не пешкой — не нужно", chess.needsPromotion(START_FEN, "g1", "f3"), false);
check("уже на последней — не нужно", chess.needsPromotion("4Q3/8/8/8/8/8/8/8 w - - 0 1", "e8", "e8"), false);

// Чёрная пешка идёт вниз, на первую горизонталь
const blackPromo = "8/8/8/8/8/8/4p3/8 b - - 0 1";
check("чёрная пешка на e2 — превращение на e1", chess.needsPromotion(blackPromo, "e2", "e1"), true);

console.log("\n=== Шахматы: подсказки и результат ===");
const legal = { e2: ["e3", "e4"], g1: ["f3", "h3"] };
check("цели для e2", chess.targetsFrom(legal, "e2"), ["e3", "e4"]);
check("нет клетки — пусто", chess.targetsFrom(legal, "d4"), []);
check("мусор вместо подсказок", chess.targetsFrom(null, "e2"), []);
check("ходы есть", chess.hasMoves(legal), true);
check("пустой объект — ходов нет", chess.hasMoves({}), false);
check("клетки без целей — ходов нет", chess.hasMoves({ e2: [] }), false);

check("победа белых глазами белых", chess.resultText("1-0", "white"), "Вы победили");
check("поражение белых", chess.resultText("0-1", "white"), "Вы проиграли");
check("победа чёрных глазами чёрных", chess.resultText("0-1", "black"), "Вы победили");
check("ничья", chess.resultText("1/2-1/2", "white"), "Ничья");
check("без результата — пусто", chess.resultText(null, "white"), "");
check("результат без зрителя", chess.resultText("1-0", null), "Победили белые");

console.log(
  failed === 0
    ? "\n✅ Все проверки пройдены"
    : `\n❌ Провалено проверок: ${failed}`
);

process.exit(failed === 0 ? 0 : 1);
