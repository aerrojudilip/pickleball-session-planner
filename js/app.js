// app.js — bootstrap, routing, and global wiring.
//
// Responsibilities:
//  - Load the database (or seed samples on first run) and build the store.
//  - Wire Tier-1 persistence (debounced save + flush on page hide).
//  - Apply the theme and react to OS theme changes.
//  - Route between views and keep the nav in sync.
//  - Global error surfacing and undo/redo buttons.
//  - Register the service worker for offline/PWA support.

import { createStore } from "./state.js";
import { loadDatabase, createPersister } from "./storage.js";
import { createEmptyDatabase, localDateString } from "./schema.js";
import { bootstrapSamples } from "./samples.js";
import { initFeedback, showToast, confirmDialog, openDialog } from "./ui/feedback.js";
import { startOfWeek } from "./bookings.js";

import { renderRoster } from "./ui/roster.js";
import { renderSchedule } from "./ui/schedule.js";
import { renderSession } from "./ui/session.js";
import { renderStats } from "./ui/stats.js";
import { renderMore } from "./ui/more.js";
import { openDisplayMode } from "./ui/display.js";

const ROUTES = {
  roster: renderRoster,
  schedule: renderSchedule,
  session: renderSession,
  stats: renderStats,
  more: renderMore,
};

async function boot() {
  const main = document.getElementById("main");
  const nav = document.getElementById("nav");
  const toastRoot = document.getElementById("toastRoot");
  const dialogRoot = document.getElementById("dialogRoot");
  initFeedback({ toast: toastRoot, dialog: dialogRoot });

  // ---- Load or seed ----
  const load = loadDatabase();
  let initialDb;
  if (load.corrupt) {
    initialDb = createEmptyDatabase();
    // Defer the warning until UI is ready.
    queueMicrotask(() =>
      showToast("Saved data was unreadable and could not be loaded. Import a backup or start fresh.", {
        tone: "danger",
        duration: 12000,
      }),
    );
  } else if (load.db) {
    initialDb = load.db;
  } else {
    initialDb = await bootstrapSamples();
  }

  const store = createStore(initialDb);

  // Default the current session to the most recent, if any.
  const sessions = store.getDb().sessions;
  if (sessions.length) {
    store.setUi({ currentSessionId: sessions[sessions.length - 1].id });
  }
  store.setUi({ calendarWeekStart: startOfWeek(localDateString()) });

  // ---- Persistence ----
  const persister = createPersister(store, (err) => {
    const quota = err && (err.name === "QuotaExceededError" || /quota/i.test(err.message || ""));
    showToast(
      quota
        ? "Storage is full. Export a JSON backup to avoid losing data."
        : "Could not save to this browser's storage.",
      { tone: "danger", duration: 12000 },
    );
  });
  window.addEventListener("pagehide", () => persister.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persister.flush();
  });

  // ---- Cross-tab awareness ----
  window.addEventListener("storage", (e) => {
    if (e.key === "pickleball.db.v1" && e.newValue) {
      showToast("This data was updated in another tab.", {
        actionLabel: "Reload",
        onAction: () => location.reload(),
        duration: 15000,
      });
    }
  });

  // ---- Theme ----
  applyTheme(store.getDb().settings.theme);
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", () => {
    if (store.getDb().settings.theme === "system") applyTheme("system");
  });

  // ---- Context passed to views ----
  const ctx = {
    store,
    persister,
    navigate,
    refresh,
    showToast,
    confirmDialog,
    openDialog,
    applyTheme,
  };

  // ---- Router ----
  function currentRoute() {
    const r = (location.hash || "#roster").replace(/^#/, "").split("/")[0];
    return ROUTES[r] ? r : "roster";
  }

  function navigate(route) {
    if (location.hash === `#${route}`) {
      refresh();
    } else {
      location.hash = `#${route}`;
    }
  }

  function refresh() {
    const route = currentRoute();
    store.setUi({ route }, { persist: false });
    for (const btn of nav.querySelectorAll(".navbtn")) {
      const active = btn.dataset.route === route;
      btn.setAttribute("aria-current", active ? "page" : "false");
    }
    const renderFn = ROUTES[route];
    try {
      renderFn(main, ctx);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      main.innerHTML = "";
      showToast("Something went wrong rendering this view.", { tone: "danger" });
    }
    main.focus({ preventScroll: true });
  }

  window.addEventListener("hashchange", refresh);
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".navbtn");
    if (btn) navigate(btn.dataset.route);
  });

  // ---- Undo/redo ----
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  undoBtn.addEventListener("click", () => {
    const label = store.undo();
    if (label) showToast(`Undo: ${label}`, { duration: 4000 });
  });
  redoBtn.addEventListener("click", () => {
    const label = store.redo();
    if (label) showToast(`Redo: ${label}`, { duration: 4000 });
  });

  document.getElementById("displayBtn").addEventListener("click", () => openDisplayMode(ctx));

  store.subscribe((_state, meta) => {
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    // Re-render on data mutations (not on pure UI route toggles, which call refresh directly).
    if (meta && meta.refresh !== false && (meta.type === "commit" || meta.type === "undo" || meta.type === "redo")) {
      refresh();
    }
  });

  // ---- Keyboard shortcuts ----
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      if (isTextEntry(e.target)) return;
      e.preventDefault();
      const label = store.undo();
      if (label) showToast(`Undo: ${label}`, { duration: 4000 });
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
      if (isTextEntry(e.target)) return;
      e.preventDefault();
      const label = store.redo();
      if (label) showToast(`Redo: ${label}`, { duration: 4000 });
    }
  });

  // ---- Global error surfacing ----
  window.addEventListener("error", (e) => {
    // eslint-disable-next-line no-console
    console.error(e.error || e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    // eslint-disable-next-line no-console
    console.error("Unhandled rejection:", e.reason);
  });

  undoBtn.disabled = !store.canUndo();
  redoBtn.disabled = !store.canRedo();

  refresh();
  registerServiceWorker();
}

function isTextEntry(node) {
  return node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable);
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Only register over secure contexts (https or localhost).
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return;
  }
  window.addEventListener("load", async () => {
    let reloadForUpdate = false;
    let offeredWorker = null;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!reloadForUpdate) return;
      reloadForUpdate = false;
      location.reload();
    });

    function offerUpdate(worker) {
      if (!worker || offeredWorker === worker) return;
      offeredWorker = worker;
      showToast("A new version is ready.", {
        actionLabel: "Update",
        duration: 30000,
        onAction: () => {
          reloadForUpdate = true;
          worker.postMessage({ type: "SKIP_WAITING" });
        },
      });
    }

    try {
      const registration = await navigator.serviceWorker.register("./sw.js");
      if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
    } catch {
      /* Offline support is progressive; the app remains usable without it. */
    }
  });
}

boot();
