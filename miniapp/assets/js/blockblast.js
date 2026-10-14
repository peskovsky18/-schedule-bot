/**
 * Block Blast для Telegram Mini App.
 *
 * Классическая головоломка 8x8 с сочными взрывами, комбо-сериями,
 * адаптивным тач-управлением (drag-and-drop с вертикальным смещением пальца),
 * Web Audio синтезом звуков и начислением тугриков.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BlockBlast = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var GRID_SIZE = 8;
  var BEST_SCORE_KEY = "bb_best_score_v1";

  // Цветовая палитра блоков (Apple HIG / Neon Glass)
  var COLORS = {
    cyan:     { bg: "#06b6d4", border: "#22d3ee", glow: "rgba(6, 182, 212, 0.45)" },
    sapphire: { bg: "#3b82f6", border: "#60a5fa", glow: "rgba(59, 130, 246, 0.45)" },
    amethyst: { bg: "#8b5cf6", border: "#a78bfa", glow: "rgba(139, 92, 246, 0.45)" },
    ruby:     { bg: "#f43f5e", border: "#fb7185", glow: "rgba(244, 63, 94, 0.45)" },
    amber:    { bg: "#f59e0b", border: "#fbbf24", glow: "rgba(245, 158, 11, 0.45)" },
    emerald:  { bg: "#10b981", border: "#34d399", glow: "rgba(16, 185, 129, 0.45)" },
    purple:   { bg: "#d946ef", border: "#e879f9", glow: "rgba(217, 70, 239, 0.45)" },
    lime:     { bg: "#84cc16", border: "#a3e635", glow: "rgba(132, 204, 22, 0.45)" }
  };

  // Библиотека фигур
  var SHAPES = [
    // 1x1
    { id: "dot", matrix: [[1]], color: "cyan" },

    // 1x2, 2x1
    { id: "line2_h", matrix: [[1, 1]], color: "cyan" },
    { id: "line2_v", matrix: [[1], [1]], color: "cyan" },

    // 1x3, 3x1
    { id: "line3_h", matrix: [[1, 1, 1]], color: "sapphire" },
    { id: "line3_v", matrix: [[1], [1], [1]], color: "sapphire" },

    // 1x4, 4x1
    { id: "line4_h", matrix: [[1, 1, 1, 1]], color: "amber" },
    { id: "line4_v", matrix: [[1], [1], [1], [1]], color: "amber" },

    // 1x5, 5x1
    { id: "line5_h", matrix: [[1, 1, 1, 1, 1]], color: "amethyst" },
    { id: "line5_v", matrix: [[1], [1], [1], [1], [1]], color: "amethyst" },

    // Квадраты
    { id: "sq2", matrix: [[1, 1], [1, 1]], color: "ruby" },
    { id: "sq3", matrix: [[1, 1, 1], [1, 1, 1], [1, 1, 1]], color: "amber" },

    // Уголки 2x2
    { id: "c2_1", matrix: [[1, 0], [1, 1]], color: "emerald" },
    { id: "c2_2", matrix: [[0, 1], [1, 1]], color: "emerald" },
    { id: "c2_3", matrix: [[1, 1], [1, 0]], color: "emerald" },
    { id: "c2_4", matrix: [[1, 1], [0, 1]], color: "emerald" },

    // Уголки 3x3
    { id: "c3_1", matrix: [[1, 0, 0], [1, 0, 0], [1, 1, 1]], color: "purple" },
    { id: "c3_2", matrix: [[0, 0, 1], [0, 0, 1], [1, 1, 1]], color: "purple" },
    { id: "c3_3", matrix: [[1, 1, 1], [1, 0, 0], [1, 0, 0]], color: "purple" },
    { id: "c3_4", matrix: [[1, 1, 1], [0, 0, 1], [0, 0, 1]], color: "purple" },

    // T-образные
    { id: "t_1", matrix: [[1, 1, 1], [0, 1, 0]], color: "lime" },
    { id: "t_2", matrix: [[0, 1, 0], [1, 1, 1]], color: "lime" },
    { id: "t_3", matrix: [[1, 0], [1, 1], [1, 0]], color: "lime" },
    { id: "t_4", matrix: [[0, 1], [1, 1], [0, 1]], color: "lime" },

    // L-образные 3x2
    { id: "l_1", matrix: [[1, 0], [1, 0], [1, 1]], color: "cyan" },
    { id: "l_2", matrix: [[0, 1], [0, 1], [1, 1]], color: "cyan" },
    { id: "l_3", matrix: [[1, 1, 1], [1, 0, 0]], color: "sapphire" },
    { id: "l_4", matrix: [[1, 1, 1], [0, 0, 1]], color: "sapphire" },

    // Z и S
    { id: "z_1", matrix: [[1, 1, 0], [0, 1, 1]], color: "ruby" },
    { id: "s_1", matrix: [[0, 1, 1], [1, 1, 0]], color: "ruby" }
  ];

  /* ---------- Звуковой синтезатор (Web Audio) ---------- */
  var audioCtx = null;
  function getAudioContext() {
    if (audioCtx) return audioCtx;
    var AudioClass = window.AudioContext || window.webkitAudioContext;
    if (AudioClass) {
      try {
        audioCtx = new AudioClass();
      } catch (e) {}
    }
    return audioCtx;
  }

  function playSound(type, comboLevel) {
    var ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }

    try {
      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === "place") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.08);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);

      } else if (type === "blast") {
        var baseFreq = 440 + Math.min(8, comboLevel || 1) * 60;
        osc.type = "triangle";
        osc.frequency.setValueAtTime(baseFreq, now);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, now + 0.15);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);

      } else if (type === "combo") {
        // Двухтональный звонкий комбо-аккорд
        var osc2 = ctx.createOscillator();
        var gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);

        var f1 = 523.25 + Math.min(7, comboLevel || 1) * 80; // C5+
        var f2 = f1 * 1.25; // мажорная терция

        osc.type = "sine";
        osc.frequency.setValueAtTime(f1, now);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.35);

        osc2.type = "triangle";
        osc2.frequency.setValueAtTime(f2, now + 0.06);
        gain2.gain.setValueAtTime(0.25, now + 0.06);
        gain2.gain.linearRampToValueAtTime(0.01, now + 0.4);

        osc.start(now);
        osc.stop(now + 0.35);
        osc2.start(now + 0.06);
        osc2.stop(now + 0.4);

      } else if (type === "gameover") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(350, now);
        osc.frequency.linearRampToValueAtTime(140, now + 0.4);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
      }
    } catch (e) {}
  }

  /* ---------- Вибрации (Haptics) ---------- */
  function bbHaptic(type) {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback) {
      try {
        var h = window.Telegram.WebApp.HapticFeedback;
        if (type === "light" || type === "medium" || type === "heavy") {
          h.impactOccurred(type);
        } else if (type === "success" || type === "warning" || type === "error") {
          h.notificationOccurred(type);
        } else if (type === "selection") {
          h.selectionChanged();
        }
      } catch (e) {}
    }
  }

  /* ---------- Экспорт объекта игры ---------- */
  return {
    GRID_SIZE: GRID_SIZE,
    COLORS: COLORS,
    SHAPES: SHAPES,

    createState: function () {
      var grid = [];
      for (var r = 0; r < GRID_SIZE; r++) {
        var row = [];
        for (var c = 0; c < GRID_SIZE; c++) {
          row.push(null);
        }
        grid.push(row);
      }

      var best = 0;
      try {
        best = parseInt(localStorage.getItem(BEST_SCORE_KEY), 10) || 0;
      } catch (e) {}

      return {
        grid: grid,
        score: 0,
        bestScore: best,
        combo: 0,
        rack: [],
        linesClearedTotal: 0,
        gameOver: false
      };
    },

    saveBestScore: function (score) {
      try {
        var prev = parseInt(localStorage.getItem(BEST_SCORE_KEY), 10) || 0;
        if (score > prev) {
          localStorage.setItem(BEST_SCORE_KEY, String(score));
          return true;
        }
      } catch (e) {}
      return false;
    },

    getBestScore: function () {
      try {
        return parseInt(localStorage.getItem(BEST_SCORE_KEY), 10) || 0;
      } catch (e) {
        return 0;
      }
    },

    canPlace: function (grid, matrix, targetR, targetC) {
      var rows = matrix.length;
      var cols = matrix[0].length;

      if (targetR < 0 || targetC < 0 || targetR + rows > GRID_SIZE || targetC + cols > GRID_SIZE) {
        return false;
      }

      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          if (matrix[r][c]) {
            if (grid[targetR + r][targetC + c] !== null) {
              return false;
            }
          }
        }
      }
      return true;
    },

    canPlacePieceAnywhere: function (grid, matrix) {
      for (var r = 0; r < GRID_SIZE; r++) {
        for (var c = 0; c < GRID_SIZE; c++) {
          if (this.canPlace(grid, matrix, r, c)) {
            return true;
          }
        }
      }
      return false;
    },

    checkGameOver: function (grid, rack) {
      for (var i = 0; i < rack.length; i++) {
        var p = rack[i];
        if (p && !p.used) {
          if (this.canPlacePieceAnywhere(grid, p.matrix)) {
            return false;
          }
        }
      }
      return true;
    },

    generateRackPieces: function (grid) {
      var pieces = [];
      var allShapes = SHAPES.slice();

      // Гарантируем, что хотя бы 1 фигура сможет встать на поле
      var validShapes = [];
      for (var s = 0; s < allShapes.length; s++) {
        if (this.canPlacePieceAnywhere(grid, allShapes[s].matrix)) {
          validShapes.push(allShapes[s]);
        }
      }

      for (var i = 0; i < 3; i++) {
        var chosen = null;
        if (i === 0 && validShapes.length > 0) {
          chosen = validShapes[Math.floor(Math.random() * validShapes.length)];
        } else {
          chosen = allShapes[Math.floor(Math.random() * allShapes.length)];
        }

        pieces.push({
          id: chosen.id + "_" + Date.now() + "_" + i,
          shapeId: chosen.id,
          matrix: chosen.matrix,
          color: chosen.color,
          used: false
        });
      }
      return pieces;
    },

    findCompleteLines: function (grid) {
      var fullRows = [];
      var fullCols = [];

      // Полные строки
      for (var r = 0; r < GRID_SIZE; r++) {
        var rowFull = true;
        for (var c = 0; c < GRID_SIZE; c++) {
          if (grid[r][c] === null) {
            rowFull = false;
            break;
          }
        }
        if (rowFull) fullRows.push(r);
      }

      // Полные столбцы
      for (var c2 = 0; c2 < GRID_SIZE; c2++) {
        var colFull = true;
        for (var r2 = 0; r2 < GRID_SIZE; r2++) {
          if (grid[r2][c2] === null) {
            colFull = false;
            break;
          }
        }
        if (colFull) fullCols.push(c2);
      }

      return {
        rows: fullRows,
        cols: fullCols,
        total: fullRows.length + fullCols.length
      };
    },

    playSound: playSound,
    haptic: bbHaptic,

    initGame: function (els, opts) {
      opts = opts || {};
      var self = this;
      var state = self.createState();
      var cellNodes = [];
      var selectedPieceIdx = null;
      var isDragging = false;
      var activeAvatar = null;
      var currentGhost = null; // { targetR, targetC, shape }
      var currentDragPiece = null;
      var currentDragSlotIdx = null;
      var maxComboThisGame = 0;

      // Инициализация игрового поля 8x8 в DOM
      function createBoardDOM() {
        if (!els.board) return;
        els.board.innerHTML = "";
        cellNodes = [];

        for (var r = 0; r < GRID_SIZE; r++) {
          var rowNodes = [];
          for (var c = 0; c < GRID_SIZE; c++) {
            var cell = document.createElement("div");
            cell.className = "bb-cell";
            cell.dataset.r = String(r);
            cell.dataset.c = String(c);
            (function (row, col) {
              cell.addEventListener("click", function () {
                onBoardCellClick(row, col);
              });
            })(r, c);
            els.board.appendChild(cell);
            rowNodes.push(cell);
          }
          cellNodes.push(rowNodes);
        }
      }

      function updateBoardDOM() {
        for (var r = 0; r < GRID_SIZE; r++) {
          for (var c = 0; c < GRID_SIZE; c++) {
            var colorKey = state.grid[r][c];
            var node = cellNodes[r][c];
            if (!node) continue;

            if (colorKey) {
              var colorInfo = COLORS[colorKey] || COLORS.cyan;
              node.className = "bb-cell is-filled bb-color-" + colorKey;
              node.style.backgroundColor = colorInfo.bg;
              node.style.borderColor = colorInfo.border;
              node.style.boxShadow = "inset 0 1px 2px rgba(255,255,255,0.35), 0 2px 6px " + colorInfo.glow;
            } else {
              node.className = "bb-cell";
              node.style.backgroundColor = "";
              node.style.borderColor = "";
              node.style.boxShadow = "";
            }
          }
        }
      }

      function clearGhostDOM() {
        if (!currentGhost) return;
        for (var r = 0; r < GRID_SIZE; r++) {
          for (var c = 0; c < GRID_SIZE; c++) {
            var node = cellNodes[r][c];
            if (node && node.classList.contains("is-ghost")) {
              node.classList.remove("is-ghost");
              node.style.opacity = "";
              if (!state.grid[r][c]) {
                node.style.backgroundColor = "";
                node.style.borderColor = "";
                node.style.boxShadow = "";
              }
            }
          }
        }
        currentGhost = null;
      }

      function renderGhostDOM(targetR, targetC, piece) {
        clearGhostDOM();
        if (!piece || targetR === null || targetC === null) return;
        var mat = piece.matrix;
        var colorInfo = COLORS[piece.color] || COLORS.cyan;

        for (var r = 0; r < mat.length; r++) {
          for (var c = 0; c < mat[0].length; c++) {
            if (mat[r][c]) {
              var br = targetR + r;
              var bc = targetC + c;
              if (br >= 0 && br < GRID_SIZE && bc >= 0 && bc < GRID_SIZE) {
                var node = cellNodes[br][bc];
                if (node) {
                  node.classList.add("is-ghost");
                  node.style.backgroundColor = colorInfo.bg;
                  node.style.borderColor = colorInfo.border;
                  node.style.opacity = "0.45";
                }
              }
            }
          }
        }
        currentGhost = { targetR: targetR, targetC: targetC, piece: piece };
      }

      function renderRackDOM() {
        if (!els.rack) return;
        els.rack.innerHTML = "";

        state.rack.forEach(function (piece, idx) {
          var slot = document.createElement("div");
          slot.className = "bb-slot" + (idx === selectedPieceIdx ? " is-selected" : "");
          slot.dataset.slotIdx = String(idx);

          if (!piece || piece.used) {
            slot.classList.add("is-empty");
            els.rack.appendChild(slot);
            return;
          }

          var pieceWrap = document.createElement("div");
          pieceWrap.className = "bb-piece";
          pieceWrap.dataset.pieceId = piece.id;

          var mat = piece.matrix;
          var rows = mat.length;
          var cols = mat[0].length;
          pieceWrap.style.gridTemplateRows = "repeat(" + rows + ", 1fr)";
          pieceWrap.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";

          var colorInfo = COLORS[piece.color] || COLORS.cyan;

          for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
              var miniBlock = document.createElement("div");
              if (mat[r][c]) {
                miniBlock.className = "bb-mini-block bb-color-" + piece.color;
                miniBlock.style.backgroundColor = colorInfo.bg;
                miniBlock.style.borderColor = colorInfo.border;
                miniBlock.style.boxShadow = "inset 0 1px 1px rgba(255,255,255,0.4), 0 1px 3px " + colorInfo.glow;
              } else {
                miniBlock.className = "bb-mini-block is-transparent";
              }
              pieceWrap.appendChild(miniBlock);
            }
          }

          // Навешиваем Drag & Drop и Tap
          attachDragEvents(pieceWrap, piece, idx);

          slot.appendChild(pieceWrap);
          els.rack.appendChild(slot);
        });
      }

      function updateScoreDOM() {
        if (els.scoreVal) els.scoreVal.textContent = state.score.toLocaleString();
        if (els.bestVal) els.bestVal.textContent = state.bestScore.toLocaleString();
        if (opts.onScoreUpdate) opts.onScoreUpdate(state.bestScore);
      }

      function showComboBadge(comboCount, pointsEarned) {
        if (!els.comboPill || !els.comboText) return;
        var titles = [
          "COMBO x" + comboCount + "! 🔥",
          "GREAT x" + comboCount + "! ⚡",
          "AMAZING x" + comboCount + "! 💥",
          "UNBELIEVABLE! 👑"
        ];
        var text = titles[Math.min(titles.length - 1, Math.max(0, comboCount - 2))];
        els.comboText.textContent = text + " (+" + pointsEarned + ")";
        els.comboPill.hidden = false;
        els.comboPill.classList.remove("is-popping");
        void els.comboPill.offsetWidth; // перезапуск анимации
        els.comboPill.classList.add("is-popping");

        clearTimeout(els.comboPill._hideTimer);
        els.comboPill._hideTimer = setTimeout(function () {
          els.comboPill.hidden = true;
        }, 1600);
      }

      function spawnFloatingScore(text, clientX, clientY) {
        if (!els.particles) return;
        var pop = document.createElement("div");
        pop.className = "bb-floating-score";
        pop.textContent = text;
        if (clientX && clientY) {
          var rect = els.board.getBoundingClientRect();
          pop.style.left = (clientX - rect.left) + "px";
          pop.style.top = (clientY - rect.top) + "px";
        } else {
          pop.style.left = "50%";
          pop.style.top = "40%";
        }
        els.particles.appendChild(pop);
        setTimeout(function () {
          if (pop.parentNode) pop.parentNode.removeChild(pop);
        }, 900);
      }

      function triggerBlastEffects(cleared) {
        var affectedCells = {};
        cleared.rows.forEach(function (r) {
          for (var c = 0; c < GRID_SIZE; c++) {
            affectedCells[r + "_" + c] = { r: r, c: c };
          }
        });
        cleared.cols.forEach(function (c) {
          for (var r = 0; r < GRID_SIZE; r++) {
            affectedCells[r + "_" + c] = { r: r, c: c };
          }
        });

        // Запуск анимации взрыва на клетках
        Object.keys(affectedCells).forEach(function (k) {
          var pt = affectedCells[k];
          var node = cellNodes[pt.r][pt.c];
          if (node) {
            node.classList.add("is-blasting");
          }
        });

        // Удаление блоков из сетки
        setTimeout(function () {
          cleared.rows.forEach(function (r) {
            for (var c = 0; c < GRID_SIZE; c++) {
              state.grid[r][c] = null;
            }
          });
          cleared.cols.forEach(function (c) {
            for (var r = 0; r < GRID_SIZE; r++) {
              state.grid[r][c] = null;
            }
          });
          updateBoardDOM();
        }, 220);
      }

      function placePieceAction(targetR, targetC, piece, slotIdx) {
        if (!self.canPlace(state.grid, piece.matrix, targetR, targetC)) {
          return false;
        }

        // Заполняем сетку
        var blocksPlaced = 0;
        for (var r = 0; r < piece.matrix.length; r++) {
          for (var c = 0; c < piece.matrix[0].length; c++) {
            if (piece.matrix[r][c]) {
              state.grid[targetR + r][targetC + c] = piece.color;
              blocksPlaced++;
            }
          }
        }

        piece.used = true;
        selectedPieceIdx = null;
        state.score += blocksPlaced;
        self.playSound("place");
        self.haptic("light");
        updateBoardDOM();

        // Проверка заполненных строк и колонок
        var cleared = self.findCompleteLines(state.grid);
        if (cleared.total > 0) {
          state.combo++;
          if (state.combo > maxComboThisGame) maxComboThisGame = state.combo;

          var basePts = cleared.total === 1 ? 10 :
                        cleared.total === 2 ? 30 :
                        cleared.total === 3 ? 60 : 100 + (cleared.total - 4) * 40;
          var earned = basePts * state.combo;
          state.score += earned;
          state.linesClearedTotal += cleared.total;

          triggerBlastEffects(cleared);
          self.playSound(state.combo > 1 ? "combo" : "blast", state.combo);
          self.haptic(state.combo >= 2 ? "heavy" : "success");

          if (state.combo >= 2) {
            showComboBadge(state.combo, earned);
          }
          spawnFloatingScore("+" + earned);

        } else {
          state.combo = 0;
        }

        if (state.score > state.bestScore) {
          state.bestScore = state.score;
          self.saveBestScore(state.score);
        }
        updateScoreDOM();

        // Если все 3 фигуры использованы — генерируем новые
        var allUsed = state.rack.every(function (p) { return !p || p.used; });
        if (allUsed) {
          state.rack = self.generateRackPieces(state.grid);
          renderRackDOM();
        } else {
          renderRackDOM();
        }

        // Проверка Game Over
        if (self.checkGameOver(state.grid, state.rack)) {
          setTimeout(handleGameOver, 400);
        }

        return true;
      }

      function handleGameOver() {
        state.gameOver = true;
        self.playSound("gameover");
        self.haptic("error");

        var isRecord = self.saveBestScore(state.score);
        if (isRecord) state.bestScore = state.score;
        updateScoreDOM();

        var scoreCoins = Math.max(0, parseInt(state.score, 10) || 0);

        if (els.overScore) els.overScore.textContent = state.score.toLocaleString();
        if (els.overLines) els.overLines.textContent = state.linesClearedTotal;
        if (els.overMaxCombo) els.overMaxCombo.textContent = "x" + maxComboThisGame;

        // 1 очко = 1 тугрик — показываем сразу
        if (scoreCoins > 0 && els.overReward) {
          els.overReward.textContent = "+" + scoreCoins.toLocaleString() + " 💰";
          if (els.overRewardRow) els.overRewardRow.hidden = false;
        } else if (els.overRewardRow) {
          els.overRewardRow.hidden = true;
        }

        if (els.gameOverModal) {
          els.gameOverModal.hidden = false;
        }

        // МГНОВЕННО начисляем тугрики на счет игрока локально
        if (scoreCoins > 0 && typeof opts.onReward === "function") {
          try {
            opts.onReward(scoreCoins);
          } catch (e) {
            console.warn("[blockblast] onReward error:", e);
          }
        }

        // Синхронизация с сервером для сохранения баланса в БД
        var apiBase = opts.apiBase || "";
        var authObj = typeof opts.authHeaders === "function" ? opts.authHeaders() : {};
        var headers = Object.assign({ "Content-Type": "application/json" }, authObj);

        var curBal = (typeof opts.getBalance === "function") ? opts.getBalance() : 0;

        fetch((apiBase || "") + "/api/blockblast/game_over", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            score: scoreCoins,
            lines: state.linesClearedTotal,
            max_combo: maxComboThisGame,
            client_balance: curBal
          })
        })
          .then(function (r) {
            if (!r.ok) {
              throw new Error("HTTP " + r.status);
            }
            return r.json();
          })
          .then(function (data) {
            if (data && data.ok) {
              var coins = typeof data.coins_awarded === "number" ? data.coins_awarded : scoreCoins;
              if (coins > 0 && els.overReward) {
                els.overReward.textContent = "+" + coins.toLocaleString() + " 💰";
                if (els.overRewardRow) els.overRewardRow.hidden = false;
              }
              if (typeof data.balance === "number" && typeof opts.onReward === "function") {
                // Сервер вернул подтвержденный баланс
                opts.onReward(0, data.balance);
              }
              if (data.best_score && data.best_score > state.bestScore) {
                state.bestScore = data.best_score;
                self.saveBestScore(state.bestScore);
                updateScoreDOM();
              }
            }
          })
          .catch(function (err) {
            console.warn("[blockblast] game_over sync notice (coins already credited locally):", err && err.message);
          });
      }

      function onBoardCellClick(r, c) {
        if (selectedPieceIdx === null || isDragging) return;
        var piece = state.rack[selectedPieceIdx];
        if (!piece || piece.used) return;

        var placed = placePieceAction(r, c, piece, selectedPieceIdx);
        if (!placed) {
          self.haptic("warning");
          var node = cellNodes[r][c];
          if (node) {
            node.classList.add("is-invalid-shake");
            setTimeout(function () { node.classList.remove("is-invalid-shake"); }, 300);
          }
        }
      }

      function createDragAvatar(piece) {
        var avatar = document.createElement("div");
        avatar.className = "bb-drag-avatar";
        avatar.style.position = "fixed";
        avatar.style.pointerEvents = "none";
        avatar.style.zIndex = "99999";
        avatar.style.transform = "translate(-50%, -50%) scale(1.05)";
        avatar.style.transition = "none";

        var mat = piece.matrix;
        var rows = mat.length;
        var cols = mat[0].length;
        avatar.style.display = "grid";
        avatar.style.gridTemplateRows = "repeat(" + rows + ", 36px)";
        avatar.style.gridTemplateColumns = "repeat(" + cols + ", 36px)";
        avatar.style.gap = "3px";

        var colorInfo = COLORS[piece.color] || COLORS.cyan;

        for (var r = 0; r < rows; r++) {
          for (var c = 0; c < cols; c++) {
            var block = document.createElement("div");
            if (mat[r][c]) {
              block.style.width = "36px";
              block.style.height = "36px";
              block.style.borderRadius = "7px";
              block.style.backgroundColor = colorInfo.bg;
              block.style.border = "1.5px solid " + colorInfo.border;
              block.style.boxShadow = "inset 0 1px 2px rgba(255,255,255,0.4), 0 4px 12px " + colorInfo.glow;
            } else {
              block.style.width = "36px";
              block.style.height = "36px";
              block.style.visibility = "hidden";
            }
            avatar.appendChild(block);
          }
        }
        document.body.appendChild(avatar);
        return avatar;
      }

      function attachDragEvents(pieceWrap, piece, slotIdx) {
        // Тач-события
        pieceWrap.addEventListener("touchstart", function (e) {
          if (piece.used) return;
          var touch = e.touches[0];
          startDrag(touch.clientX, touch.clientY, piece, slotIdx);
          e.preventDefault();
        }, { passive: false });

        // Мышь для десктопа
        pieceWrap.addEventListener("mousedown", function (e) {
          if (piece.used) return;
          startDrag(e.clientX, e.clientY, piece, slotIdx);
          e.preventDefault();
        });

        // Клик для Tap-to-Place
        pieceWrap.addEventListener("click", function (e) {
          if (isDragging || piece.used) return;
          if (selectedPieceIdx === slotIdx) {
            selectedPieceIdx = null;
          } else {
            selectedPieceIdx = slotIdx;
            self.haptic("light");
          }
          renderRackDOM();
        });
      }

      function startDrag(clientX, clientY, piece, slotIdx) {
        isDragging = true;
        currentDragPiece = piece;
        currentDragSlotIdx = slotIdx;
        selectedPieceIdx = null;
        self.haptic("light");

        var VERTICAL_OFFSET = 65; // Поднимаем фигуру над пальцем
        var avatarX = clientX;
        var avatarY = clientY - VERTICAL_OFFSET;

        activeAvatar = createDragAvatar(piece);
        activeAvatar.style.left = avatarX + "px";
        activeAvatar.style.top = avatarY + "px";

        function onPointerMove(e) {
          if (!isDragging || !activeAvatar) return;
          var pt = e.touches ? e.touches[0] : e;
          var curX = pt.clientX;
          var curY = pt.clientY - VERTICAL_OFFSET;

          activeAvatar.style.left = curX + "px";
          activeAvatar.style.top = curY + "px";

          // Вычисляем целевую клетку на поле
          var boardRect = els.board.getBoundingClientRect();
          var cellW = boardRect.width / GRID_SIZE;
          var cellH = boardRect.height / GRID_SIZE;

          var pieceRows = piece.matrix.length;
          var pieceCols = piece.matrix[0].length;

          var targetR = Math.round((curY - boardRect.top - (pieceRows * cellH) / 2) / cellH);
          var targetC = Math.round((curX - boardRect.left - (pieceCols * cellW) / 2) / cellW);

          if (self.canPlace(state.grid, piece.matrix, targetR, targetC)) {
            if (!currentGhost || currentGhost.targetR !== targetR || currentGhost.targetC !== targetC) {
              self.haptic("selection");
            }
            renderGhostDOM(targetR, targetC, piece);
          } else {
            clearGhostDOM();
          }

          if (e.cancelable) e.preventDefault();
        }

        function onPointerEnd(e) {
          window.removeEventListener("touchmove", onPointerMove);
          window.removeEventListener("touchend", onPointerEnd);
          window.removeEventListener("mousemove", onPointerMove);
          window.removeEventListener("mouseup", onPointerEnd);

          if (activeAvatar && activeAvatar.parentNode) {
            activeAvatar.parentNode.removeChild(activeAvatar);
          }
          activeAvatar = null;

          if (currentGhost && self.canPlace(state.grid, piece.matrix, currentGhost.targetR, currentGhost.targetC)) {
            placePieceAction(currentGhost.targetR, currentGhost.targetC, piece, slotIdx);
          }

          clearGhostDOM();
          isDragging = false;
          currentDragPiece = null;
          currentDragSlotIdx = null;
        }

        window.addEventListener("touchmove", onPointerMove, { passive: false });
        window.addEventListener("touchend", onPointerEnd);
        window.addEventListener("mousemove", onPointerMove);
        window.addEventListener("mouseup", onPointerEnd);
      }

      function startNewGame() {
        state = self.createState();
        maxComboThisGame = 0;
        selectedPieceIdx = null;
        clearGhostDOM();

        if (els.gameOverModal) els.gameOverModal.hidden = true;
        if (els.comboPill) els.comboPill.hidden = true;

        createBoardDOM();
        updateBoardDOM();

        state.rack = self.generateRackPieces(state.grid);
        renderRackDOM();
        updateScoreDOM();
      }

      // Слушатели кнопок
      if (els.resetBtn) {
        els.resetBtn.addEventListener("click", function () {
          self.haptic("medium");
          startNewGame();
        });
      }
      if (els.overRestartBtn) {
        els.overRestartBtn.addEventListener("click", function () {
          self.haptic("medium");
          startNewGame();
        });
      }

      // Первый запуск
      createBoardDOM();
      startNewGame();

      return {
        restart: startNewGame,
        getState: function () { return state; }
      };
    }
  };
});
