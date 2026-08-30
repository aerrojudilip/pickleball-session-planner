// ui/constraints.js — editor for fixed (mustPair) and split (mustNotPair) pairs.

import { el } from "./dom.js";
import { openDialog, showToast } from "./feedback.js";

/**
 * Open the pair-constraint editor dialog.
 * Commits changes to the store's constraints.
 */
export function openConstraintsEditor(ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const players = db.players.filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name));
  const nameById = new Map(db.players.map((p) => [p.id, p.name]));

  const body = el("div", { class: "stack" });
  const list = el("div", { class: "stack" });

  function renderList() {
    list.innerHTML = "";
    const mustPair = store.getDb().constraints.mustPair;
    const mustNotPair = store.getDb().constraints.mustNotPair;
    list.appendChild(
      el(
        "div",
        { class: "section" },
        el("h2", {}, "Fixed partners (must pair)"),
        mustPair.length
          ? el("div", { class: "list" }, ...mustPair.map((pair, i) => pairRow(pair, "mustPair", i)))
          : el("p", { class: "muted small" }, "None yet."),
      ),
    );
    list.appendChild(
      el(
        "div",
        { class: "section" },
        el("h2", {}, "Keep apart (must not pair)"),
        mustNotPair.length
          ? el("div", { class: "list" }, ...mustNotPair.map((pair, i) => pairRow(pair, "mustNotPair", i)))
          : el("p", { class: "muted small" }, "None yet."),
      ),
    );
  }

  function pairRow(pair, kind, index) {
    return el(
      "div",
      { class: "player-row" },
      el("span", { class: "grow" }, `${nameById.get(pair[0]) || "?"} + ${nameById.get(pair[1]) || "?"}`),
      el(
        "button",
        {
          class: "btn btn--sm btn--ghost",
          type: "button",
          onClick: () => {
            store.commit("Remove constraint", (draft) => {
              draft.constraints[kind].splice(index, 1);
            });
            renderList();
          },
        },
        "Remove",
      ),
    );
  }

  const selA = el("select", { "aria-label": "First player" }, el("option", { value: "" }, "Select\u2026"), ...players.map((p) => el("option", { value: p.id }, p.name)));
  const selB = el("select", { "aria-label": "Second player" }, el("option", { value: "" }, "Select\u2026"), ...players.map((p) => el("option", { value: p.id }, p.name)));
  const kindSel = el("select", { "aria-label": "Constraint type" }, el("option", { value: "mustPair" }, "Must pair"), el("option", { value: "mustNotPair" }, "Must not pair"));

  function addPair() {
    const a = selA.value;
    const b = selB.value;
    const kind = kindSel.value;
    if (!a || !b || a === b) {
      showToast("Pick two different players.", { tone: "danger", duration: 4000 });
      return;
    }
    const current = store.getDb().constraints;
    const key = [a, b].sort().join("|");
    const exists = current[kind].some((pr) => pr.slice().sort().join("|") === key);
    if (exists) {
      showToast("That pair already exists.", { duration: 4000 });
      return;
    }
    if (kind === "mustPair") {
      const inOther = current.mustPair.some((pr) => pr.includes(a) || pr.includes(b));
      if (inOther) {
        showToast("A player can only have one fixed partner.", { tone: "danger", duration: 5000 });
        return;
      }
      const conflict = current.mustNotPair.some((pr) => pr.slice().sort().join("|") === key);
      if (conflict) {
        showToast("That pair is also in 'must not pair'.", { tone: "danger", duration: 5000 });
        return;
      }
    }
    store.commit("Add constraint", (draft) => {
      draft.constraints[kind].push([a, b]);
    });
    selA.value = "";
    selB.value = "";
    renderList();
  }

  body.appendChild(
    el(
      "div",
      { class: "card card--flat" },
      el("div", { class: "field-row" }, el("div", { class: "field grow" }, kindSel), el("div", { class: "field grow" }, selA), el("div", { class: "field grow" }, selB)),
      el("button", { class: "btn btn--primary", type: "button", onClick: addPair }, "Add pair"),
    ),
  );
  body.appendChild(list);
  renderList();

  openDialog({
    title: "Pair constraints",
    body,
    size: "lg",
    actions: [el("button", { class: "btn btn--primary", type: "button", onClick: () => ctx.refresh() }, "Done")],
  });
}
