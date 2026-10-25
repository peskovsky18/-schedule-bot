/**
 * Полноценный шахматный движок для игры против бота:
 * - Генерация всех легальных ходов (пешки, кони, слоны, ладьи, ферзи, короли)
 * - Превращение пешек, рокировки, взятия
 * - Проверка шаха, мата, пата
 * - 3 уровня искусственного интеллекта:
 *   1) Новичок (Easy) — простые ходы с зеванием фигур
 *   2) Любитель (Medium) — тактический жадный бот с оценкой угроз и центра
 *   3) Мастер (Hard) — Minimax с Alpha-Beta отсечением на глубину 3 и Piece-Square Tables
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ChessEngine = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var FILES = "abcdefgh";

  // Стартовая расстановка: rank 0 = 1-я горизонталь (белые), rank 7 = 8-я (чёрные)
  var INITIAL_BOARD = [
    "R", "N", "B", "Q", "K", "B", "N", "R", // a1..h1 (0..7)
    "P", "P", "P", "P", "P", "P", "P", "P", // a2..h2 (8..15)
    null, null, null, null, null, null, null, null, // 16..23
    null, null, null, null, null, null, null, null, // 24..31
    null, null, null, null, null, null, null, null, // 32..39
    null, null, null, null, null, null, null, null, // 40..47
    "p", "p", "p", "p", "p", "p", "p", "p", // a7..h7 (48..55)
    "r", "n", "b", "q", "k", "b", "n", "r"  // a8..h8 (56..63)
  ];

  // Базовые ценности фигур
  var PIECE_VALUES = {
    p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000,
    P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000
  };

  // Позиционные таблицы (Piece-Square Tables для белых, для чёрных зеркалятся)
  var PST = {
    P: [
      0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
       5,  5, 10, 25, 25, 10,  5,  5,
       0,  0,  0, 20, 20,  0,  0,  0,
       5, -5,-10,  0,  0,-10, -5,  5,
       5, 10, 10,-20,-20, 10, 10,  5,
       0,  0,  0,  0,  0,  0,  0,  0
    ],
    N: [
      -50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50
    ],
    B: [
      -20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20
    ],
    R: [
        0,  0,  0,  0,  0,  0,  0,  0,
        5, 10, 10, 10, 10, 10, 10,  5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
        0,  0,  0,  5,  5,  0,  0,  0
    ],
    Q: [
      -20,-10,-10, -5, -5,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5,  5,  5,  5,  0,-10,
       -5,  0,  5,  5,  5,  5,  0, -5,
        0,  0,  5,  5,  5,  5,  0, -5,
      -10,  5,  5,  5,  5,  5,  0,-10,
      -10,  0,  5,  0,  0,  0,  0,-10,
      -20,-10,-10, -5, -5,-10,-10,-20
    ],
    K: [
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20,
      -10,-20,-20,-20,-20,-20,-20,-10,
       20, 20,  0,  0,  0,  0, 20, 20,
       20, 30, 10,  0,  0, 10, 30, 20
    ]
  };

  function isWhite(p) { return !!p && p === p.toUpperCase(); }
  function isBlack(p) { return !!p && p === p.toLowerCase(); }
  function colorOf(p) { return !p ? null : (isWhite(p) ? "w" : "b"); }

  function squareName(idx) {
    if (idx < 0 || idx > 63) return "";
    var f = idx % 8;
    var r = Math.floor(idx / 8);
    return FILES[f] + (r + 1);
  }

  function nameToSquare(name) {
    if (!name || name.length !== 2) return -1;
    var f = FILES.indexOf(name[0].toLowerCase());
    var r = parseInt(name[1], 10) - 1;
    if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
    return r * 8 + f;
  }

  function cloneBoard(b) {
    return b.slice(0);
  }

  function createGame() {
    return {
      board: INITIAL_BOARD.slice(0),
      turn: "w",
      castling: { K: true, Q: true, k: true, q: true },
      enPassant: null,
      halfMoves: 0,
      fullMoves: 1,
      lastMove: null,
      history: []
    };
  }

  function boardToFen(state) {
    var fen = "";
    for (var r = 7; r >= 0; r--) {
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = state.board[r * 8 + f];
        if (!p) {
          empty++;
        } else {
          if (empty > 0) {
            fen += empty;
            empty = 0;
          }
          fen += p;
        }
      }
      if (empty > 0) fen += empty;
      if (r > 0) fen += "/";
    }

    fen += " " + state.turn + " ";

    var cast = "";
    if (state.castling.K) cast += "K";
    if (state.castling.Q) cast += "Q";
    if (state.castling.k) cast += "k";
    if (state.castling.q) cast += "q";
    fen += (cast || "-") + " ";

    fen += (state.enPassant !== null ? squareName(state.enPassant) : "-") + " ";
    fen += (state.halfMoves || 0) + " " + (state.fullMoves || 1);
    return fen;
  }

  // Проверка: атакуется ли клетка sq фигурами цвета attackerColor ("w" или "b")
  function isSquareAttacked(board, sq, attackerColor) {
    var r = Math.floor(sq / 8);
    var f = sq % 8;

    // 1. Пешки
    if (attackerColor === "w") {
      // Белая пешка атакует sq снизу-слева и снизу-справа
      if (r > 0) {
        if (f > 0 && board[(r - 1) * 8 + (f - 1)] === "P") return true;
        if (f < 7 && board[(r - 1) * 8 + (f + 1)] === "P") return true;
      }
    } else {
      // Чёрная пешка атакует sq сверху-слева и сверху-справа
      if (r < 7) {
        if (f > 0 && board[(r + 1) * 8 + (f - 1)] === "p") return true;
        if (f < 7 && board[(r + 1) * 8 + (f + 1)] === "p") return true;
      }
    }

    // 2. Кони
    var knightD = [[1,2],[1,-2],[-1,2],[-1,-2],[2,1],[2,-1],[-2,1],[-2,-1]];
    var targetKnight = attackerColor === "w" ? "N" : "n";
    for (var i = 0; i < knightD.length; i++) {
      var nr = r + knightD[i][0];
      var nf = f + knightD[i][1];
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        if (board[nr * 8 + nf] === targetKnight) return true;
      }
    }

    // 3. Ладьи и Ферзи (ортогонально)
    var rookDirs = [[1,0],[-1,0],[0,1],[0,-1]];
    var targetRook = attackerColor === "w" ? "R" : "r";
    var targetQueen = attackerColor === "w" ? "Q" : "q";
    for (var rd = 0; rd < rookDirs.length; rd++) {
      var cr = r + rookDirs[rd][0];
      var cf = f + rookDirs[rd][1];
      while (cr >= 0 && cr < 8 && cf >= 0 && cf < 8) {
        var piece = board[cr * 8 + cf];
        if (piece) {
          if (piece === targetRook || piece === targetQueen) return true;
          break;
        }
        cr += rookDirs[rd][0];
        cf += rookDirs[rd][1];
      }
    }

    // 4. Слоны и Ферзи (диагонально)
    var bishopDirs = [[1,1],[1,-1],[-1,1],[-1,-1]];
    var targetBishop = attackerColor === "w" ? "B" : "b";
    for (var bd = 0; bd < bishopDirs.length; bd++) {
      var br = r + bishopDirs[bd][0];
      var bf = f + bishopDirs[bd][1];
      while (br >= 0 && br < 8 && bf >= 0 && bf < 8) {
        var bPiece = board[br * 8 + bf];
        if (bPiece) {
          if (bPiece === targetBishop || bPiece === targetQueen) return true;
          break;
        }
        br += bishopDirs[bd][0];
        bf += bishopDirs[bd][1];
      }
    }

    // 5. Король
    var targetKing = attackerColor === "w" ? "K" : "k";
    for (var kr = -1; kr <= 1; kr++) {
      for (var kf = -1; kf <= 1; kf++) {
        if (kr === 0 && kf === 0) continue;
        var tr = r + kr;
        var tf = f + kf;
        if (tr >= 0 && tr < 8 && tf >= 0 && tf < 8) {
          if (board[tr * 8 + tf] === targetKing) return true;
        }
      }
    }

    return false;
  }

  function findKing(board, color) {
    var target = color === "w" ? "K" : "k";
    for (var i = 0; i < 64; i++) {
      if (board[i] === target) return i;
    }
    return -1;
  }

  function isInCheck(board, color) {
    var kSq = findKing(board, color);
    if (kSq === -1) return false;
    var opponent = color === "w" ? "b" : "w";
    return isSquareAttacked(board, kSq, opponent);
  }

  // Генерация псевдолегальных ходов
  function generatePseudoMoves(state) {
    var moves = [];
    var board = state.board;
    var turn = state.turn;
    var isW = turn === "w";

    for (var sq = 0; sq < 64; sq++) {
      var p = board[sq];
      if (!p || colorOf(p) !== turn) continue;

      var r = Math.floor(sq / 8);
      var f = sq % 8;
      var type = p.toUpperCase();

      if (type === "P") {
        var forward = isW ? 1 : -1;
        var startRank = isW ? 1 : 6;
        var promoRank = isW ? 7 : 0;

        // 1 шаг вперед
        var nextSq = (r + forward) * 8 + f;
        if (!board[nextSq]) {
          if (r + forward === promoRank) {
            var promoPieces = isW ? ["Q", "R", "B", "N"] : ["q", "r", "b", "n"];
            for (var pi = 0; pi < promoPieces.length; pi++) {
              moves.push({ from: sq, to: nextSq, promo: promoPieces[pi] });
            }
          } else {
            moves.push({ from: sq, to: nextSq, promo: null });
            // 2 шага со старта
            if (r === startRank) {
              var doubleSq = (r + forward * 2) * 8 + f;
              if (!board[doubleSq]) {
                moves.push({ from: sq, to: doubleSq, promo: null, isDoublePawn: true });
              }
            }
          }
        }

        // Взятия
        var capFiles = [f - 1, f + 1];
        for (var c = 0; c < capFiles.length; c++) {
          var cf = capFiles[c];
          if (cf >= 0 && cf < 8) {
            var capSq = (r + forward) * 8 + cf;
            var targetP = board[capSq];
            if (targetP && colorOf(targetP) !== turn) {
              if (r + forward === promoRank) {
                var promoPiecesCap = isW ? ["Q", "R", "B", "N"] : ["q", "r", "b", "n"];
                for (var pj = 0; pj < promoPiecesCap.length; pj++) {
                  moves.push({ from: sq, to: capSq, promo: promoPiecesCap[pj], capture: true });
                }
              } else {
                moves.push({ from: sq, to: capSq, promo: null, capture: true });
              }
            } else if (state.enPassant === capSq) {
              // Взятие на проходе
              moves.push({ from: sq, to: capSq, promo: null, capture: true, isEnPassant: true });
            }
          }
        }
      } else if (type === "N") {
        var knightD = [[1,2],[1,-2],[-1,2],[-1,-2],[2,1],[2,-1],[-2,1],[-2,-1]];
        for (var n = 0; n < knightD.length; n++) {
          var nr = r + knightD[n][0];
          var nf = f + knightD[n][1];
          if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
            var nSq = nr * 8 + nf;
            var nP = board[nSq];
            if (!nP || colorOf(nP) !== turn) {
              moves.push({ from: sq, to: nSq, promo: null, capture: !!nP });
            }
          }
        }
      } else if (type === "B" || type === "R" || type === "Q") {
        var dirs = [];
        if (type === "B" || type === "Q") dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
        if (type === "R" || type === "Q") dirs.push([1,0],[-1,0],[0,1],[0,-1]);

        for (var d = 0; d < dirs.length; d++) {
          var dr = dirs[d][0];
          var df = dirs[d][1];
          var step = 1;
          while (true) {
            var tr = r + dr * step;
            var tf = f + df * step;
            if (tr < 0 || tr >= 8 || tf < 0 || tf >= 8) break;
            var tSq = tr * 8 + tf;
            var tP = board[tSq];
            if (!tP) {
              moves.push({ from: sq, to: tSq, promo: null, capture: false });
            } else {
              if (colorOf(tP) !== turn) {
                moves.push({ from: sq, to: tSq, promo: null, capture: true });
              }
              break;
            }
            step++;
          }
        }
      } else if (type === "K") {
        for (var kr = -1; kr <= 1; kr++) {
          for (var kf = -1; kf <= 1; kf++) {
            if (kr === 0 && kf === 0) continue;
            var ktr = r + kr;
            var ktf = f + kf;
            if (ktr >= 0 && ktr < 8 && ktf >= 0 && ktf < 8) {
              var kSq = ktr * 8 + ktf;
              var kP = board[kSq];
              if (!kP || colorOf(kP) !== turn) {
                moves.push({ from: sq, to: kSq, promo: null, capture: !!kP });
              }
            }
          }
        }

        // Рокировки
        var opp = isW ? "b" : "w";
        if (isW && r === 0 && f === 4 && !isSquareAttacked(board, 4, opp)) {
          // Королевская рокировка O-O (e1 -> g1)
          if (state.castling.K && !board[5] && !board[6] && board[7] === "R") {
            if (!isSquareAttacked(board, 5, opp) && !isSquareAttacked(board, 6, opp)) {
              moves.push({ from: 4, to: 6, promo: null, isCastleK: true });
            }
          }
          // Ферзевая рокировка O-O-O (e1 -> c1)
          if (state.castling.Q && !board[3] && !board[2] && !board[1] && board[0] === "R") {
            if (!isSquareAttacked(board, 3, opp) && !isSquareAttacked(board, 2, opp)) {
              moves.push({ from: 4, to: 2, promo: null, isCastleQ: true });
            }
          }
        } else if (!isW && r === 7 && f === 4 && !isSquareAttacked(board, 60, opp)) {
          // Чёрная O-O (e8 -> g8)
          if (state.castling.k && !board[61] && !board[62] && board[63] === "r") {
            if (!isSquareAttacked(board, 61, opp) && !isSquareAttacked(board, 62, opp)) {
              moves.push({ from: 60, to: 62, promo: null, isCastleK: true });
            }
          }
          // Чёрная O-O-O (e8 -> c8)
          if (state.castling.q && !board[59] && !board[58] && !board[57] && board[56] === "r") {
            if (!isSquareAttacked(board, 59, opp) && !isSquareAttacked(board, 58, opp)) {
              moves.push({ from: 60, to: 58, promo: null, isCastleQ: true });
            }
          }
        }
      }
    }

    return moves;
  }

  // Применение хода на доске
  function applyMoveToState(state, m) {
    var next = {
      board: cloneBoard(state.board),
      turn: state.turn === "w" ? "b" : "w",
      castling: Object.assign({}, state.castling),
      enPassant: null,
      halfMoves: state.halfMoves + 1,
      fullMoves: state.fullMoves + (state.turn === "b" ? 1 : 0),
      lastMove: { from: squareName(m.from), to: squareName(m.to) },
      history: state.history.concat([m])
    };

    var p = next.board[m.from];
    next.board[m.from] = null;

    if (m.promo) {
      next.board[m.to] = m.promo;
    } else {
      next.board[m.to] = p;
    }

    // Сброс halfMoves при ходе пешкой или взятии
    if (p.toUpperCase() === "P" || m.capture) next.halfMoves = 0;

    // Взятие на проходе
    if (m.isEnPassant) {
      var capSq = state.turn === "w" ? m.to - 8 : m.to + 8;
      next.board[capSq] = null;
    }

    // Двойной шаг пешки -> установка enPassant
    if (m.isDoublePawn) {
      next.enPassant = state.turn === "w" ? m.from + 8 : m.from - 8;
    }

    // Рокировка: перестановка ладьи
    if (m.isCastleK) {
      if (state.turn === "w") {
        next.board[7] = null;
        next.board[5] = "R";
      } else {
        next.board[63] = null;
        next.board[61] = "r";
      }
    } else if (m.isCastleQ) {
      if (state.turn === "w") {
        next.board[0] = null;
        next.board[3] = "R";
      } else {
        next.board[56] = null;
        next.board[59] = "r";
      }
    }

    // Обновление прав на рокировку
    if (p === "K") { next.castling.K = false; next.castling.Q = false; }
    if (p === "k") { next.castling.k = false; next.castling.q = false; }
    if (m.from === 0 || m.to === 0) next.castling.Q = false;
    if (m.from === 7 || m.to === 7) next.castling.K = false;
    if (m.from === 56 || m.to === 56) next.castling.q = false;
    if (m.from === 63 || m.to === 63) next.castling.k = false;

    return next;
  }

  // Получение строго легальных ходов (без шаха своему королю)
  function getLegalMoves(state) {
    var pseudo = generatePseudoMoves(state);
    var legal = [];
    var turn = state.turn;

    for (var i = 0; i < pseudo.length; i++) {
      var m = pseudo[i];
      var next = applyMoveToState(state, m);
      // Если после хода наш король всё ещё под шахом — ход нелегален
      if (!isInCheck(next.board, turn)) {
        legal.push(m);
      }
    }

    return legal;
  }

  // Словарь для подсветки на доске { "e2": ["e3", "e4"] }
  function getLegalDictionary(state) {
    var moves = getLegalMoves(state);
    var dict = {};
    for (var i = 0; i < moves.length; i++) {
      var from = squareName(moves[i].from);
      var to = squareName(moves[i].to);
      if (!dict[from]) dict[from] = [];
      if (dict[from].indexOf(to) === -1) dict[from].push(to);
    }
    return dict;
  }

  // Оценка статической позиции для бота
  function evaluateBoard(board) {
    var score = 0;
    for (var sq = 0; sq < 64; sq++) {
      var p = board[sq];
      if (!p) continue;

      var val = PIECE_VALUES[p] || 0;
      var type = p.toUpperCase();
      var isW = isWhite(p);

      // Индекс для PST: для белых зеркалится сверху вниз (rank 7 - r)
      var r = Math.floor(sq / 8);
      var f = sq % 8;
      var pstIdx = isW ? (7 - r) * 8 + f : r * 8 + f;
      var posBonus = PST[type] ? PST[type][pstIdx] : 0;

      if (isW) {
        score += val + posBonus;
      } else {
        score -= (val + posBonus);
      }
    }
    return score;
  }

  // Minimax с Alpha-Beta отсечением
  function minimax(state, depth, alpha, beta, isMaximizing) {
    var legal = getLegalMoves(state);
    var inCheck = isInCheck(state.board, state.turn);

    if (legal.length === 0) {
      if (inCheck) {
        // Мат: максимальный штраф/бонус с учетом глубины
        return isMaximizing ? -100000 - depth : 100000 + depth;
      }
      return 0; // Пат
    }

    if (depth === 0) {
      return evaluateBoard(state.board);
    }

    // Сортировка ходов: взятия вперед для лучшего alpha-beta отсечения
    legal.sort(function (a, b) {
      var aVal = a.capture ? (PIECE_VALUES[state.board[a.to]] || 100) : 0;
      var bVal = b.capture ? (PIECE_VALUES[state.board[b.to]] || 100) : 0;
      return bVal - aVal;
    });

    if (isMaximizing) {
      var maxEval = -Infinity;
      for (var i = 0; i < legal.length; i++) {
        var next = applyMoveToState(state, legal[i]);
        var ev = minimax(next, depth - 1, alpha, beta, false);
        maxEval = Math.max(maxEval, ev);
        alpha = Math.max(alpha, ev);
        if (beta <= alpha) break;
      }
      return maxEval;
    } else {
      var minEval = Infinity;
      for (var j = 0; j < legal.length; j++) {
        var nextB = applyMoveToState(state, legal[j]);
        var evB = minimax(nextB, depth - 1, alpha, beta, true);
        minEval = Math.min(minEval, evB);
        beta = Math.min(beta, evB);
        if (beta <= alpha) break;
      }
      return minEval;
    }
  }

  /**
   * Выбор хода ботом в зависимости от уровня сложности:
   * - "easy" (Новичок): случайные ходы + простые взятия
   * - "medium" (Любитель): тактический жадный бот (глубина 1 + центр + защита)
   * - "hard" (Мастер): Minimax alpha-beta на глубину 3 с PST
   */
  function getBotMove(state, difficulty) {
    var moves = getLegalMoves(state);
    if (moves.length === 0) return null;

    var diff = difficulty || "medium";

    // 1. УРОВЕНЬ: НОВИЧОК (EASY)
    if (diff === "easy") {
      // 50% случайный ход, 50% взятие (если есть)
      var captures = moves.filter(function (m) { return m.capture; });
      if (captures.length > 0 && Math.random() < 0.6) {
        return captures[Math.floor(Math.random() * captures.length)];
      }
      return moves[Math.floor(Math.random() * moves.length)];
    }

    // 2. УРОВЕНЬ: ЛЮБИТЕЛЬ (MEDIUM)
    if (diff === "medium") {
      var evaluatedMoves = [];
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        var nextState = applyMoveToState(state, m);
        // Оценка хода на 1 шаг
        var score = evaluateBoard(nextState.board);
        // Небольшой бонус за взятие
        if (m.capture) {
          score -= 30; // чёрные минимизируют оценку
        }
        // Небольшой шум для разнообразия партий
        score += (Math.random() * 20 - 10);
        evaluatedMoves.push({ move: m, score: score });
      }
      // Чёрные выбирают наименьший score (минимизируют)
      evaluatedMoves.sort(function (a, b) { return a.score - b.score; });
      // Выбираем среди лучших двух ходов
      var topCount = Math.min(2, evaluatedMoves.length);
      return evaluatedMoves[Math.floor(Math.random() * topCount)].move;
    }

    // 3. УРОВЕНЬ: МАСТЕР (HARD)
    var bestMove = moves[0];
    var bestScore = Infinity; // Чёрные минимизируют
    var alpha = -Infinity;
    var beta = Infinity;

    // Сортировка для ускорения
    moves.sort(function (a, b) {
      var aVal = a.capture ? (PIECE_VALUES[state.board[a.to]] || 100) : 0;
      var bVal = b.capture ? (PIECE_VALUES[state.board[b.to]] || 100) : 0;
      return bVal - aVal;
    });

    for (var k = 0; k < moves.length; k++) {
      var candidate = moves[k];
      var nextS = applyMoveToState(state, candidate);
      // Глубина 3 полухода: bot(0) -> player(1) -> bot(2) -> player(3)
      var evalScore = minimax(nextS, 2, alpha, beta, true);

      if (evalScore < bestScore) {
        bestScore = evalScore;
        bestMove = candidate;
      }
      beta = Math.min(beta, evalScore);
      if (beta <= alpha) break;
    }

    return bestMove;
  }

  return {
    createGame: createGame,
    boardToFen: boardToFen,
    squareName: squareName,
    nameToSquare: nameToSquare,
    getLegalMoves: getLegalMoves,
    getLegalDictionary: getLegalDictionary,
    applyMoveToState: applyMoveToState,
    isInCheck: isInCheck,
    getBotMove: getBotMove
  };
});
