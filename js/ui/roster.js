// ui/roster.js — player management.

import { el, mount, avatar } from "./dom.js";
import { showToast, confirmDialog, openDialog } from "./feedback.js";
import { createPlayer, normalizeRating, RATING_MIN, RATING_MAX } from "../schema.js";

export function renderRoster(container, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const state = getViewState(container);

  const players = db.players
    .filter((p) => matchesFilter(p, state))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sampleCount = db.players.filter((p) => p.isSample).length;
  const activeCount = db.players.filter((p) => p.active).length;

  mount(
    container,
    el(
      "div",
      { class: "page-header" },
      el(
        "div",
        {},
        el("h1", { class: "page-title" }, "Players"),
        el("p", { class: "muted small" }, `${db.players.length} players \u00b7 ${activeCount} active`),
      ),
      el("button", { class: "btn btn--primary", type: "button", onClick: () => openPlayerForm(ctx) }, "+ Add player"),
    ),

    el(
      "div",
      { class: "row", style: { marginBottom: "12px" } },
      el("input", {
        type: "search",
        class: "grow",
        placeholder: "Search players\u2026",
        value: state.query,
        "aria-label": "Search players",
        onInput: (e) => {
          state.query = e.target.value;
          rerender();
        },
      }),
      el(
        "button",
        {
          class: `chip ${state.activeOnly ? "chip--on" : ""}`,
          type: "button",
          "aria-pressed": String(state.activeOnly),
          onClick: () => {
            state.activeOnly = !state.activeOnly;
            rerender();
          },
        },
        "Active only",
      ),
    ),

    sampleCount
      ? el(
          "div",
          { class: "infobox row spread", style: { marginBottom: "12px" } },
          el("span", {}, `${sampleCount} sample players are loaded so you can explore.`),
          el(
            "button",
            { class: "btn btn--sm btn--ghost", type: "button", onClick: () => clearSamples(ctx) },
            "Clear samples",
          ),
        )
      : null,

    players.length
      ? el("div", { class: "list" }, ...players.map((p) => playerRow(p, ctx)))
      : el("p", { class: "empty" }, db.players.length ? "No players match your search." : "No players yet. Add your first player."),
  );

  function rerender() {
    renderRoster(container, ctx);
  }
}

function playerRow(player, ctx) {
  const { store } = ctx;
  return el(
    "div",
    { class: `player-row ${player.active ? "" : "player-row--inactive"}` },
    avatar(player, { size: "md" }),
    el(
      "div",
      { class: "player-row__info" },
      el(
        "div",
        { class: "row", style: { gap: "6px" } },
        el("span", { class: "player-row__name" }, player.name),
        player.rating != null ? el("span", { class: "tag tag--rating" }, player.rating.toFixed(1)) : null,
        player.isSample ? el("span", { class: "tag tag--sample" }, "Sample") : null,
      ),
      player.notes ? el("div", { class: "muted small", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, player.notes) : null,
    ),
    el(
      "button",
      {
        class: `chip ${player.active ? "chip--on" : ""}`,
        type: "button",
        "aria-pressed": String(player.active),
        title: player.active ? "Active — tap to bench" : "Inactive — tap to activate",
        onClick: () => {
          const changeStatus = () => {
            store.commit(player.active ? `Bench ${player.name}` : `Activate ${player.name}`, (draft) => {
              const p = draft.players.find((x) => x.id === player.id);
              if (p) p.active = !p.active;
            });
          };
          if (ctx.cloud.isConfigured()) ctx.requireAdmin("player management", changeStatus);
          else changeStatus();
        },
      },
      player.active ? "Active" : "Inactive",
    ),
    el(
      "button",
      { class: "iconbtn", type: "button", "aria-label": `Edit ${player.name}`, style: { color: "var(--text-muted)" }, onClick: () => openPlayerForm(ctx, player) },
      el("span", { "aria-hidden": "true" }, "\u270e"),
    ),
  );
}

/**
 * Open the add/edit player form. When `player` is provided it's an edit.
 * Returns a promise resolving to the created/edited player id (or null).
 */
export function openPlayerForm(ctx, player = null) {
  if (ctx.cloud.isConfigured() && !ctx.auth.isAuthenticated()) {
    ctx.requireAdmin("player management", () => openPlayerForm(ctx, player));
    return Promise.resolve(null);
  }

  const { store } = ctx;
  const isEdit = Boolean(player);

  const nameInput = el("input", { type: "text", id: "pf-name", value: player ? player.name : "", placeholder: "Player name", required: true, autocomplete: "off" });
  const ratingInput = el("input", { type: "number", id: "pf-rating", min: String(RATING_MIN), max: String(RATING_MAX), step: "0.5", value: player && player.rating != null ? String(player.rating) : "", placeholder: "e.g. 3.5" });
  const notesInput = el("textarea", { id: "pf-notes", placeholder: "Optional notes" }, player ? player.notes : "");
  const activeInput = el("input", { type: "checkbox", id: "pf-active", checked: player ? player.active : true });
  const errorBox = el("div", { class: "warnbox hidden" });

  return new Promise((resolve) => {
    let createdId = null;
    const controller = openDialog({
      title: isEdit ? "Edit player" : "Add player",
      body: el(
        "form",
        {
          id: "playerForm",
          onSubmit: (e) => {
            e.preventDefault();
            save();
          },
        },
        el("div", { class: "field" }, el("label", { for: "pf-name" }, "Name"), nameInput),
        el(
          "div",
          { class: "field" },
          el("label", { for: "pf-rating" }, `Rating (${RATING_MIN}\u2013${RATING_MAX}, optional)`),
          ratingInput,
        ),
        el("div", { class: "field" }, el("label", { for: "pf-notes" }, "Notes"), notesInput),
        el("label", { class: "checkbox" }, activeInput, "Active"),
        errorBox,
      ),
      actions: [
        isEdit && !player.isSample
          ? el("button", { class: "btn btn--danger", type: "button", style: { marginRight: "auto" }, onClick: () => remove() }, "Delete")
          : null,
        el("button", { class: "btn btn--ghost", type: "button", onClick: () => close(null) }, "Cancel"),
        el("button", { class: "btn btn--primary", type: "submit", form: "playerForm" }, isEdit ? "Save" : "Add"),
      ].filter(Boolean),
      onClose: () => resolve(createdId),
    });

    function showError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.remove("hidden");
    }

    function save() {
      const name = nameInput.value.trim();
      if (!name) return showError("Please enter a name.");
      const ratingRaw = ratingInput.value.trim();
      if (ratingRaw && (Number(ratingRaw) < RATING_MIN || Number(ratingRaw) > RATING_MAX)) {
        return showError(`Rating must be between ${RATING_MIN} and ${RATING_MAX}.`);
      }
      const rating = normalizeRating(ratingRaw);
      const active = activeInput.checked;
      const notes = notesInput.value;

      if (isEdit) {
        store.commit(`Edit ${name}`, (draft) => {
          const p = draft.players.find((x) => x.id === player.id);
          if (p) {
            p.name = name;
            p.rating = rating;
            p.active = active;
            p.notes = notes;
          }
        });
        createdId = player.id;
      } else {
        const newPlayer = createPlayer({ name, rating, notes, active });
        createdId = newPlayer.id;
        store.commit(`Add ${name}`, (draft) => {
          draft.players.push(newPlayer);
        });
      }
      close(createdId);
    }

    function remove() {
      confirmDialog({
        title: "Delete player?",
        message: `Delete ${player.name}? If they appear in past rounds they'll be archived instead to keep history intact.`,
        confirmLabel: "Delete",
      }).then((ok) => {
        if (!ok) return;
        const referenced = isPlayerReferenced(store.getDb(), player.id);
        const snapshotName = player.name;
        store.commit(referenced ? `Archive ${snapshotName}` : `Delete ${snapshotName}`, (draft) => {
          if (referenced) {
            const p = draft.players.find((x) => x.id === player.id);
            if (p) p.active = false;
          } else {
            draft.players = draft.players.filter((x) => x.id !== player.id);
            draft.constraints.mustPair = draft.constraints.mustPair.filter((pr) => !pr.includes(player.id));
            draft.constraints.mustNotPair = draft.constraints.mustNotPair.filter((pr) => !pr.includes(player.id));
          }
        });
        showToast(referenced ? `${snapshotName} archived (kept in history).` : `${snapshotName} deleted.`, {
          actionLabel: "Undo",
          onAction: () => store.undo(),
        });
        close(null);
      });
    }

    function close(id) {
      createdId = id;
      controller.close();
    }
  });
}

function clearSamples(ctx) {
  if (ctx.cloud.isConfigured() && !ctx.auth.isAuthenticated()) {
    ctx.requireAdmin("player management", () => clearSamples(ctx));
    return;
  }

  const { store } = ctx;
  confirmDialog({
    title: "Clear sample players?",
    message: "Remove all sample players? Any real players you've added will be kept.",
    confirmLabel: "Clear samples",
  }).then((ok) => {
    if (!ok) return;
    store.commit("Clear sample players", (draft) => {
      const removedIds = new Set(draft.players.filter((p) => p.isSample).map((p) => p.id));
      draft.players = draft.players.filter((p) => !p.isSample);
      draft.constraints.mustPair = draft.constraints.mustPair.filter((pr) => !pr.some((id) => removedIds.has(id)));
      draft.constraints.mustNotPair = draft.constraints.mustNotPair.filter((pr) => !pr.some((id) => removedIds.has(id)));
    });
    showToast("Sample players cleared.", { actionLabel: "Undo", onAction: () => store.undo() });
  });
}

function isPlayerReferenced(db, playerId) {
  return db.sessions.some((s) =>
    s.playerIds.includes(playerId) ||
    s.rounds.some(
      (r) => r.sitOutIds.includes(playerId) || r.courts.some((c) => c.teamA.includes(playerId) || c.teamB.includes(playerId)),
    ),
  );
}

function matchesFilter(player, state) {
  if (state.activeOnly && !player.active) return false;
  if (state.query) {
    return player.name.toLowerCase().includes(state.query.toLowerCase());
  }
  return true;
}

// Per-container view state (search/filter) preserved across re-renders.
const viewStates = new WeakMap();
function getViewState(container) {
  if (!viewStates.has(container)) {
    viewStates.set(container, { query: "", activeOnly: false });
  }
  return viewStates.get(container);
}
