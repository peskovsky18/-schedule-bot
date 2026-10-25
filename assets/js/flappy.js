(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FlappyGame = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BEST_KEY = "flappy_chelik_best_score";

  function haptic(type) {
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (!tg || !tg.HapticFeedback) return;
      if (type === "light" || type === "medium" || type === "heavy") {
        tg.HapticFeedback.impactOccurred(type);
      } else if (type === "success" || type === "warning" || type === "error") {
        tg.HapticFeedback.notificationOccurred(type);
      }
    } catch (e) {}
  }

  function playTone(freq, dur, type) {
    try {
      var ctx = window.AudioContext || window.webkitAudioContext;
      if (!ctx) return;
      if (!window.__flappyAudioCtx) window.__flappyAudioCtx = new ctx();
      var ac = window.__flappyAudioCtx;
      if (ac.state === "suspended") ac.resume();

      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq, ac.currentTime);
      gain.gain.setValueAtTime(0.12, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + dur);
    } catch (e) {}
  }

  function getLocalBest() {
    try {
      return parseInt(localStorage.getItem(BEST_KEY), 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  function saveLocalBest(s) {
    try {
      var prev = getLocalBest();
      if (s > prev) {
        localStorage.setItem(BEST_KEY, String(s));
        return true;
      }
    } catch (e) {}
    return false;
  }

  function init(canvasEl, domEls, opts) {
    opts = opts || {};
    var ctx = canvasEl.getContext("2d");

    var W = 360;
    var H = 540;
    var dpr = window.devicePixelRatio || 1;

    function resize() {
      var rect = canvasEl.getBoundingClientRect();
      if (rect.width && rect.height) {
        W = rect.width;
        H = rect.height;
      }
      canvasEl.width = W * dpr;
      canvasEl.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    // Состояние игры
    var state = "idle"; // "idle", "playing", "over"
    var score = 0;
    var bestScore = getLocalBest();
    var initialBestScore = bestScore;

    // Челик
    var bird = {
      x: 80,
      y: 200,
      r: 18,
      vy: 0,
      gravity: 0.36,
      jump: -6.4,
      rotation: 0,
      wingTimer: 0
    };

    // Трубы
    var pipes = [];
    var pipeWidth = 54;
    var pipeGap = 135;
    var pipeSpeed = 2.2;
    var pipeInterval = 110;
    var pipeTimer = 0;

    // Облака на фоне
    var clouds = [
      { x: 40, y: 60, scale: 0.9, speed: 0.4 },
      { x: 190, y: 120, scale: 0.7, speed: 0.3 },
      { x: 300, y: 80, scale: 1.1, speed: 0.5 }
    ];

    // Земля
    var groundHeight = 56;
    var groundOffset = 0;

    var reqId = null;

    function resetGame() {
      bestScore = getLocalBest();
      initialBestScore = bestScore;
      score = 0;
      bird.x = W * 0.26;
      bird.y = H * 0.45;
      bird.vy = 0;
      bird.rotation = 0;
      pipes = [];
      pipeTimer = pipeInterval - 30; // первая труба появится быстрее
      state = "idle";

      if (domEls.gameOverModal) domEls.gameOverModal.hidden = true;
      if (domEls.startHint) domEls.startHint.hidden = false;
      updateScoreDOM();
    }

    function flap() {
      if (state === "idle") {
        state = "playing";
        if (domEls.startHint) domEls.startHint.hidden = true;
      }

      if (state === "playing") {
        bird.vy = bird.jump;
        haptic("light");
        playTone(520, 0.08, "triangle");
      } else if (state === "over") {
        // не перезапускаем кликом по экрану, ждем кнопку "Играть снова"
      }
    }

    function updateScoreDOM() {
      if (domEls.scoreVal) domEls.scoreVal.textContent = score;
      if (domEls.bestVal) domEls.bestVal.textContent = bestScore;
    }

    function triggerGameOver() {
      state = "over";
      haptic("error");
      playTone(180, 0.25, "sawtooth");

      var wasRecord = score > initialBestScore && score > 0;
      if (score > bestScore) {
        bestScore = score;
        saveLocalBest(bestScore);
      }
      updateScoreDOM();

      var rewardCoins = wasRecord ? score : 0;

      if (domEls.overScore) domEls.overScore.textContent = score;
      if (domEls.overBest) domEls.overBest.textContent = bestScore;

      var overBadge = domEls.overBadge;
      if (overBadge) {
        overBadge.textContent = wasRecord ? "Новый рекорд!" : "Игра окончена";
      }

      if (domEls.overReward) {
        if (wasRecord) {
          domEls.overReward.textContent = "+" + rewardCoins.toLocaleString() + " тугриков (новый рекорд!)";
        } else {
          domEls.overReward.textContent = "0 тугриков (рекорд: " + bestScore.toLocaleString() + ")";
        }
      }

      if (domEls.gameOverModal) {
        domEls.gameOverModal.hidden = false;
      }

      // Мгновенное локальное начисление тугриков при рекорде
      if (rewardCoins > 0 && typeof opts.onReward === "function") {
        try {
          opts.onReward(rewardCoins);
        } catch (e) {}
      }

      // Синхронизация с сервером
      var apiBase = opts.apiBase || "";
      var authObj = typeof opts.authHeaders === "function" ? opts.authHeaders() : {};
      var headers = Object.assign({ "Content-Type": "application/json" }, authObj);
      var curBal = typeof opts.getBalance === "function" ? opts.getBalance() : 0;

      fetch((apiBase || "") + "/api/flappy/game_over", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          score: score,
          client_balance: curBal
        })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.ok) {
            var coins = typeof data.coins_awarded === "number" ? data.coins_awarded : rewardCoins;
            if (domEls.overReward) {
              if (data.is_record || coins > 0) {
                domEls.overReward.textContent = "+" + coins.toLocaleString() + " тугриков (новый рекорд!)";
                if (overBadge) overBadge.textContent = "Новый рекорд!";
              } else {
                domEls.overReward.textContent = "0 тугриков (рекорд: " + (data.best_score || bestScore).toLocaleString() + ")";
              }
            }
            if (typeof data.balance === "number" && typeof opts.onReward === "function") {
              opts.onReward(0, data.balance);
            }
            if (data.best_score && data.best_score > bestScore) {
              bestScore = data.best_score;
              saveLocalBest(bestScore);
              updateScoreDOM();
            }
          }
        })
        .catch(function () {});
    }

    function syncServerStats() {
      var apiBase = opts.apiBase || "";
      var authObj = typeof opts.authHeaders === "function" ? opts.authHeaders() : {};
      if (!authObj || Object.keys(authObj).length === 0) return;
      fetch((apiBase || "") + "/api/flappy", {
        method: "GET",
        headers: authObj
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.ok && typeof data.best_score === "number") {
            var local = getLocalBest();
            var higher = Math.max(local, data.best_score);
            if (higher > local) {
              saveLocalBest(higher);
              bestScore = higher;
              if (state === "idle") initialBestScore = higher;
              updateScoreDOM();
            }
          }
        })
        .catch(function () {});
    }

    // Отрисовка Челика
    function drawBird(x, y, rot, wingPhase) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);

      // Маленькое хлопающее крылышко сзади
      var wingY = Math.sin(wingPhase) * 6;
      ctx.save();
      ctx.translate(-10, wingY);
      ctx.fillStyle = "#ff6b8b";
      ctx.beginPath();
      ctx.ellipse(-6, -2, 8, 5, -0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Круглое тельце Челика (градиент розовый)
      var grad = ctx.createLinearGradient(-18, -18, 18, 18);
      grad.addColorStop(0, "#ff758c");
      grad.addColorStop(1, "#ff6b8b");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();

      // Ушки Челика
      ctx.fillStyle = "#ff758c";
      ctx.beginPath();
      ctx.moveTo(-10, -14);
      ctx.lineTo(-14, -22);
      ctx.lineTo(-6, -17);
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(6, -17);
      ctx.lineTo(14, -22);
      ctx.lineTo(10, -14);
      ctx.fill();

      // Внутренняя часть ушек
      ctx.fillStyle = "#fed7aa";
      ctx.beginPath();
      ctx.moveTo(-10, -15);
      ctx.lineTo(-13, -20);
      ctx.lineTo(-7, -17);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(7, -17);
      ctx.lineTo(13, -20);
      ctx.lineTo(10, -15);
      ctx.fill();

      // Животик
      ctx.fillStyle = "rgba(255, 245, 245, 0.45)";
      ctx.beginPath();
      ctx.ellipse(3, 4, 11, 9, 0, 0, Math.PI * 2);
      ctx.fill();

      // Глазки Челика
      ctx.fillStyle = "#1e1e24";
      ctx.beginPath();
      ctx.arc(6, -2, 4.2, 0, Math.PI * 2);
      ctx.fill();

      // Блик в глазу
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(7.2, -3.5, 1.6, 0, Math.PI * 2);
      ctx.fill();

      // Румянец
      ctx.fillStyle = "rgba(255, 51, 102, 0.55)";
      ctx.beginPath();
      ctx.arc(2, 4, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(12, 4, 3.2, 0, Math.PI * 2);
      ctx.fill();

      // Ротик 'w'
      ctx.strokeStyle = "#2d1b36";
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(6, 4);
      ctx.quadraticCurveTo(8, 7, 10, 4);
      ctx.quadraticCurveTo(12, 7, 14, 4);
      ctx.stroke();

      // Переднее хлопающее крылышко
      ctx.save();
      ctx.translate(-4, -wingY * 0.8);
      ctx.fillStyle = "#ff5376";
      ctx.beginPath();
      ctx.ellipse(-4, 2, 9, 5, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.restore();
    }

    // Отрисовка ретро-зелёной трубы
    function drawPipe(x, y, w, h, isTop) {
      var collarH = 22;
      var collarW = w + 8;
      var collarX = x - 4;

      // Тело трубы
      var pipeGrad = ctx.createLinearGradient(x, 0, x + w, 0);
      pipeGrad.addColorStop(0, "#74c043");
      pipeGrad.addColorStop(0.2, "#8be14d");
      pipeGrad.addColorStop(0.7, "#5ea836");
      pipeGrad.addColorStop(1, "#3f7a22");

      ctx.fillStyle = pipeGrad;
      ctx.fillRect(x, y, w, h);

      ctx.strokeStyle = "#285215";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, w, h);

      // Ободок трубы
      var collarY = isTop ? y + h - collarH : y;
      var collarGrad = ctx.createLinearGradient(collarX, 0, collarX + collarW, 0);
      collarGrad.addColorStop(0, "#74c043");
      collarGrad.addColorStop(0.2, "#97ee56");
      collarGrad.addColorStop(0.7, "#5ea836");
      collarGrad.addColorStop(1, "#36681d");

      ctx.fillStyle = collarGrad;
      ctx.fillRect(collarX, collarY, collarW, collarH);
      ctx.strokeRect(collarX, collarY, collarW, collarH);
    }

    // Главный цикл
    function loop() {
      // 1. Очистка и фон (небо)
      var skyGrad = ctx.createLinearGradient(0, 0, 0, H - groundHeight);
      skyGrad.addColorStop(0, "#38bdf8");
      skyGrad.addColorStop(0.65, "#7dd3fc");
      skyGrad.addColorStop(1, "#bae6fd");
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, H);

      // 2. Облака
      ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
      clouds.forEach(function (c) {
        c.x -= c.speed;
        if (c.x < -60) c.x = W + 40;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 16 * c.scale, 0, Math.PI * 2);
        ctx.arc(c.x + 14 * c.scale, c.y - 6 * c.scale, 18 * c.scale, 0, Math.PI * 2);
        ctx.arc(c.x + 28 * c.scale, c.y, 14 * c.scale, 0, Math.PI * 2);
        ctx.fill();
      });

      // 3. Обновление состояния
      bird.wingTimer += 0.22;

      if (state === "idle") {
        bird.y = H * 0.45 + Math.sin(bird.wingTimer * 0.8) * 8;
        bird.rotation = 0;
      } else if (state === "playing") {
        bird.vy += bird.gravity;
        bird.y += bird.vy;

        // Плавное вращение по скорости
        if (bird.vy < 0) {
          bird.rotation = Math.max(-0.45, bird.rotation - 0.08);
        } else {
          bird.rotation = Math.min(1.1, bird.rotation + 0.045);
        }

        // Проверка пола
        var floorY = H - groundHeight - bird.r;
        if (bird.y >= floorY) {
          bird.y = floorY;
          triggerGameOver();
        }

        // Проверка потолка
        if (bird.y - bird.r < 0) {
          bird.y = bird.r;
          bird.vy = 0;
        }

        // Спавн труб
        pipeTimer++;
        if (pipeTimer >= pipeInterval) {
          pipeTimer = 0;
          var minH = 60;
          var maxH = H - groundHeight - pipeGap - minH;
          var topH = Math.floor(minH + Math.random() * (maxH - minH));
          pipes.push({
            x: W + 10,
            topH: topH,
            bottomY: topH + pipeGap,
            bottomH: H - groundHeight - (topH + pipeGap),
            passed: false
          });
        }

        // Движение труб и коллизии
        for (var i = pipes.length - 1; i >= 0; i--) {
          var p = pipes[i];
          p.x -= pipeSpeed;

          // Подсчет очков
          if (!p.passed && p.x + pipeWidth < bird.x) {
            p.passed = true;
            score++;
            updateScoreDOM();
            haptic("success");
            playTone(740, 0.12, "sine");
          }

          // Проверка столкновения
          var bL = bird.x - bird.r + 4;
          var bR = bird.x + bird.r - 4;
          var bT = bird.y - bird.r + 4;
          var bB = bird.y + bird.r - 4;

          var inX = bR > p.x && bL < p.x + pipeWidth;
          if (inX) {
            var hitTop = bT < p.topH;
            var hitBottom = bB > p.bottomY;
            if (hitTop || hitBottom) {
              triggerGameOver();
            }
          }

          if (p.x < -pipeWidth - 20) {
            pipes.splice(i, 1);
          }
        }
      }

      // 4. Отрисовка труб
      pipes.forEach(function (p) {
        drawPipe(p.x, 0, pipeWidth, p.topH, true);
        drawPipe(p.x, p.bottomY, pipeWidth, p.bottomH, false);
      });

      // 5. Отрисовка земли с движущимся узором
      if (state !== "over") {
        groundOffset = (groundOffset + pipeSpeed) % 24;
      }
      var gy = H - groundHeight;

      // Трава
      ctx.fillStyle = "#86efac";
      ctx.fillRect(0, gy, W, 12);
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(0, gy + 12, W, 4);

      // Земля
      ctx.fillStyle = "#d97706";
      ctx.fillRect(0, gy + 16, W, groundHeight - 16);

      // Полоски земли
      ctx.fillStyle = "#b45309";
      for (var gx = -groundOffset; gx < W; gx += 24) {
        ctx.beginPath();
        ctx.moveTo(gx, gy + 16);
        ctx.lineTo(gx + 12, gy + 16);
        ctx.lineTo(gx + 4, gy + groundHeight);
        ctx.lineTo(gx - 8, gy + groundHeight);
        ctx.fill();
      }

      // 6. Отрисовка Челика
      drawBird(bird.x, bird.y, bird.rotation, bird.wingTimer);

      reqId = requestAnimationFrame(loop);
    }

    // Слушатели управления
    var wrapEl = canvasEl.parentElement || canvasEl;
    var cardEl = (typeof canvasEl.closest === "function") ? canvasEl.closest(".flappy-modal__card") : null;
    if (!cardEl) cardEl = wrapEl;
    var lastTouchTime = 0;
    var lastTapTime = 0;

    function handleTouch(e) {
      // Игнорируем нажатия на кнопку закрытия и кнопку перезапуска
      if (e.target && (e.target.closest("#flappyModalClose") || e.target.closest("#flappyRestartBtn"))) {
        return;
      }
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();
      lastTouchTime = Date.now();
      flap();
    }

    function preventTouchDefault(e) {
      if (e.target && (e.target.closest("#flappyModalClose") || e.target.closest("#flappyRestartBtn"))) {
        return;
      }
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();
    }

    function handleDoubleTapPrevent(e) {
      if (e.target && (e.target.closest("#flappyModalClose") || e.target.closest("#flappyRestartBtn"))) {
        return;
      }
      var now = Date.now();
      if (now - lastTapTime <= 350) {
        if (e.cancelable) e.preventDefault();
      }
      lastTapTime = now;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    }

    // Слушаем тачи на холсте, обёртке и всей карточке
    var targetElements = [canvasEl, wrapEl, cardEl];
    targetElements.forEach(function (el) {
      if (!el) return;
      el.addEventListener("touchstart", handleTouch, { passive: false });
      el.addEventListener("touchmove", preventTouchDefault, { passive: false });
      el.addEventListener("touchend", handleDoubleTapPrevent, { passive: false });
      el.addEventListener("gesturestart", preventTouchDefault, { passive: false });
      el.addEventListener("gesturechange", preventTouchDefault, { passive: false });
      el.addEventListener("gestureend", preventTouchDefault, { passive: false });
      el.addEventListener("dblclick", preventTouchDefault);
      el.addEventListener("contextmenu", preventTouchDefault);
    });

    // Для мыши на ПК: игнорируем эмулированный mousedown после тача
    function handleMouseDown(e) {
      if (e.target && (e.target.closest("#flappyModalClose") || e.target.closest("#flappyRestartBtn"))) {
        return;
      }
      if (Date.now() - lastTouchTime < 500) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      flap();
    }
    if (cardEl) {
      cardEl.addEventListener("mousedown", handleMouseDown);
    } else {
      canvasEl.addEventListener("mousedown", handleMouseDown);
    }

    function handleKeyDown(e) {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        flap();
      }
    }
    window.addEventListener("keydown", handleKeyDown);

    if (domEls.restartBtn) {
      domEls.restartBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        haptic("medium");
        resetGame();
      });
      domEls.restartBtn.addEventListener("touchstart", function (e) {
        e.stopPropagation();
      }, { passive: true });
    }

    // Запуск
    resetGame();
    syncServerStats();
    reqId = requestAnimationFrame(loop);

    return {
      restart: resetGame,
      destroy: function () {
        if (reqId) cancelAnimationFrame(reqId);
        window.removeEventListener("resize", resize);
        window.removeEventListener("keydown", handleKeyDown);
        targetElements.forEach(function (el) {
          if (!el) return;
          el.removeEventListener("touchstart", handleTouch);
          el.removeEventListener("touchmove", preventTouchDefault);
          el.removeEventListener("touchend", handleDoubleTapPrevent);
          el.removeEventListener("gesturestart", preventTouchDefault);
          el.removeEventListener("gesturechange", preventTouchDefault);
          el.removeEventListener("gestureend", preventTouchDefault);
          el.removeEventListener("dblclick", preventTouchDefault);
          el.removeEventListener("contextmenu", preventTouchDefault);
        });
        if (cardEl) cardEl.removeEventListener("mousedown", handleMouseDown);
        canvasEl.removeEventListener("mousedown", handleMouseDown);
      }
    };
  }

  return {
    init: init,
    getLocalBest: getLocalBest
  };
});
