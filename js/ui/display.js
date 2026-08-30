// ui/display.js — full-screen live courts with optional countdown timers.

import { el } from "./dom.js";
import { confirmDialog, showToast } from "./feedback.js";
import { generateRound } from "../scheduler.js";
import { deriveRoundSeed } from "../rng.js";

const DEFAULT_TIMER_SECONDS = 15 * 60;

export function restoreTimerState(timerEndsAt, now = Date.now()) {
  const endAt = Date.parse(timerEndsAt);
  if (!Number.isFinite(endAt)) {
    return {
      durationSeconds: DEFAULT_TIMER_SECONDS,
      remainingSeconds: DEFAULT_TIMER_SECONDS,
      running: false,
      expired: false,
      endAt: 0,
    };
  }
  const remainingSeconds = Math.max(0, Math.ceil((endAt - now) / 1000));
  return {
    durationSeconds: DEFAULT_TIMER_SECONDS,
    remainingSeconds,
    running: remainingSeconds > 0,
    expired: remainingSeconds === 0,
    endAt,
  };
}

export function timerEndIso(remainingSeconds, now = Date.now()) {
  return new Date(now + Math.max(0, remainingSeconds) * 1000).toISOString();
}

export function openDisplayMode(ctx) {
  const initialDb = ctx.store.getDb();
  const initialSession = findDisplaySession(initialDb, ctx.store.getUi().currentSessionId);
  if (!initialSession || !initialSession.rounds.length) {
    showToast("Open a session with a generated round first.", { tone: "danger", duration: 5000 });
    return;
  }

  let sessionId = initialSession.id;
  let roundIndex = currentRoundIndex(initialSession);
  let closed = false;
  let audioContext = null;
  const timers = new Map();
  const previouslyFocused = document.activeElement;
  const previousOverflow = document.body.style.overflow;
  const overlay = el("section", {
    class: "display-mode",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Court display mode",
    tabindex: "-1",
  });

  document.body.style.overflow = "hidden";
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKeyDown, true);

  const unsubscribe = ctx.store.subscribe((_state, meta) => {
    if (!closed && meta && ["commit", "undo", "redo", "replace"].includes(meta.type)) render();
  });

  render();
  overlay.focus({ preventScroll: true });

  function render() {
    const focused = document.activeElement;
    const focusOverlay = focused === overlay;
    const focusKey = overlay.contains(focused) && focused.dataset ? focused.dataset.displayFocus : "";
    const db = ctx.store.getDb();
    const session = db.sessions.find((item) => item.id === sessionId);
    if (!session || !session.rounds.length) {
      close();
      showToast("That session is no longer available.", { tone: "danger" });
      return;
    }

    roundIndex = Math.max(0, Math.min(roundIndex, session.rounds.length - 1));
    const round = session.rounds[roundIndex];
    const playerById = new Map(db.players.map((player) => [player.id, player]));

    overlay.replaceChildren(
      el(
        "header",
        { class: "display-mode__head" },
        el(
          "div",
          { class: "display-mode__title" },
          el("span", { class: "display-mode__eyebrow" }, session.name || session.date),
          el("strong", {}, `Round ${round.roundNumber} of ${session.rounds.length}`),
        ),
        el(
          "div",
          { class: "display-mode__actions" },
          el("button", {
            class: "display-iconbtn",
            type: "button",
            dataset: { displayFocus: "previous-round" },
            title: "Previous round",
            "aria-label": "Previous round",
            disabled: roundIndex === 0,
            onClick: () => {
              roundIndex -= 1;
              render();
            },
          }, "\u2190"),
          el("button", {
            class: "display-iconbtn",
            type: "button",
            dataset: { displayFocus: "fullscreen" },
            title: "Enter browser fullscreen",
            "aria-label": "Enter browser fullscreen",
            onClick: enterFullscreen,
          }, "\u26f6"),
          el("button", {
            class: "display-iconbtn",
            type: "button",
            dataset: { displayFocus: "close" },
            title: "Close display mode",
            "aria-label": "Close display mode",
            onClick: close,
          }, "\u00d7"),
        ),
      ),
      el(
        "div",
        { class: "display-courts", style: { "--display-court-count": String(round.courts.length) } },
        ...round.courts.map((court) => renderCourt(session, round, court, playerById)),
      ),
      el(
        "footer",
        { class: "display-mode__footer" },
        el(
          "div",
          { class: "display-mode__sitouts" },
          el("span", {}, "Sitting out"),
          el("strong", {}, round.sitOutIds.length ? round.sitOutIds.map((id) => playerName(playerById, id)).join(" \u00b7 ") : "None"),
        ),
        el(
          "button",
          { class: "display-next", type: "button", dataset: { displayFocus: "next-round" }, onClick: () => advanceRound(session, round) },
          roundIndex < session.rounds.length - 1 ? "Show next round" : "Close games & next round",
          el("span", { "aria-hidden": "true" }, "\u2192"),
        ),
      ),
    );

    if (focusOverlay) {
      overlay.focus({ preventScroll: true });
    } else if (focusKey) {
      const replacement = [...overlay.querySelectorAll("[data-display-focus]")].find((element) => element.dataset.displayFocus === focusKey);
      if (replacement) replacement.focus({ preventScroll: true });
    }
  }

  function renderCourt(session, round, court, playerById) {
    const timer = getTimer(session.id, round.roundNumber, court.courtNumber, court.timerEndsAt);
    const status = court.status === "completed" ? `${court.score.a}\u2013${court.score.b}` : court.status === "abandoned" ? "Skipped" : "Playing";

    return el(
      "article",
      { class: `display-court${timer.expired ? " display-court--expired" : ""}` },
      el(
        "div",
        { class: "display-court__head" },
        el("span", { class: "display-court__num" }, `Court ${court.courtNumber}`),
        el("span", { class: `display-court__status display-court__status--${court.status}` }, status),
      ),
      displayTeam(court.teamA, playerById, court.score ? court.score.a : null, court.score && court.score.a > court.score.b),
      el("div", { class: "display-court__versus" }, "vs"),
      displayTeam(court.teamB, playerById, court.score ? court.score.b : null, court.score && court.score.b > court.score.a),
      el(
        "div",
        { class: "display-court__timer-area" },
        el("div", { class: "display-court__timer", "aria-live": "polite" }, formatTime(timer.remainingSeconds)),
        el(
          "div",
          { class: "display-court__timer-controls" },
          timerControl("\u22121", "Subtract one minute", () => adjustTimer(timer, -60), `${timer.key}:minus`),
          timerControl(timer.running ? "Pause" : timer.expired ? "Restart" : "Start", timer.running ? "Pause timer" : "Start timer", () => toggleTimer(timer), `${timer.key}:toggle`),
          timerControl("+1", "Add one minute", () => adjustTimer(timer, 60), `${timer.key}:plus`),
          timerControl("\u21ba", "Reset timer", () => resetTimer(timer), `${timer.key}:reset`),
        ),
      ),
    );
  }

  function displayTeam(ids, playerById, score, winner) {
    return el(
      "div",
      { class: `display-court__team${winner ? " display-court__team--winner" : ""}` },
      el("div", { class: "display-court__names" }, ...ids.map((id) => el("span", {}, playerName(playerById, id)))),
      score == null ? null : el("strong", { class: "display-court__score" }, String(score)),
    );
  }

  function timerControl(text, label, onClick, focusKey) {
    return el("button", { class: "display-timerbtn", type: "button", dataset: { displayFocus: focusKey }, "aria-label": label, title: label, onClick }, text);
  }

  function getTimer(activeSessionId, roundNumber, courtNumber, timerEndsAt) {
    const key = `${activeSessionId}:${roundNumber}:${courtNumber}`;
    const persistedEndsAt = typeof timerEndsAt === "string" ? timerEndsAt : null;
    if (!timers.has(key)) {
      const timer = {
        key,
        activeSessionId,
        roundNumber,
        courtNumber,
        persistedEndsAt,
        ...restoreTimerState(persistedEndsAt),
        intervalId: null,
      };
      timers.set(key, timer);
      if (timer.running) timer.intervalId = window.setInterval(() => tickTimer(timer), 250);
    } else {
      const timer = timers.get(key);
      if (timer.persistedEndsAt !== persistedEndsAt) {
        stopTimer(timer);
        Object.assign(timer, restoreTimerState(persistedEndsAt), { persistedEndsAt });
        if (timer.running) timer.intervalId = window.setInterval(() => tickTimer(timer), 250);
      }
    }
    return timers.get(key);
  }

  function toggleTimer(timer) {
    if (timer.running) {
      syncTimer(timer);
      stopTimer(timer);
      persistTimerEnd(timer, null, "Pause court timer");
    } else {
      if (timer.remainingSeconds <= 0) timer.remainingSeconds = timer.durationSeconds;
      timer.expired = false;
      timer.running = true;
      timer.persistedEndsAt = timerEndIso(timer.remainingSeconds);
      timer.endAt = Date.parse(timer.persistedEndsAt);
      prepareAudio();
      timer.intervalId = window.setInterval(() => tickTimer(timer), 250);
      persistTimerEnd(timer, timer.persistedEndsAt, "Start court timer");
    }
    render();
  }

  function tickTimer(timer) {
    syncTimer(timer);
    if (timer.remainingSeconds <= 0) {
      stopTimer(timer);
      timer.expired = true;
      playEndSignal();
    }
    render();
  }

  function syncTimer(timer) {
    if (!timer.running) return;
    timer.remainingSeconds = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
  }

  function stopTimer(timer) {
    if (timer.intervalId != null) window.clearInterval(timer.intervalId);
    timer.intervalId = null;
    timer.running = false;
  }

  function adjustTimer(timer, seconds) {
    syncTimer(timer);
    timer.remainingSeconds = Math.max(60, Math.min(99 * 60, timer.remainingSeconds + seconds));
    timer.durationSeconds = timer.remainingSeconds;
    timer.expired = false;
    if (timer.running) {
      timer.persistedEndsAt = timerEndIso(timer.remainingSeconds);
      timer.endAt = Date.parse(timer.persistedEndsAt);
      persistTimerEnd(timer, timer.persistedEndsAt, "Adjust court timer");
    }
    render();
  }

  function resetTimer(timer) {
    stopTimer(timer);
    timer.remainingSeconds = timer.durationSeconds;
    timer.expired = false;
    persistTimerEnd(timer, null, "Reset court timer");
    render();
  }

  function persistTimerEnd(timer, value, label) {
    timer.persistedEndsAt = value;
    ctx.store.commit(label, (draft) => {
      const session = draft.sessions.find((item) => item.id === timer.activeSessionId);
      const round = session && session.rounds.find((item) => item.roundNumber === timer.roundNumber);
      const court = round && round.courts.find((item) => item.courtNumber === timer.courtNumber);
      if (court) court.timerEndsAt = value;
    }, { refresh: false });
  }

  function prepareAudio() {
    if (audioContext) {
      if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioContext = new AudioContext();
  }

  function playEndSignal() {
    if (!audioContext) return;
    const startAt = audioContext.currentTime;
    [0, 0.28, 0.56].forEach((offset) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, startAt + offset);
      gain.gain.exponentialRampToValueAtTime(0.24, startAt + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.2);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(startAt + offset);
      oscillator.stop(startAt + offset + 0.22);
    });
  }

  async function advanceRound(session, round) {
    if (roundIndex < session.rounds.length - 1) {
      roundIndex += 1;
      render();
      return;
    }

    const unresolved = round.courts.filter((court) => court.status === "pending");
    if (unresolved.length) {
      const confirmed = await confirmDialog({
        title: "Close unscored games?",
        message: `${unresolved.length} court(s) have no score. They will be marked as skipped before the next round is generated.`,
        confirmLabel: "Skip & continue",
        tone: "primary",
      });
      if (!confirmed) return;
    }

    const db = ctx.store.getDb();
    const freshSession = db.sessions.find((item) => item.id === session.id);
    if (!freshSession) return;
    const activeIds = freshSession.playerIds.filter((id) => db.players.some((player) => player.id === id && player.active));
    const result = generateRound({
      activeIds,
      ratingById: new Map(db.players.map((player) => [player.id, player.rating])),
      nameById: new Map(db.players.map((player) => [player.id, player.name])),
      courtCount: freshSession.courtCount,
      weights: db.settings.weights,
      mode: freshSession.mode,
      constraints: db.constraints,
      priorRounds: freshSession.rounds,
      roundSeed: deriveRoundSeed(freshSession.seed >>> 0, freshSession.rounds.length + 1),
      restarts: db.settings.restartCount,
    });

    if (!result.round) {
      showToast(result.error || "Could not generate the next round.", { tone: "danger", duration: 6000 });
      return;
    }

    const nextIndex = freshSession.rounds.length;
    ctx.store.commit("Next round", (draft) => {
      const storedSession = draft.sessions.find((item) => item.id === freshSession.id);
      const storedRound = storedSession.rounds.find((item) => item.roundNumber === round.roundNumber);
      storedRound.courts.forEach((court) => {
        if (court.status === "pending") court.status = "abandoned";
      });
      storedSession.rounds.forEach((item) => {
        if (item.status === "current") item.status = "completed";
      });
      result.round.status = "current";
      storedSession.rounds.push(result.round);
    });
    roundIndex = nextIndex;
    if (result.round.warnings && result.round.warnings.length) showToast(result.round.warnings[0], { duration: 6000 });
    render();
  }

  async function enterFullscreen() {
    if (!document.fullscreenElement && overlay.requestFullscreen) {
      try {
        await overlay.requestFullscreen();
      } catch {
        showToast("Browser fullscreen is unavailable. Display mode still fills this window.");
      }
    }
  }

  function onKeyDown(event) {
    const nestedDialog = document.querySelector(".dialog__overlay");
    if (nestedDialog && nestedDialog.contains(document.activeElement)) return;
    if (event.key === "Escape" && !document.fullscreenElement) {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      trapDisplayFocus(event);
    }
  }

  function trapDisplayFocus(event) {
    const focusable = [...overlay.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) {
      event.preventDefault();
      overlay.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!overlay.contains(document.activeElement) || document.activeElement === overlay) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    timers.forEach(stopTimer);
    unsubscribe();
    document.removeEventListener("keydown", onKeyDown, true);
    document.body.style.overflow = previousOverflow;
    if (overlay.parentNode) overlay.remove();
    if (document.fullscreenElement === overlay && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    if (audioContext) audioContext.close().catch(() => {});
    if (previouslyFocused && previouslyFocused.isConnected && previouslyFocused.focus) {
      previouslyFocused.focus({ preventScroll: true });
    }
  }
}

function findDisplaySession(db, currentSessionId) {
  const current = db.sessions.find((session) => session.id === currentSessionId && session.rounds.length);
  if (current) return current;
  return db.sessions.slice().reverse().find((session) => session.rounds.length) || null;
}

function currentRoundIndex(session) {
  const index = session.rounds.findIndex((round) => round.status === "current");
  return index >= 0 ? index : Math.max(0, session.rounds.length - 1);
}

function playerName(playerById, id) {
  const player = playerById.get(id);
  return player ? player.name : "Unknown player";
}

function formatTime(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
