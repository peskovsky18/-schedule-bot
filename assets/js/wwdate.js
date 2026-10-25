(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.WWDate = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PROFILES = [
    {
      id: "egor",
      name: "Егор Крид",
      age: 30,
      verified: true,
      photo: "assets/img/wwdate/egor.jpg",
      occupation: "Музыкант",
      distance: "2 км от вас",
      bio: "Пишу треки, иногда стримлю. Если долго не отвечаю — на студии.",
      tags: ["Музыка", "CS2", "Пицца", "Ночной город"],
      matchQuote: "Привет, взаимно)",
      chatDialog: {
        greeting: "Привет) Как дела?",
        replies: [
          "Привет! Всё отлично, ты как?",
          "Слушаю твой новый трек)",
          "Опять на студии пропадаешь?"
        ],
        responses: {
          "Привет! Всё отлично, ты как?": "Тоже в порядке, только со студии еду. Чем занимаешься?",
          "Слушаю твой новый трек)": "О, круто, приятно слышать) Как тебе звучание?",
          "Опять на студии пропадаешь?": "Ну как обычно) Музыка сама себя не запишет."
        }
      }
    },
    {
      id: "sinyak",
      name: "Игорь Синяк",
      age: 29,
      verified: true,
      photo: "assets/img/wwdate/sinyak.jpg",
      occupation: "Блогер",
      distance: "4 км от вас",
      bio: "Блогер. Люблю хороший кофе, поездки и нормальное общение.",
      tags: ["Кофе", "Путешествия", "Шоппинг", "Видео"],
      matchQuote: "Привет! Классный мэтч",
      chatDialog: {
        greeting: "Привет) Классные фотки в профиле!",
        replies: [
          "Привет, спасибо!)",
          "Привет, как твои дела?",
          "Чем сегодня занимаешься?"
        ],
        responses: {
          "Привет, спасибо!)": "Правда, отличный вайб. Кофе сегодня уже пила?)",
          "Привет, как твои дела?": "Отлично, монтирую новое видео. Ты как, отдыхаешь?",
          "Чем сегодня занимаешься?": "Да по делам в центре мотаюсь, потом в кофейню заскочу."
        }
      }
    },
    {
      id: "sasha",
      name: "Саша Песковский",
      age: 21,
      verified: true,
      photo: "assets/img/wwdate/sasha.jpg",
      occupation: "Начинающий рэп-исполнитель",
      distance: "200 м от вас",
      bio: "Начинающий рэп-исполнитель. Студент.",
      tags: ["Рэп", "Музыка", "Сникеры"],
      matchQuote: "Салют, взаимный лайк)",
      chatDialog: {
        greeting: "Салют! Как день проходит?",
        replies: [
          "Привет! Да на парах сижу)",
          "Привет, треки твои слушаю)",
          "Привет, чем занят?"
        ],
        responses: {
          "Привет! Да на парах сижу)": "Понимаю, держись) Сам скоро поеду.",
          "Привет, треки твои слушаю)": "О, респект) Скоро новый релиз дропну.",
          "Привет, чем занят?": "Да дома сижу, биты свожу. Ты как?"
        }
      }
    }
  ];

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

  function playTone(freq, duration, type) {
    try {
      var ctx = window.AudioContext || window.webkitAudioContext;
      if (!ctx) return;
      if (!window.__wwAudioCtx) window.__wwAudioCtx = new ctx();
      var ac = window.__wwAudioCtx;
      if (ac.state === "suspended") ac.resume();

      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq, ac.currentTime);
      gain.gain.setValueAtTime(0.12, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + duration);
    } catch (e) {}
  }

  function init(containerEl, options) {
    options = options || {};
    var curIdx = 0;
    var history = [];
    var isDragging = false;
    var startX = 0;
    var startY = 0;
    var currentX = 0;
    var currentY = 0;
    var cardEl = null;
    var nextCardEl = null;

    var stackEl = containerEl.querySelector("#wwdateCardStack");
    var nopeBtn = containerEl.querySelector("#wwdateBtnNope");
    var rewindBtn = containerEl.querySelector("#wwdateBtnRewind");
    var superBtn = containerEl.querySelector("#wwdateBtnSuper");
    var likeBtn = containerEl.querySelector("#wwdateBtnLike");

    var matchModal = containerEl.querySelector("#wwdateMatchModal");
    var matchPhotoUser = containerEl.querySelector("#wwdateMatchUserPhoto");
    var matchPhotoThem = containerEl.querySelector("#wwdateMatchThemPhoto");
    var matchQuote = containerEl.querySelector("#wwdateMatchQuote");
    var matchChatBtn = containerEl.querySelector("#wwdateMatchChatBtn");
    var matchKeepBtn = containerEl.querySelector("#wwdateMatchKeepBtn");

    var chatModal = containerEl.querySelector("#wwdateChatModal");
    var chatCloseBtn = containerEl.querySelector("#wwdateChatClose");
    var chatHeaderName = containerEl.querySelector("#wwdateChatName");
    var chatHeaderPhoto = containerEl.querySelector("#wwdateChatPhoto");
    var chatMessages = containerEl.querySelector("#wwdateChatMessages");
    var chatReplies = containerEl.querySelector("#wwdateChatReplies");

    function renderCard(profile, isUnder) {
      var el = document.createElement("div");
      el.className = "wwdate-card" + (isUnder ? " wwdate-card--next" : "");
      el.dataset.id = profile.id;

      var tagsHtml = (profile.tags || []).map(function (tag) {
        return '<span class="wwdate-card__tag">' + tag + '</span>';
      }).join("");

      el.innerHTML =
        '<div class="wwdate-card__badge wwdate-card__badge--like" id="badgeLike">LIKE</div>' +
        '<div class="wwdate-card__badge wwdate-card__badge--nope" id="badgeNope">NOPE</div>' +
        '<div class="wwdate-card__badge wwdate-card__badge--super" id="badgeSuper">SUPER</div>' +
        '<div class="wwdate-card__photo-box">' +
          '<img class="wwdate-card__photo" src="' + profile.photo + '" alt="' + profile.name + '" loading="eager">' +
          '<div class="wwdate-card__gradient"></div>' +
        '</div>' +
        '<div class="wwdate-card__info">' +
          '<div class="wwdate-card__header">' +
            '<h3 class="wwdate-card__name">' + profile.name + ', <span class="wwdate-card__age">' + profile.age + '</span></h3>' +
            (profile.verified ? '<span class="wwdate-card__verified" title="Верифицирован">✓</span>' : '') +
          '</div>' +
          '<div class="wwdate-card__sub">' +
            '<div class="wwdate-card__occ">' + profile.occupation + '</div>' +
            '<div class="wwdate-card__dist">' + profile.distance + '</div>' +
          '</div>' +
          '<p class="wwdate-card__bio">' + profile.bio + '</p>' +
          '<div class="wwdate-card__tags">' + tagsHtml + '</div>' +
        '</div>';

      return el;
    }

    function updateStack() {
      if (!stackEl) return;
      stackEl.innerHTML = "";

      var curProfile = PROFILES[curIdx];
      var nextIdx = (curIdx + 1) % PROFILES.length;
      var nextProfile = PROFILES[nextIdx];

      nextCardEl = renderCard(nextProfile, true);
      cardEl = renderCard(curProfile, false);

      stackEl.appendChild(nextCardEl);
      stackEl.appendChild(cardEl);

      bindCardGestures(cardEl);
    }

    function bindCardGestures(card) {
      if (!card) return;

      var badgeLike = card.querySelector("#badgeLike");
      var badgeNope = card.querySelector("#badgeNope");
      var badgeSuper = card.querySelector("#badgeSuper");

      function onPointerDown(e) {
        if (isDragging) return;
        isDragging = true;
        startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
        startY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
        currentX = startX;
        currentY = startY;

        card.style.transition = "none";
        if (nextCardEl) nextCardEl.style.transition = "none";

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
        window.addEventListener("touchmove", onTouchMove, { passive: false });
        window.addEventListener("touchend", onPointerUp);
      }

      function onPointerMove(e) {
        if (!isDragging) return;
        currentX = e.clientX;
        currentY = e.clientY;
        processDrag();
      }

      function onTouchMove(e) {
        if (!isDragging) return;
        if (e.touches && e.touches.length > 0) {
          currentX = e.touches[0].clientX;
          currentY = e.touches[0].clientY;
          processDrag();
          e.preventDefault();
        }
      }

      function processDrag() {
        var dx = currentX - startX;
        var dy = currentY - startY;
        var rot = dx * 0.08;

        card.style.transform = "translate(" + dx + "px, " + dy + "px) rotate(" + rot + "deg)";

        // Управление бейджами
        if (dy < -40 && Math.abs(dx) < 40) {
          var superOp = Math.min(1, Math.abs(dy + 40) / 60);
          if (badgeSuper) badgeSuper.style.opacity = superOp;
          if (badgeLike) badgeLike.style.opacity = 0;
          if (badgeNope) badgeNope.style.opacity = 0;
        } else if (dx > 20) {
          var likeOp = Math.min(1, (dx - 20) / 60);
          if (badgeLike) badgeLike.style.opacity = likeOp;
          if (badgeNope) badgeNope.style.opacity = 0;
          if (badgeSuper) badgeSuper.style.opacity = 0;
        } else if (dx < -20) {
          var nopeOp = Math.min(1, (-dx - 20) / 60);
          if (badgeNope) badgeNope.style.opacity = nopeOp;
          if (badgeLike) badgeLike.style.opacity = 0;
          if (badgeSuper) badgeSuper.style.opacity = 0;
        } else {
          if (badgeLike) badgeLike.style.opacity = 0;
          if (badgeNope) badgeNope.style.opacity = 0;
          if (badgeSuper) badgeSuper.style.opacity = 0;
        }

        // Анимация нижней карточки
        if (nextCardEl) {
          var progress = Math.min(1, Math.max(Math.abs(dx), Math.abs(dy)) / 140);
          var scale = 0.94 + progress * 0.06;
          var transY = 16 - progress * 16;
          nextCardEl.style.transform = "scale(" + scale + ") translateY(" + transY + "px)";
        }
      }

      function onPointerUp() {
        if (!isDragging) return;
        isDragging = false;

        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        window.removeEventListener("touchmove", onTouchMove);
        window.removeEventListener("touchend", onPointerUp);

        var dx = currentX - startX;
        var dy = currentY - startY;

        if (dy < -90 && Math.abs(dx) < 60) {
          triggerSwipe("super");
        } else if (dx > 85) {
          triggerSwipe("like");
        } else if (dx < -85) {
          triggerSwipe("nope");
        } else {
          // Возврат назад
          card.style.transition = "transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
          card.style.transform = "translate(0, 0) rotate(0deg)";
          if (badgeLike) badgeLike.style.opacity = 0;
          if (badgeNope) badgeNope.style.opacity = 0;
          if (badgeSuper) badgeSuper.style.opacity = 0;

          if (nextCardEl) {
            nextCardEl.style.transition = "transform 0.25s ease";
            nextCardEl.style.transform = "scale(0.94) translateY(16px)";
          }
        }
      }

      card.addEventListener("pointerdown", onPointerDown);
    }

    function triggerSwipe(action) {
      if (!cardEl) return;
      var profile = PROFILES[curIdx];
      history.push(curIdx);

      cardEl.style.transition = "transform 0.35s ease-out, opacity 0.35s ease-out";
      if (nextCardEl) {
        nextCardEl.style.transition = "transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)";
        nextCardEl.style.transform = "scale(1) translateY(0)";
      }

      var badgeLike = cardEl.querySelector("#badgeLike");
      var badgeNope = cardEl.querySelector("#badgeNope");
      var badgeSuper = cardEl.querySelector("#badgeSuper");

      if (action === "like") {
        if (badgeLike) badgeLike.style.opacity = 1;
        cardEl.style.transform = "translate(450px, 40px) rotate(30deg)";
        cardEl.style.opacity = "0";
        haptic("success");
        playTone(587, 0.15, "triangle");
        setTimeout(function () {
          showMatch(profile);
          advanceToNext();
        }, 220);
      } else if (action === "super") {
        if (badgeSuper) badgeSuper.style.opacity = 1;
        cardEl.style.transform = "translate(0, -500px) rotate(0deg)";
        cardEl.style.opacity = "0";
        haptic("heavy");
        playTone(784, 0.25, "square");
        setTimeout(function () {
          showMatch(profile, true);
          advanceToNext();
        }, 220);
      } else {
        // Nope
        if (badgeNope) badgeNope.style.opacity = 1;
        cardEl.style.transform = "translate(-450px, 40px) rotate(-30deg)";
        cardEl.style.opacity = "0";
        haptic("light");
        playTone(220, 0.12, "sine");
        setTimeout(function () {
          advanceToNext();
        }, 250);
      }
    }

    function advanceToNext() {
      curIdx = (curIdx + 1) % PROFILES.length;
      updateStack();
    }

    function rewind() {
      if (history.length === 0) {
        haptic("warning");
        return;
      }
      curIdx = history.pop();
      haptic("medium");
      playTone(440, 0.15, "sine");
      updateStack();
    }

    // Match Modal
    function showMatch(profile, isSuper) {
      if (!matchModal) return;

      if (matchPhotoThem) matchPhotoThem.src = profile.photo;
      if (matchQuote) {
        matchQuote.textContent = '«' + (profile.matchQuote || "Вы понравились друг другу!") + '»';
      }

      var matchTitle = matchModal.querySelector(".wwdate-match__title");
      if (matchTitle) {
        matchTitle.textContent = isSuper ? "IT'S A SUPER MATCH!" : "IT'S A MATCH!";
      }

      matchModal.hidden = false;
      matchModal.classList.add("is-visible");
      haptic("success");

      // Конфетти эффект
      spawnConfetti(matchModal);

      if (matchChatBtn) {
        matchChatBtn.onclick = function () {
          matchModal.hidden = true;
          matchModal.classList.remove("is-visible");
          openChat(profile);
        };
      }

      if (matchKeepBtn) {
        matchKeepBtn.onclick = function () {
          matchModal.hidden = true;
          matchModal.classList.remove("is-visible");
        };
      }
    }

    function spawnConfetti(container) {
      var box = container.querySelector(".wwdate-match__confetti");
      if (!box) return;
      box.innerHTML = "";
      var colors = ["#ff4b72", "#ff7854", "#ffd700", "#00d2ff", "#a855f7"];
      for (var i = 0; i < 35; i++) {
        var p = document.createElement("div");
        p.className = "wwdate-confetti-particle";
        p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        p.style.left = Math.random() * 100 + "%";
        p.style.animationDelay = (Math.random() * 0.4) + "s";
        p.style.transform = "rotate(" + (Math.random() * 360) + "deg)";
        box.appendChild(p);
      }
    }

    // Шуточный чат
    function openChat(profile) {
      if (!chatModal) return;
      chatModal.hidden = false;

      if (chatHeaderName) chatHeaderName.textContent = profile.name;
      if (chatHeaderPhoto) chatHeaderPhoto.src = profile.photo;

      if (chatMessages) {
        chatMessages.innerHTML =
          '<div class="wwdate-chat__bubble wwdate-chat__bubble--them">' +
            profile.chatDialog.greeting +
            '<span class="wwdate-chat__time">сейчас</span>' +
          '</div>';
      }

      renderReplies(profile);
    }

    function renderReplies(profile) {
      if (!chatReplies) return;
      chatReplies.innerHTML = "";

      var replies = profile.chatDialog.replies || [];
      replies.forEach(function (repText) {
        var btn = document.createElement("button");
        btn.className = "wwdate-chat__reply-btn";
        btn.type = "button";
        btn.textContent = repText;
        btn.onclick = function () {
          handleUserReply(profile, repText);
        };
        chatReplies.appendChild(btn);
      });
    }

    function handleUserReply(profile, text) {
      if (!chatMessages) return;

      // Пользовательское сообщение
      var userBubble = document.createElement("div");
      userBubble.className = "wwdate-chat__bubble wwdate-chat__bubble--me";
      userBubble.innerHTML = text + '<span class="wwdate-chat__time">сейчас</span>';
      chatMessages.appendChild(userBubble);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // Очищаем варианты ответа на время "печатает..."
      if (chatReplies) {
        chatReplies.innerHTML = '<div class="wwdate-chat__typing"><span></span><span></span><span></span> ' + profile.name + ' печатает...</div>';
      }

      haptic("light");

      setTimeout(function () {
        var replyAnswer = profile.chatDialog.responses[text] || "Рад знакомству, на связи!)";

        var themBubble = document.createElement("div");
        themBubble.className = "wwdate-chat__bubble wwdate-chat__bubble--them";
        themBubble.innerHTML = replyAnswer + '<span class="wwdate-chat__time">сейчас</span>';
        chatMessages.appendChild(themBubble);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        haptic("medium");
        playTone(660, 0.15, "triangle");

        if (chatReplies) {
          chatReplies.innerHTML =
            '<button class="wwdate-chat__finish-btn" type="button" id="wwdateChatFinish">' +
              'Вернуться к анкетам' +
            '</button>';
          var finBtn = chatReplies.querySelector("#wwdateChatFinish");
          if (finBtn) {
            finBtn.onclick = function () {
              chatModal.hidden = true;
            };
          }
        }
      }, 900);
    }

    if (chatCloseBtn) {
      chatCloseBtn.onclick = function () {
        if (chatModal) chatModal.hidden = true;
      };
    }

    // Слушатели кнопок под карточкой
    if (nopeBtn) {
      nopeBtn.onclick = function () { triggerSwipe("nope"); };
    }
    if (likeBtn) {
      likeBtn.onclick = function () { triggerSwipe("like"); };
    }
    if (superBtn) {
      superBtn.onclick = function () { triggerSwipe("super"); };
    }
    if (rewindBtn) {
      rewindBtn.onclick = rewind;
    }

    // Первичная отрисовка
    updateStack();

    return {
      restart: function () {
        curIdx = 0;
        history = [];
        updateStack();
      }
    };
  }

  return {
    PROFILES: PROFILES,
    init: init
  };
});
