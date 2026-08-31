// ui/more.js — settings, data backup (export / import), and info hub.

import { el, mount } from "./dom.js";
import {
  exportDatabase,
  parseImport,
  mergeDatabase,
  mergeSession,
  replaceWith,
} from "../portability.js";
import { createEmptyDatabase, CREDENTIALS_STORAGE_KEY } from "../schema.js";
import { bootstrapSamples } from "../samples.js";
import { createGitHubClient } from "../github.js";

export function renderMore(container, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const s = db.settings;

  mount(
    container,
    el("div", { class: "page-header" }, el("h1", { class: "page-title" }, "More")),

    // ---- Appearance ----
    section(
      "Appearance",
      el(
        "div",
        { class: "field" },
        el("label", {}, "Theme"),
        segmented(
          [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
          s.theme,
          (value) => {
            store.commit("Set theme", (d) => { d.settings.theme = value; });
            ctx.applyTheme(value);
            ctx.refresh();
          },
        ),
      ),
    ),

    // ---- Default scoring ----
    section(
      "Default scoring rules",
      el(
        "div",
        { class: "field" },
        el("label", {}, "Target score"),
        segmented(
          [11, 15, 21].map((n) => ({ value: n, label: String(n) })),
          s.targetScore,
          (value) => { store.commit("Set target score", (d) => { d.settings.targetScore = value; }); ctx.refresh(); },
        ),
      ),
      toggleRow("Win by two", s.winByTwo, (on) => { store.commit("Set win-by-two", (d) => { d.settings.winByTwo = on; }); ctx.refresh(); }),
      hardCapRow(s, store, ctx),
    ),

    // ---- Default scheduling ----
    section(
      "Default scheduling mode",
      el(
        "div",
        { class: "field" },
        el(
          "select",
          {
            class: "select",
            onChange: (e) => { store.commit("Set default mode", (d) => { d.settings.mode = e.target.value; }); ctx.refresh(); },
          },
          ...[
            ["random", "Pure random"],
            ["balanced", "Balanced skill"],
            ["tiered", "King of the court"],
            ["fixed", "Fixed partners"],
          ].map(([v, l]) => el("option", { value: v, selected: s.mode === v }, l)),
        ),
      ),
      el(
        "div",
        { class: "scheduler-tuning" },
        schedulerNumberField("Partner repeat", s.weights.partnerRepeat, 0, 1000, (value) => updateWeight(store, "partnerRepeat", value)),
        schedulerNumberField("Opponent repeat", s.weights.opponentRepeat, 0, 1000, (value) => updateWeight(store, "opponentRepeat", value)),
        schedulerNumberField("Skill balance", s.weights.skillBalance, 0, 1000, (value) => updateWeight(store, "skillBalance", value)),
        schedulerNumberField("Same court", s.weights.courtRepeat, 0, 1000, (value) => updateWeight(store, "courtRepeat", value)),
        schedulerNumberField("Cross-court spread", s.weights.crossCourtSpread, 0, 1000, (value) => updateWeight(store, "crossCourtSpread", value)),
        schedulerNumberField("Search restarts", s.restartCount, 50, 5000, (value) => {
          store.commit("Set scheduler restarts", (d) => { d.settings.restartCount = value; });
        }),
      ),
    ),

    cloudDatabaseSection(ctx),

    // ---- Data backup ----
    section(
      "Data backup",
      el("p", { class: "muted small" }, "Download a portable copy of the complete database for recovery or transfer."),
      el(
        "div",
        { class: "btn-row" },
        el("button", { class: "btn btn--primary", type: "button", onClick: () => doExport(db, ctx) }, "Export all data"),
        el("button", { class: "btn", type: "button", onClick: () => pickImportFile(container, ctx) }, "Import data\u2026"),
      ),
    ),

    githubBackupSection(ctx, db),

    // ---- Danger ----
    section(
      "Reset",
      el("p", { class: "muted small" }, ctx.cloud && ctx.cloud.isConfigured()
        ? "Remove all sessions, players, and bookings from the shared database."
        : "Remove all sessions, players, and bookings from this browser."),
      el(
        "div",
        { class: "btn-row" },
        el("button", { class: "btn btn--danger", type: "button", onClick: () => confirmReset(container, ctx) }, "Clear all data"),
        el("button", { class: "btn btn--ghost", type: "button", onClick: () => restoreSamples(container, ctx) }, "Load sample players"),
      ),
    ),

    el("p", { class: "muted small", style: { marginTop: "16px", textAlign: "center" } }, "Pickleball Session Planner \u00b7 cloud database \u00b7 administrator access enabled"),
  );
}

function cloudDatabaseSection(ctx) {
  if (!ctx.cloud || !ctx.cloud.isConfigured()) {
    return section(
      "Cloud database",
      el("p", { class: "muted small" }, "Cloud storage is not configured for this deployment. Browser storage remains active."),
    );
  }

  const status = el("p", {
    class: "github-sync-status muted small",
    role: "status",
    "aria-live": "polite",
  }, cloudStatusText(ctx.cloud.getStatus()));
  const syncBtn = el("button", { class: "btn btn--primary", type: "button" }, "Sync now");
  const reloadBtn = el("button", { class: "btn", type: "button" }, "Reload cloud data");
  let unsubscribeStatus = null;
  if (typeof ctx.cloud.subscribe === "function") {
    unsubscribeStatus = ctx.cloud.subscribe((next) => {
      if (!status.isConnected) {
        unsubscribeStatus();
        return;
      }
      status.textContent = cloudStatusText(next);
    });
  }

  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    reloadBtn.disabled = true;
    status.textContent = "Saving to the cloud...";
    try {
      await ctx.cloud.syncNow();
      status.textContent = cloudStatusText(ctx.cloud.getStatus());
      ctx.showToast("Cloud database is current.");
    } catch (error) {
      status.textContent = error.message || "Cloud save failed.";
    } finally {
      syncBtn.disabled = false;
      reloadBtn.disabled = false;
    }
  });
  reloadBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    reloadBtn.disabled = true;
    try {
      await ctx.cloud.reload();
    } catch (error) {
      status.textContent = error.message || "Could not reload cloud data.";
    } finally {
      syncBtn.disabled = false;
      reloadBtn.disabled = false;
    }
  });

  return section(
    "Cloud database",
    el("p", { class: "muted small" }, "Supabase is the only application data store. This browser does not retain players, sessions, bookings, or settings."),
    status,
    el("div", { class: "btn-row" }, syncBtn, reloadBtn),
  );
}

function cloudStatusText(status) {
  switch (status.state) {
    case "empty":
      return "Connected. Administrator sign-in is required to initialize the shared database.";
    case "pending":
      return "A cloud save is pending.";
    case "syncing":
      return "Saving to the cloud...";
    case "synced": {
      const when = status.updatedAt ? ` Last saved ${formatSyncTime(status.updatedAt)}.` : "";
      const version = status.version ? ` Version ${status.version}.` : "";
      return `Cloud database is current.${when}${version}`;
    }
    case "requires-auth":
      return "Administrator sign-in is required to save this change.";
    case "error":
      return status.error && status.error.message
        ? `Cloud save needs attention: ${status.error.message}`
        : "Cloud storage is temporarily unavailable. Reload the app to try again.";
    default:
      return "Cloud storage is ready.";
  }
}

function githubBackupSection(ctx, db) {
  let saved = loadGitHubCredentials();
  const ownerInput = el("input", { class: "input", type: "text", value: saved.owner, autocomplete: "off", placeholder: "octocat" });
  const repoInput = el("input", { class: "input", type: "text", value: saved.repo, autocomplete: "off", placeholder: "pickleball-data" });
  const branchInput = el("input", { class: "input", type: "text", value: saved.branch, autocomplete: "off", placeholder: "main" });
  const tokenInput = el("input", {
    class: "input",
    type: "password",
    value: "",
    autocomplete: "new-password",
    placeholder: saved.token ? "Saved on this device" : "Fine-grained personal access token",
    "aria-describedby": "github-token-warning",
  });
  const status = el(
    "p",
    { class: "github-sync-status muted small", role: "status", "aria-live": "polite" },
    saved.lastSyncAt ? `Last backup: ${formatSyncTime(saved.lastSyncAt)}` : saved.token ? "Connection saved. Not backed up yet." : "GitHub backup is off.",
  );
  const saveBtn = el("button", { class: "btn", type: "button" }, "Save connection");
  const testBtn = el("button", { class: "btn", type: "button" }, "Test connection");
  const syncBtn = el("button", { class: "btn btn--primary", type: "button" }, "Sync now");
  const clearBtn = el("button", { class: "btn btn--ghost", type: "button", disabled: !saved.token }, "Clear credentials");
  const actionButtons = [saveBtn, testBtn, syncBtn, clearBtn];

  function readForm() {
    const targetChanged = ownerInput.value.trim() !== saved.owner || repoInput.value.trim() !== saved.repo || (branchInput.value.trim() || "main") !== saved.branch;
    return {
      owner: ownerInput.value.trim(),
      repo: repoInput.value.trim(),
      branch: branchInput.value.trim() || "main",
      token: tokenInput.value.trim() || saved.token,
      hashes: targetChanged ? {} : saved.hashes,
      lastSyncAt: targetChanged ? null : saved.lastSyncAt,
    };
  }

  function setBusy(busy, message) {
    actionButtons.forEach((button) => { button.disabled = busy || (button === clearBtn && !saved.token); });
    if (message) status.textContent = message;
  }

  saveBtn.addEventListener("click", () => {
    try {
      const credentials = readForm();
      validateCredentials(credentials);
      saveGitHubCredentials(credentials);
      saved = credentials;
      tokenInput.value = "";
      tokenInput.placeholder = "Saved on this device";
      clearBtn.disabled = false;
      status.textContent = "Connection saved on this device.";
      ctx.showToast("GitHub connection saved.");
    } catch (error) {
      status.textContent = error.message;
      ctx.showToast(error.message, { tone: "danger", duration: 6000 });
    }
  });

  testBtn.addEventListener("click", async () => {
    try {
      const credentials = readForm();
      validateCredentials(credentials);
      setBusy(true, "Testing connection\u2026");
      const repository = await createGitHubClient(credentials).testConnection();
      saveGitHubCredentials(credentials);
      saved = credentials;
      tokenInput.value = "";
      tokenInput.placeholder = "Saved on this device";
      status.textContent = repository.private
        ? `Connected to ${repository.fullName}.`
        : `Connected to public repository ${repository.fullName}. Backed-up data will be public.`;
    } catch (error) {
      status.textContent = error.message;
      ctx.showToast(error.message, { tone: "danger", duration: 8000 });
    } finally {
      setBusy(false);
    }
  });

  syncBtn.addEventListener("click", async () => {
    let credentials;
    try {
      credentials = readForm();
      validateCredentials(credentials);
      setBusy(true, "Preparing backup\u2026");
      const client = createGitHubClient(credentials);
      const result = await client.syncDatabase(db, {
        previousHashes: credentials.hashes,
        onProgress: ({ type, path, result: progress }) => {
          status.textContent = type === "written"
            ? `Backed up ${path} (${progress.written.length} written)\u2026`
            : `Unchanged: ${path}\u2026`;
        },
      });
      saved = { ...credentials, hashes: result.hashes, lastSyncAt: result.lastSyncAt };
      saveGitHubCredentials(saved);
      tokenInput.value = "";
      tokenInput.placeholder = "Saved on this device";
      status.textContent = result.written.length
        ? `Backup complete: ${result.written.length} written, ${result.skipped.length} unchanged.`
        : `Backup already current: ${result.skipped.length} file(s) unchanged.`;
      ctx.showToast("GitHub backup complete.");
    } catch (error) {
      if (credentials && error.syncResult) {
        saved = { ...credentials, hashes: error.syncResult.hashes };
        saveGitHubCredentials(saved);
        status.textContent = `Backup stopped after ${error.syncResult.written.length} file(s). ${error.message}`;
      } else {
        status.textContent = error.message;
      }
      ctx.showToast(error.message, { tone: "danger", duration: 10000 });
    } finally {
      setBusy(false);
    }
  });

  clearBtn.addEventListener("click", async () => {
    const confirmed = await ctx.confirmDialog({
      title: "Clear GitHub credentials?",
      message: "This removes the saved repository settings, token, and sync history from this browser. It does not delete any GitHub files.",
      confirmLabel: "Clear credentials",
    });
    if (!confirmed) return;
    localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
    ctx.showToast("GitHub credentials cleared.");
    ctx.refresh();
  });

  return section(
    "GitHub backup (optional)",
    el(
      "div",
      { class: "warnbox", id: "github-token-warning" },
      "The token is stored only in this browser, but anyone with access to this device can use it. Create a fine-grained token for one repository with Contents: write, choose a short expiry, and prefer a separate private data repository. Data committed to a public repository is public.",
    ),
    el(
      "div",
      { class: "github-fields" },
      field("Owner", ownerInput),
      field("Repository", repoInput),
      field("Branch", branchInput),
      field("Personal access token", tokenInput),
    ),
    status,
    el("div", { class: "btn-row" }, saveBtn, testBtn, syncBtn, clearBtn),
  );
}

function field(label, control) {
  return el("label", { class: "field" }, el("span", {}, label), control);
}

function loadGitHubCredentials() {
  const empty = { owner: "", repo: "", branch: "main", token: "", hashes: {}, lastSyncAt: null };
  try {
    const parsed = JSON.parse(localStorage.getItem(CREDENTIALS_STORAGE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return empty;
    return {
      owner: String(parsed.owner || ""),
      repo: String(parsed.repo || ""),
      branch: String(parsed.branch || "main"),
      token: String(parsed.token || ""),
      hashes: parsed.hashes && typeof parsed.hashes === "object" ? parsed.hashes : {},
      lastSyncAt: parsed.lastSyncAt || null,
    };
  } catch {
    return empty;
  }
}

function saveGitHubCredentials(credentials) {
  localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(credentials));
}

function validateCredentials(credentials) {
  if (!credentials.owner) throw new Error("Enter the GitHub repository owner.");
  if (!credentials.repo) throw new Error("Enter the GitHub repository name.");
  if (!credentials.token) throw new Error("Enter a fine-grained personal access token.");
}

function formatSyncTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

// ---------------------------------------------------------------------------
// Sections & controls
// ---------------------------------------------------------------------------

function section(title, ...children) {
  return el("section", { class: "settings-section" }, el("h2", { class: "settings-section__title" }, title), ...children);
}

function segmented(options, current, onSelect) {
  return el(
    "div",
    { class: "segmented", role: "group" },
    ...options.map((opt) =>
      el(
        "button",
        {
          type: "button",
          class: `segmented__btn${opt.value === current ? " segmented__btn--on" : ""}`,
          "aria-pressed": String(opt.value === current),
          onClick: () => onSelect(opt.value),
        },
        opt.label,
      ),
    ),
  );
}

function toggleRow(label, on, onToggle) {
  return el(
    "label",
    { class: "toggle-row" },
    el("span", {}, label),
    el("input", { type: "checkbox", checked: on, onChange: (e) => onToggle(e.target.checked) }),
  );
}

function hardCapRow(s, store, ctx) {
  const enabled = s.hardCap != null;
  const children = [
    el(
      "label",
      { class: "toggle-row" },
      el("span", {}, "Hard cap"),
      el("input", {
        type: "checkbox",
        checked: enabled,
        onChange: (e) => {
          const on = e.target.checked;
          store.commit("Toggle hard cap", (d) => { d.settings.hardCap = on ? d.settings.targetScore + 4 : null; });
          ctx.refresh();
        },
      }),
    ),
  ];
  if (enabled) {
    children.push(
      el(
        "div",
        { class: "field-row" },
        el("label", { class: "muted small" }, "Cap at"),
        el("input", {
          type: "number",
          class: "input input--num",
          min: "1",
          value: String(s.hardCap),
          onChange: (e) => {
            const v = Math.max(1, Math.round(Number(e.target.value) || 0));
            store.commit("Set hard cap", (d) => { d.settings.hardCap = v; });
            ctx.refresh();
          },
        }),
      ),
    );
  }
  return el("div", {}, ...children);
}

function schedulerNumberField(label, value, min, max, onChange) {
  return el(
    "label",
    { class: "field" },
    el("span", {}, label),
    el("input", {
      class: "input",
      type: "number",
      min: String(min),
      max: String(max),
      step: "1",
      value: String(value),
      onChange: (event) => {
        const next = Math.min(max, Math.max(min, Math.round(Number(event.target.value) || min)));
        event.target.value = String(next);
        onChange(next);
      },
    }),
  );
}

function updateWeight(store, key, value) {
  store.commit(`Set ${key} weight`, (draft) => { draft.settings.weights[key] = value; });
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

function doExport(db, ctx) {
  const json = exportDatabase(db);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`pickleball-backup-${stamp}.json`, json, "application/json");
  ctx.showToast("Backup downloaded.");
}

function pickImportFile(container, ctx) {
  const input = el("input", { type: "file", accept: "application/json,.json", style: { display: "none" } });
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => previewImport(container, ctx, String(reader.result || ""));
    reader.onerror = () => ctx.showToast("Could not read that file.", { tone: "danger" });
    reader.readAsText(file);
  });
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 0);
}

function previewImport(container, ctx, text) {
  const result = parseImport(text);
  if (!result.ok) {
    ctx.showToast(result.error, { tone: "danger", duration: 6000 });
    return;
  }

  if (result.kind === "database") {
    const db = result.database;
    const summary = `${db.players.length} player(s), ${db.sessions.length} session(s), ${db.bookings.length} booking(s)`;
    const replaceBtn = el("button", { class: "btn btn--danger", type: "button" }, "Replace everything");
    const mergeBtn = el("button", { class: "btn btn--primary", type: "button" }, "Merge into current");
    const dialog = ctx.openDialog({
      title: "Import backup",
      body: el(
        "div",
        { class: "stack" },
        el("p", {}, `This backup contains ${summary}.`),
        el("p", { class: "muted small" }, "Merge keeps your current data and adds anything new. Replace discards your current data."),
      ),
      actions: [mergeBtn, replaceBtn],
    });
    mergeBtn.addEventListener("click", () => {
      dialog.close();
      if (ctx.cloud && ctx.cloud.resolveCache) ctx.cloud.resolveCache();
      ctx.store.replaceDatabase("Merge import", mergeDatabase(ctx.store.getDb(), db));
      ctx.showToast("Backup merged.", { actionLabel: "Undo", onAction: () => { ctx.store.undo(); ctx.refresh(); } });
      ctx.refresh();
    });
    replaceBtn.addEventListener("click", () => {
      dialog.close();
      if (ctx.cloud && ctx.cloud.resolveCache) ctx.cloud.resolveCache();
      ctx.store.replaceDatabase("Replace with import", replaceWith(db));
      ctx.showToast("Data replaced.", { actionLabel: "Undo", onAction: () => { ctx.store.undo(); ctx.refresh(); } });
      ctx.refresh();
    });
    return;
  }

  // Single session
  const importBtn = el("button", { class: "btn btn--primary", type: "button" }, "Add session");
  const dialog = ctx.openDialog({
    title: "Import session",
    body: el(
      "div",
      { class: "stack" },
      el("p", {}, `Session "${result.session.name || result.session.date}" with ${result.session.rounds.length} round(s).`),
      el("p", { class: "muted small" }, "The session and its players will be added to your current data."),
    ),
    actions: [importBtn],
  });
  importBtn.addEventListener("click", () => {
    dialog.close();
    if (ctx.cloud && ctx.cloud.resolveCache) ctx.cloud.resolveCache();
    ctx.store.replaceDatabase("Import session", mergeSession(ctx.store.getDb(), result.session, result.players));
    ctx.showToast("Session imported.", { actionLabel: "Undo", onAction: () => { ctx.store.undo(); ctx.refresh(); } });
    ctx.refresh();
  });
}

async function confirmReset(container, ctx) {
  const cloudBacked = ctx.cloud && ctx.cloud.isConfigured();
  const ok = await ctx.confirmDialog({
    title: "Clear all data?",
    message: cloudBacked
      ? "This removes every player, session, and booking from the shared database."
      : "This removes every player, session, and booking from this browser.",
    confirmLabel: "Clear everything",
    tone: "danger",
  });
  if (!ok) return;
  if (ctx.cloud && ctx.cloud.resolveCache) ctx.cloud.resolveCache();
  ctx.store.replaceDatabase("Clear all data", createEmptyDatabase());
  ctx.store.setUi({ currentSessionId: null });
  ctx.showToast("All data cleared.", { actionLabel: "Undo", onAction: () => { ctx.store.undo(); ctx.refresh(); } });
  ctx.refresh();
}

function restoreSamples(container, ctx) {
  const db = ctx.store.getDb();
  if (db.players.length) {
    ctx.showToast("Clear existing players first to load samples.", { tone: "danger", duration: 5000 });
    return;
  }
  bootstrapSamples().then((next) => {
    if (ctx.cloud && ctx.cloud.resolveCache) ctx.cloud.resolveCache();
    ctx.store.replaceDatabase("Load samples", next);
    ctx.showToast("Sample players loaded.");
    ctx.refresh();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
