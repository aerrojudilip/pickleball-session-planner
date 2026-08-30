// app.js — bootstrap, routing, and global wiring.
//
// Responsibilities:
//  - Load the database (or seed samples on first run) and build the store.
//  - Wire atomic Tier-1 persistence and flush retries on page hide.
//  - Apply the theme and react to OS theme changes.
//  - Route between views and keep the nav in sync.
//  - Global error surfacing and undo/redo buttons.
//  - Register the service worker for offline/PWA support.

import { createStore } from "./state.js";
import { loadDatabase, createPersister, overwriteDatabase } from "./storage.js";
import { createEmptyDatabase, localDateString } from "./schema.js";
import { bootstrapSamples } from "./samples.js";
import { createAdminAuth } from "./auth.js";
import { SUPABASE_CONFIG } from "./config.js";
import { createCloudPersister, createSupabaseBackend, SupabaseConflictError } from "./supabase.js";
import { initFeedback, showToast, confirmDialog, openDialog } from "./ui/feedback.js";
import { startOfWeek } from "./bookings.js";

import { renderRoster } from "./ui/roster.js";
import { renderSchedule } from "./ui/schedule.js";
import { renderSession } from "./ui/session.js";
import { renderStats } from "./ui/stats.js";
import { renderMore } from "./ui/more.js";
import { openDisplayMode } from "./ui/display.js";
import { renderAdminLogin } from "./ui/login.js";

const ROUTES = {
  roster: renderRoster,
  schedule: renderSchedule,
  session: renderSession,
  stats: renderStats,
  more: renderMore,
};

const ADMIN_ROUTES = new Map([
  ["more", "settings, backups, and data management"],
]);

async function boot() {
  const main = document.getElementById("main");
  const nav = document.getElementById("nav");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const displayBtn = document.getElementById("displayBtn");
  const adminBtn = document.getElementById("adminBtn");
  const toastRoot = document.getElementById("toastRoot");
  const dialogRoot = document.getElementById("dialogRoot");
  initFeedback({ toast: toastRoot, dialog: dialogRoot });

  // ---- Load remote, local cache, or samples ----
  const load = loadDatabase();
  const legacyLocal = Boolean(load.db && !load.syncState && SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey);
  const initialSyncState = legacyLocal
    ? {
        projectUrl: SUPABASE_CONFIG.url,
        stateId: SUPABASE_CONFIG.stateId || "primary",
        pending: true,
        version: null,
        updatedAt: null,
      }
    : load.syncState;
  const cloudBackend = createSupabaseBackend(SUPABASE_CONFIG, { syncState: initialSyncState });
  if (legacyLocal) {
    try {
      overwriteDatabase(load.db, cloudBackend.getSyncState());
    } catch {
      queueMicrotask(() => showToast("Existing browser data could not be marked for cloud migration.", { tone: "danger", duration: 10000 }));
    }
  }
  let cloudLoad = null;
  let cloudLoadError = null;
  if (cloudBackend.isConfigured() && !load.corrupt) {
    try {
      cloudLoad = await cloudBackend.loadDatabase();
    } catch (error) {
      cloudLoadError = error;
    }
  }
  const hasPendingLocal = Boolean(load.db && cloudBackend.getSyncState().pending);

  let initialDb;
  if (cloudLoad && cloudLoad.database && !hasPendingLocal) {
    initialDb = cloudLoad.database;
    try {
      overwriteDatabase(initialDb, cloudBackend.getSyncState());
    } catch {
      queueMicrotask(() => showToast("Cloud data loaded, but this browser could not update its offline cache.", { tone: "danger", duration: 10000 }));
    }
  } else if (load.corrupt) {
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
  const auth = createAdminAuth({ backend: cloudBackend });
  const syncState = cloudBackend.getSyncState();
  let cloudSyncBlocked = load.corrupt;
  let cloudStatus = cloudBackend.isConfigured()
    ? load.corrupt
      ? { state: "cache-error" }
      : cloudLoadError
      ? cloudLoadError instanceof SupabaseConflictError
        ? { state: "conflict", error: cloudLoadError }
        : { state: "error", error: cloudLoadError }
      : hasPendingLocal
        ? {
            state: cloudBackend.isAuthenticated() ? "pending" : "requires-auth",
            version: syncState.version,
            updatedAt: syncState.updatedAt,
          }
      : cloudLoad && cloudLoad.database
        ? { state: "synced", version: cloudLoad.version, updatedAt: cloudLoad.updatedAt }
        : { state: "empty" }
    : { state: "not-configured" };
  const cloudStatusListeners = new Set();

  if (cloudLoadError) {
    const message = cloudLoadError instanceof SupabaseConflictError
      ? cloudLoadError.message
      : "Cloud data is unavailable. Using this browser's offline cache.";
    queueMicrotask(() => showToast(message, { tone: "danger", duration: 10000 }));
  }

  // Default the current session to the most recent, if any.
  const sessions = store.getDb().sessions;
  if (sessions.length) {
    store.setUi({ currentSessionId: sessions[sessions.length - 1].id });
  }
  store.setUi({ calendarWeekStart: startOfWeek(localDateString()) });

  // ---- Persistence ----
  let persister = null;
  const cloudPersister = createCloudPersister(store, cloudBackend, {
    markPending: false,
    canPersist: () => !cloudSyncBlocked,
    onStatus: (status) => {
      cloudStatus = { ...cloudStatus, ...status, error: status.error || null };
      if (status.state === "synced" && persister) persister.writeNow();
      for (const listener of cloudStatusListeners) listener({ ...cloudStatus });
    },
    onError: (error) => {
      const message = error instanceof SupabaseConflictError
        ? error.message
        : error.status === 401
          ? "Your administrator session expired. Sign in again; the browser copy is still safe."
          : "Cloud save failed. The change remains saved in this browser.";
      showToast(message, { tone: "danger", duration: 12000 });
      if (error.status === 401) {
        updateAuthControls();
        refresh();
      }
    },
  });
  persister = createPersister(store, (err) => {
    const quota = err && (err.name === "QuotaExceededError" || /quota/i.test(err.message || ""));
    showToast(
      quota
        ? "Storage is full. Export a JSON backup to avoid losing data."
        : "Could not save to this browser's storage.",
      { tone: "danger", duration: 12000 },
    );
  }, {
    onMutation: () => cloudBackend.markPending(),
    getSyncState: () => cloudBackend.getSyncState(),
  });
  if (cloudPersister.hasPending() && cloudBackend.isAuthenticated() && cloudStatus.state !== "conflict") {
    queueMicrotask(() => void cloudPersister.flush().catch(() => {}));
  }
  window.addEventListener("pagehide", () => {
    persister.flush();
    void cloudPersister.flush();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      persister.flush();
      void cloudPersister.flush();
    }
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
    auth,
    requireAdmin,
    afterAdminSignIn,
    cloud: {
      isConfigured: () => cloudBackend.isConfigured(),
      getStatus: () => ({ ...cloudStatus }),
      subscribe: (listener) => {
        cloudStatusListeners.add(listener);
        return () => cloudStatusListeners.delete(listener);
      },
      syncNow: () => {
        if (cloudSyncBlocked) throw new Error("Import, clear, or reload the unreadable browser data before syncing.");
        return cloudPersister.syncNow();
      },
      reload: reloadCloudData,
      resolveCache: () => { cloudSyncBlocked = false; },
    },
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
    try {
      if (ADMIN_ROUTES.has(route) && !auth.isAuthenticated()) {
        renderAdminLogin(main, ctx, { activity: ADMIN_ROUTES.get(route) });
      } else {
        ROUTES[route](main, ctx);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      main.innerHTML = "";
      showToast("Something went wrong rendering this view.", { tone: "danger" });
    }
    updateAuthControls();
    main.focus({ preventScroll: true });
  }

  function requireAdmin(activity, action) {
    if (auth.isAuthenticated()) {
      action();
      return true;
    }
    showToast(`Sign in from More to access ${activity}.`);
    navigate("more");
    return false;
  }

  async function afterAdminSignIn() {
    if (cloudBackend.isConfigured() && cloudStatus.state !== "conflict" && (cloudStatus.state === "empty" || cloudPersister.hasPending())) {
      try {
        await cloudPersister.syncNow();
      } catch {
        // The persister already surfaced the error and kept the local copy dirty.
      }
    }
  }

  async function reloadCloudData() {
    if (cloudSyncBlocked || cloudBackend.getSyncState().pending) {
      const confirmed = await confirmDialog({
        title: "Use cloud data?",
        message: "This discards unreadable or pending data saved only in this browser and replaces it with the latest cloud database.",
        confirmLabel: "Use cloud data",
        tone: "danger",
      });
      if (!confirmed) return false;
    }

    const latest = await cloudBackend.loadDatabase({ allowConflict: true });
    const result = { ...latest, database: latest.database || createEmptyDatabase() };
    cloudBackend.acceptRemote(result, overwriteDatabase);
    cloudSyncBlocked = false;
    cloudPersister.markClean();
    location.reload();
    return true;
  }

  function updateAuthControls() {
    const authenticated = auth.isAuthenticated();
    const label = authenticated ? "Sign out administrator" : "Administrator sign in";
    adminBtn.title = label;
    adminBtn.setAttribute("aria-label", label);
    adminBtn.setAttribute("aria-pressed", String(authenticated));
    adminBtn.querySelector("[aria-hidden]").textContent = authenticated ? "\uD83D\uDD13" : "\uD83D\uDD12";
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
  }

  window.addEventListener("hashchange", refresh);
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".navbtn");
    if (btn) navigate(btn.dataset.route);
  });

  // ---- Undo/redo ----
  undoBtn.addEventListener("click", () => {
    requireAdmin("undo and redo", () => {
      const label = store.undo();
      if (label) showToast(`Undo: ${label}`, { duration: 4000 });
    });
  });
  redoBtn.addEventListener("click", () => {
    requireAdmin("undo and redo", () => {
      const label = store.redo();
      if (label) showToast(`Redo: ${label}`, { duration: 4000 });
    });
  });

  displayBtn.addEventListener("click", () => requireAdmin("court display controls", () => openDisplayMode(ctx)));
  adminBtn.addEventListener("click", () => {
    if (auth.isAuthenticated()) {
      auth.signOut();
      showToast("Administrator signed out.");
      refresh();
      return;
    }
    if (ADMIN_ROUTES.has(currentRoute())) refresh();
    else navigate("more");
  });

  store.subscribe((_state, meta) => {
    updateAuthControls();
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
      requireAdmin("undo and redo", () => {
        const label = store.undo();
        if (label) showToast(`Undo: ${label}`, { duration: 4000 });
      });
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
      if (isTextEntry(e.target)) return;
      e.preventDefault();
      requireAdmin("undo and redo", () => {
        const label = store.redo();
        if (label) showToast(`Redo: ${label}`, { duration: 4000 });
      });
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

  updateAuthControls();

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

  async function register() {
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
  }

  if (document.readyState === "complete") void register();
  else window.addEventListener("load", register, { once: true });
}

boot();
