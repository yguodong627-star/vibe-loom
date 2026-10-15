(() => {
  "use strict";

  const CIRCUMFERENCE = 2 * Math.PI * 104; // r=104
  const STORAGE_SETTINGS = "loom.settings.v1";
  const STORAGE_LOG = "loom.log.v1";
  const STORAGE_FOCUS_COUNT = "loom.focusCount.v1";

  const DEFAULTS = {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    autoStart: false,
    sound: true,
  };

  const MODE_LABELS = {
    focus: "专注",
    short: "短休",
    long: "长休",
  };

  const MODE_STATUS = {
    focus: { idle: "准备专注", run: "专注中", pause: "已暂停" },
    short: { idle: "准备短休", run: "短休中", pause: "已暂停" },
    long: { idle: "准备长休", run: "长休中", pause: "已暂停" },
  };

  /** @type {typeof DEFAULTS} */
  let settings = loadSettings();
  let mode = "focus"; // focus | short | long
  let totalSeconds = settings.focusMin * 60;
  let remaining = totalSeconds;
  let running = false;
  let rafId = null;
  let endAt = 0;
  let focusCompletedToday = loadFocusCount();
  /** sessions completed in current cycle toward long break (0-3) */
  let focusInCycle = focusCompletedToday % 4;

  // DOM
  const $ = (id) => document.getElementById(id);
  const timeDisplay = $("timeDisplay");
  const timeLabel = $("timeLabel");
  const ringProgress = $("ringProgress");
  const btnToggle = $("btnToggle");
  const btnReset = $("btnReset");
  const intention = $("intention");
  const sessionPill = $("sessionPill");
  const cyclePill = $("cyclePill");
  const logList = $("logList");
  const btnClearLog = $("btnClearLog");
  const settingsOverlay = $("settingsOverlay");
  const btnSettings = $("btnSettings");
  const btnCloseSettings = $("btnCloseSettings");
  const btnSaveSettings = $("btnSaveSettings");
  const setFocus = $("setFocus");
  const setShort = $("setShort");
  const setLong = $("setLong");
  const setAutoStart = $("setAutoStart");
  const setSound = $("setSound");
  const modeBtns = Array.from(document.querySelectorAll(".mode-btn"));

  ringProgress.style.strokeDasharray = String(CIRCUMFERENCE);

  // ---------- storage ----------
  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_SETTINGS);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
  }

  function loadFocusCount() {
    try {
      const raw = localStorage.getItem(STORAGE_FOCUS_COUNT);
      if (!raw) return 0;
      const data = JSON.parse(raw);
      return data.date === todayKey() ? data.count | 0 : 0;
    } catch {
      return 0;
    }
  }

  function saveFocusCount(count) {
    localStorage.setItem(
      STORAGE_FOCUS_COUNT,
      JSON.stringify({ date: todayKey(), count })
    );
  }

  function loadLog() {
    try {
      const raw = localStorage.getItem(STORAGE_LOG);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return data.date === todayKey() && Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  }

  function saveLog(items) {
    localStorage.setItem(
      STORAGE_LOG,
      JSON.stringify({ date: todayKey(), items })
    );
  }

  // ---------- audio (Web Audio API) ----------
  let audioCtx = null;

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playChime() {
    if (!settings.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [
      { f: 523.25, t: 0, d: 0.35 },    // C5
      { f: 659.25, t: 0.18, d: 0.4 },  // E5
      { f: 783.99, t: 0.38, d: 0.55 }, // G5
    ];

    notes.forEach(({ f, t, d }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.12, now + t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + t + d);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + t);
      osc.stop(now + t + d + 0.05);
    });
  }

  // ---------- timer core ----------
  function minutesFor(m) {
    if (m === "focus") return settings.focusMin;
    if (m === "short") return settings.shortMin;
    return settings.longMin;
  }

  function setMode(next, { preserveRunning = false } = {}) {
    if (running && !preserveRunning) stopTicker();
    mode = next;
    document.body.dataset.mode = next;
    modeBtns.forEach((btn) => {
      const active = btn.dataset.mode === next;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    totalSeconds = minutesFor(next) * 60;
    remaining = totalSeconds;
    running = false;
    updateToggleBtn();
    updateCyclePill();
    render();
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function render() {
    timeDisplay.textContent = formatTime(remaining);
    const progress = totalSeconds > 0 ? remaining / totalSeconds : 0;
    ringProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress));

    let statusKey = "idle";
    if (running) statusKey = "run";
    else if (remaining < totalSeconds) statusKey = "pause";
    timeLabel.textContent = MODE_STATUS[mode][statusKey];

    sessionPill.textContent = `今日 ${focusCompletedToday} 段`;

    if (running) {
      document.title = `${formatTime(remaining)} · 织时 Loom`;
    } else {
      document.title = "织时 Loom";
    }
  }

  function updateToggleBtn() {
    btnToggle.textContent = running ? "暂停" : remaining < totalSeconds ? "继续" : "开始";
    btnToggle.setAttribute("aria-label", btnToggle.textContent);
  }

  function updateCyclePill() {
    if (mode === "focus") {
      const nextLong = focusInCycle >= 3;
      cyclePill.textContent = nextLong ? "下一：长休" : "下一：短休";
    } else {
      cyclePill.textContent = "下一：专注";
    }
  }

  function tick() {
    if (!running) return;
    const left = (endAt - performance.now()) / 1000;
    remaining = Math.max(0, left);
    render();
    if (remaining <= 0) {
      completeSession();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function startTicker() {
    endAt = performance.now() + remaining * 1000;
    running = true;
    updateToggleBtn();
    ensureAudio(); // unlock on gesture
    rafId = requestAnimationFrame(tick);
    render();
  }

  function stopTicker() {
    running = false;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    updateToggleBtn();
    render();
  }

  function toggle() {
    if (running) stopTicker();
    else startTicker();
  }

  function reset() {
    stopTicker();
    remaining = totalSeconds;
    updateToggleBtn();
    render();
  }

  function completeSession() {
    stopTicker();
    remaining = 0;
    render();
    playChime();

    if (mode === "focus") {
      const durMin = settings.focusMin;
      const text = (intention.value || "").trim() || "未命名专注";
      const items = loadLog();
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      items.unshift({
        intention: text,
        durationMin: durMin,
        time: timeStr,
        ts: now.getTime(),
      });
      saveLog(items);
      renderLog();

      focusCompletedToday += 1;
      focusInCycle = (focusInCycle + 1) % 4;
      saveFocusCount(focusCompletedToday);
      updateCyclePill();
      render();

      const next = focusInCycle === 0 ? "long" : "short";
      advanceTo(next);
    } else {
      advanceTo("focus");
    }
  }

  function advanceTo(nextMode) {
    setMode(nextMode);
    if (settings.autoStart) {
      // slight delay so chime / UI settle
      setTimeout(() => {
        if (!running && mode === nextMode) startTicker();
      }, 600);
    }
  }

  // ---------- log UI ----------
  function renderLog() {
    const items = loadLog();
    logList.innerHTML = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "log-empty";
      li.textContent = "完成一段专注后，会记在这里";
      logList.appendChild(li);
      btnClearLog.hidden = true;
      return;
    }
    btnClearLog.hidden = false;
    items.forEach((item) => {
      const li = document.createElement("li");
      const title = document.createElement("span");
      title.className = "log-intention";
      title.textContent = item.intention;
      const dur = document.createElement("span");
      dur.className = "log-dur";
      dur.textContent = `${item.durationMin} 分`;
      const meta = document.createElement("span");
      meta.className = "log-meta";
      meta.textContent = item.time;
      li.append(title, dur, meta);
      logList.appendChild(li);
    });
  }

  // ---------- settings UI ----------
  function openSettings() {
    setFocus.value = settings.focusMin;
    setShort.value = settings.shortMin;
    setLong.value = settings.longMin;
    setAutoStart.checked = settings.autoStart;
    setSound.checked = settings.sound;
    settingsOverlay.hidden = false;
  }

  function closeSettings() {
    settingsOverlay.hidden = true;
  }

  function applySettingsFromForm() {
    const f = clampInt(setFocus.value, 1, 180, DEFAULTS.focusMin);
    const s = clampInt(setShort.value, 1, 60, DEFAULTS.shortMin);
    const l = clampInt(setLong.value, 1, 90, DEFAULTS.longMin);
    settings = {
      focusMin: f,
      shortMin: s,
      longMin: l,
      autoStart: setAutoStart.checked,
      sound: setSound.checked,
    };
    saveSettings();
    // refresh current mode duration if idle at full
    const wasFull = !running && remaining === totalSeconds;
    totalSeconds = minutesFor(mode) * 60;
    if (wasFull) remaining = totalSeconds;
    else if (!running) remaining = Math.min(remaining, totalSeconds);
    updateCyclePill();
    render();
    closeSettings();
  }

  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // ---------- events ----------
  btnToggle.addEventListener("click", toggle);
  btnReset.addEventListener("click", reset);

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.mode === mode) return;
      if (running) {
        const ok = confirm("计时进行中，切换模式会重置当前段。继续？");
        if (!ok) return;
      }
      setMode(btn.dataset.mode);
    });
  });

  btnSettings.addEventListener("click", openSettings);
  btnCloseSettings.addEventListener("click", closeSettings);
  btnSaveSettings.addEventListener("click", applySettingsFromForm);

  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  btnClearLog.addEventListener("click", () => {
    if (!confirm("清空今日织就记录？")) return;
    saveLog([]);
    renderLog();
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.code === "Space") {
      e.preventDefault();
      toggle();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      reset();
    } else if (e.key === "Escape" && !settingsOverlay.hidden) {
      closeSettings();
    }
  });

  // visibility: keep accuracy when tab hidden by using endAt + perf now
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && running) {
      remaining = Math.max(0, (endAt - performance.now()) / 1000);
      if (remaining <= 0) completeSession();
      else render();
    }
  });

  // ---------- init ----------
  document.body.dataset.mode = "focus";
  setMode("focus");
  renderLog();
  updateCyclePill();
})();
