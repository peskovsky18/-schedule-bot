/**
 * Логика шахматной доски: без DOM и без сети.
 *
 * Сервер присылает позицию строкой FEN и список легальных ходов. Здесь
 * только разбор этого в клетки и мелкие правила отображения — сами
 * правила игры проверяет сервер, дублировать их на клиенте нельзя,
 * иначе однажды они разойдутся.
 *
 * Файл работает и в браузере (window.ChessBoard), и в Node
 * (module.exports), поэтому тестируется без браузера.
 */
(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ChessBoard = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var FILES = "abcdefgh";

  // Взяты «чёрные» начертания: они сплошные. Белые фигуры рисуем тем же
  // символом, но светлой заливкой с тёмной обводкой — так они одинаково
  // выглядят на всех платформах, в отличие от контурных ♔♕♖.
  var GLYPHS = {
    k: "♚",
    q: "♛",
    r: "♜",
    b: "♝",
    n: "♞",
    p: "♟",
  };

  var NAMES = {
    k: "король",
    q: "ферзь",
    r: "ладья",
    b: "слон",
    n: "конь",
    p: "пешка",
  };

  /** «4» → 4, буква фигуры → 1 */
  function _count(token) {
    return token >= "1" && token <= "8" ? parseInt(token, 10) : 1;
  }

  /**
   * FEN → восемь строк по восемь клеток.
   * Первая строка — восьмая горизонталь, как на доске сверху вниз.
   */
  function parseFen(fen) {
    var placement = String(fen || "").trim().split(/\s+/)[0];
    if (!placement) return null;

    var rows = placement.split("/");
    if (rows.length !== 8) return null;

    var board = [];

    for (var r = 0; r < 8; r++) {
      var row = [];
      var rank = rows[r];

      for (var i = 0; i < rank.length; i++) {
        var token = rank[i];

        if (/[1-8]/.test(token)) {
          for (var n = 0; n < _count(token); n++) row.push(null);
        } else if (/[prnbqkPRNBQK]/.test(token)) {
          row.push(token);
        } else {
          return null;
        }
      }

      if (row.length !== 8) return null;
      board.push(row);
    }

    return board;
  }

  /** «e4» → { file: 4, rank: 3 }; нумерация с нуля, как в массиве */
  function parseSquare(square) {
    var text = String(square || "").trim().toLowerCase();
    if (text.length !== 2) return null;

    var file = FILES.indexOf(text[0]);
    var rank = "12345678".indexOf(text[1]);

    if (file < 0 || rank < 0) return null;
    return { file: file, rank: rank };
  }

  /** { file: 4, rank: 3 } → «e4» */
  function squareName(file, rank) {
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return FILES[file] + String(rank + 1);
  }

  /**
   * Светлая ли клетка. a1 тёмная, h1 светлая — отсюда сумма координат:
   * у a1 (0+0) чётная, у h1 (7+0) нечётная.
   */
  function isLightSquare(file, rank) {
    return (file + rank) % 2 === 1;
  }

  /** Клетки в порядке отрисовки: сверху вниз, слева направо. */
  function boardCells(fen) {
    var board = parseFen(fen);
    if (!board) return null;

    var cells = [];

    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var rank = 7 - r; // первая строка FEN — восьмая горизонталь
        cells.push({
          square: squareName(f, rank),
          code: board[r][f],
          file: f,
          rank: rank,
          light: isLightSquare(f, rank),
        });
      }
    }

    return cells;
  }

  function pieceGlyph(code) {
    if (!code) return "";
    return GLYPHS[String(code).toLowerCase()] || "";
  }

  function pieceName(code) {
    if (!code) return "";
    return NAMES[String(code).toLowerCase()] || "";
  }

  /** Заглавные буквы в FEN — белые фигуры. */
  function isWhitePiece(code) {
    return !!code && code === code.toUpperCase();
  }

  function pieceColor(code) {
    if (!code) return null;
    return isWhitePiece(code) ? "white" : "black";
  }

  /** Где стоит король указанного цвета. Нужен, чтобы подсветить шах. */
  function findKing(fen, color) {
    var board = parseFen(fen);
    if (!board) return null;

    var wanted = color === "white" ? "K" : "k";

    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        if (board[r][f] === wanted) return squareName(f, 7 - r);
      }
    }

    return null;
  }

  /**
   * Превращение пешки: нужен ли выбор фигуры.
   * Пешка доходит до последней горизонтали соперника.
   */
  function needsPromotion(fen, from, to) {
    var board = parseFen(fen);
    var start = parseSquare(from);

    if (!board || !start) return false;

    var piece = board[7 - start.rank][start.file];
    if (!piece || piece.toLowerCase() !== "p") return false;

    var finish = parseSquare(to);
    if (!finish) return false;

    if (isWhitePiece(piece)) return finish.rank === 7;
    return finish.rank === 0;
  }

  /** Легальные клетки для фигуры на клетке from. */
  function targetsFrom(legal, from) {
    if (!legal || !from) return [];
    var list = legal[from];
    return Array.isArray(list) ? list : [];
  }

  /** Есть ли вообще у игрока ходы — иначе показывать доску незачем. */
  function hasMoves(legal) {
    if (!legal) return false;

    for (var key in legal) {
      if (Object.prototype.hasOwnProperty.call(legal, key) && legal[key].length) {
        return true;
      }
    }

    return false;
  }

  /** Подпись результата для человека. */
  function resultText(result, you) {
    if (!result) return "";

    if (result === "1/2-1/2") return "Ничья";

    if (!you) return result === "1-0" ? "Победили белые" : "Победили чёрные";

    var won = (you === "white" && result === "1-0") || (you === "black" && result === "0-1");
    return won ? "Вы победили" : "Вы проиграли";
  }

  return {
    FILES: FILES,
    GLYPHS: GLYPHS,
    parseFen: parseFen,
    parseSquare: parseSquare,
    squareName: squareName,
    isLightSquare: isLightSquare,
    boardCells: boardCells,
    pieceGlyph: pieceGlyph,
    pieceName: pieceName,
    isWhitePiece: isWhitePiece,
    pieceColor: pieceColor,
    findKing: findKing,
    needsPromotion: needsPromotion,
    targetsFrom: targetsFrom,
    hasMoves: hasMoves,
    resultText: resultText,
  };
});
