// ui/session.js — session setup, round generation, live play, and scoring.

import { el, mount, avatar } from "./dom.js";
import { showToast, confirmDialog, openDialog } from "./feedback.js";
import { openPlayerForm } from "./roster.js";
import { openConstraintsEditor } from "./constraints.js";
import { createSession, localDateString, MODES, clamp } from "../schema.js";
import { generateRounds, generateRound, analyzeRoundFairness, validateConstraints } from "../scheduler.js";
import { deriveRoundSeed, randomSeed } from "../rng.js";
import { validateScore, effectiveRules } from "../scoring.js";

const MODE_LABELS = {
  random: "Pure random",
  balanced: "Balanced skill",
  tiered: "King of the court",
  fixed: "Fixed partners",
};

const drafts = new WeakMap();

function getDraft(container) {
  if (!drafts.has(container)) drafts.set(container, { mode: "start", config: null, pendingBookingId: null, viewIndex: null, selectedSlot: null });
  return drafts.get(container);
}

export function renderSession(container, ctx) {
  const { store } = ctx;
  const ui = store.getUi();
  const db = store.getDb();
  const session = db.sessions.find((s) => s.id === ui.currentSessionId);
  const draft = getDraft(container);

  if (draft.mode === "setup") return renderSetup(container, ctx);
  if (session) return renderPlay(container, ctx, session);
  return renderStart(container, ctx);
}

// ---------------------------------------------------------------------------
// Start screen: recent sessions + new
// ---------------------------------------------------------------------------
function renderStart(container, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const sessions = db.sessions.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  mount(
    container,
    el(
      "div",
      { class: "page-header" },
      el("div", {}, el("h1", { class: "page-title" }, "Play")),
      el("button", { class: "btn btn--primary", type: "button", onClick: () => startSetup(container, ctx) }, "+ New session"),
    ),
    sessions.length
      ? el(
          "div",
          { class: "list" },
          ...sessions.map((s) =>
            el(
              "button",
              {
                class: "player-row",
                type: "button",
                style: { textAlign: "left", cursor: "pointer", width: "100%" },
                onClick: () => openExisting(container, ctx, s.id),
              },
              el(
                "div",
                { class: "player-row__info" },
                el("div", { class: "player-row__name" }, s.name || s.date),
                el("div", { class: "muted small" }, `${s.date} \u00b7 ${s.rounds.length} round(s) \u00b7 ${MODE_LABELS[s.mode] || s.mode}`),
              ),
              el("span", { class: "badge badge--completed" }, `${s.playerIds.length}p`),
            ),
          ),
        )
      : el("p", { class: "empty" }, "No sessions yet. Start a new one to generate fair rotations."),
  );
}

function openExisting(container, ctx, sessionId) {
  const draft = getDraft(container);
  draft.mode = "play";
  draft.viewIndex = null;
  ctx.store.setUi({ currentSessionId: sessionId });
  ctx.refresh();
}

function startSetup(container, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const activePlayerIds = db.players.filter((p) => p.active).map((p) => p.id);
  const draft = getDraft(container);
  draft.mode = "setup";
  const lastCourts = db.sessions.length ? db.sessions[db.sessions.length - 1].courtCount : 3;
  draft.config = {
    date: localDateString(),
    name: "",
    location: "",
    courtCount: clamp(lastCourts, 1, 12),
    selectedIds: new Set(activePlayerIds),
    mode: db.settings.mode,
    seed: randomSeed(),
    roundCount: 1,
    bookingId: null,
  };
  ctx.refresh();
}

// Public: prefill setup from a booking (used by the schedule tab).
export function startSetupFromBooking(container, ctx, booking) {
  const { store } = ctx;
  const db = store.getDb();
  const activePlayerIds = db.players.filter((p) => p.active).map((p) => p.id);
  const draft = getDraft(container);
  draft.mode = "setup";
  draft.config = {
    date: booking.date,
    name: booking.name || "",
    location: booking.location || "",
    courtCount: clamp(booking.courtCount, 1, 12),
    selectedIds: new Set(activePlayerIds),
    mode: db.settings.mode,
    seed: randomSeed(),
    roundCount: 1,
    bookingId: booking.id,
  };
  store.setUi({ currentSessionId: null });
  ctx.navigate ? ctx.navigate("session") : ctx.refresh();
}

// ---------------------------------------------------------------------------
// Setup form
// ---------------------------------------------------------------------------
function renderSetup(container, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const draft = getDraft(container);
  const cfg = draft.config;
  const roster = db.players.slice().sort((a, b) => a.name.localeCompare(b.name));

  const activeSelected = roster.filter((p) => p.active && cfg.selectedIds.has(p.id));
  const summary = computeSummary(activeSelected.length, cfg.courtCount);

  mount(
    container,
    el(
      "div",
      { class: "page-header" },
      el("div", {}, el("h1", { class: "page-title" }, "New session")),
      el("button", { class: "btn btn--ghost", type: "button", onClick: () => cancelSetup(container, ctx) }, "Cancel"),
    ),

    el(
      "div",
      { class: "card stack" },
      el(
        "div",
        { class: "field-row" },
        field("Date", el("input", { type: "date", value: cfg.date, onChange: (e) => (cfg.date = e.target.value) })),
        field("Courts", courtStepper(cfg, ctx, container)),
      ),
      el(
        "div",
        { class: "field-row" },
        field("Session name", el("input", { type: "text", value: cfg.name, placeholder: "e.g. Saturday Open Play", onInput: (e) => (cfg.name = e.target.value) })),
        field("Location", el("input", { type: "text", value: cfg.location, placeholder: "e.g. Community Courts", onInput: (e) => (cfg.location = e.target.value) })),
      ),
      field("Scheduling mode", modeSelect(cfg)),
    ),

    el(
      "div",
      { class: "section", style: { marginTop: "16px" } },
      el(
        "div",
        { class: "row spread" },
        el("h2", {}, `Players (${activeSelected.length} selected)`),
        el(
          "div",
          { class: "row" },
          el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => toggleAll(cfg, roster, true, container, ctx) }, "All"),
          el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => toggleAll(cfg, roster, false, container, ctx) }, "None"),
          el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => addInline(container, ctx) }, "+ New"),
        ),
      ),
      el(
        "div",
        { class: "chips", style: { marginTop: "8px" } },
        ...roster.map((p) =>
          el(
            "button",
            {
              class: `chip ${cfg.selectedIds.has(p.id) ? "chip--on" : ""} ${p.active ? "" : "chip--muted"}`,
              type: "button",
              "aria-pressed": String(cfg.selectedIds.has(p.id)),
              disabled: !p.active,
              title: p.active ? "" : "Inactive players can't be selected",
              onClick: () => {
                if (cfg.selectedIds.has(p.id)) cfg.selectedIds.delete(p.id);
                else cfg.selectedIds.add(p.id);
                renderSetup(container, ctx);
              },
            },
            p.name,
            p.rating != null ? el("span", { class: "tag tag--rating" }, p.rating.toFixed(1)) : null,
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "card summary", style: { marginTop: "8px" } },
      summaryItem(activeSelected.length, "Players"),
      summaryItem(summary.courtsUsed, "Courts used"),
      summaryItem(summary.playing, "Playing"),
      summaryItem(summary.sitting, "Sitting / round"),
    ),

    el(
      "div",
      { class: "row", style: { marginTop: "16px" } },
      el("button", { class: "btn btn--ghost", type: "button", onClick: () => openConstraintsEditor(ctx) }, "Pair constraints"),
      el("button", { class: "btn btn--ghost", type: "button", onClick: () => editSeed(cfg, container, ctx) }, `Seed: ${cfg.seed}`),
    ),

    el(
      "div",
      { class: "card stack", style: { marginTop: "16px" } },
      cfg.mode === "tiered"
        ? el("p", { class: "infobox" }, "King of the court generates one round at a time \u2014 the next round depends on the results.")
        : field("Rounds to generate", roundCountStepper(cfg)),
      summary.courtsUsed < 1 ? el("p", { class: "warnbox" }, "Select at least 4 active players to generate a round.") : null,
      el(
        "button",
        {
          class: "btn btn--primary btn--block",
          type: "button",
          disabled: summary.courtsUsed < 1,
          onClick: () => doGenerate(container, ctx),
        },
        cfg.mode === "tiered" ? "Start & generate round 1" : `Generate ${cfg.roundCount} round(s)`,
      ),
    ),
  );
}

function field(label, control) {
  return el("div", { class: "field" }, el("label", {}, label), control);
}

function courtStepper(cfg, ctx, container) {
  const out = el("output", {}, String(cfg.courtCount));
  return el(
    "div",
    { class: "stepper" },
    el("button", { type: "button", "aria-label": "Fewer courts", onClick: () => { cfg.courtCount = clamp(cfg.courtCount - 1, 1, 12); out.textContent = cfg.courtCount; renderSetup(container, ctx); } }, "\u2212"),
    out,
    el("button", { type: "button", "aria-label": "More courts", onClick: () => { cfg.courtCount = clamp(cfg.courtCount + 1, 1, 12); out.textContent = cfg.courtCount; renderSetup(container, ctx); } }, "+"),
  );
}

function roundCountStepper(cfg) {
  const out = el("output", {}, String(cfg.roundCount));
  return el(
    "div",
    { class: "stepper" },
    el("button", { type: "button", "aria-label": "Fewer rounds", onClick: () => { cfg.roundCount = clamp(cfg.roundCount - 1, 1, 20); out.textContent = cfg.roundCount; } }, "\u2212"),
    out,
    el("button", { type: "button", "aria-label": "More rounds", onClick: () => { cfg.roundCount = clamp(cfg.roundCount + 1, 1, 20); out.textContent = cfg.roundCount; } }, "+"),
  );
}

function modeSelect(cfg) {
  return el(
    "select",
    { onChange: (e) => (cfg.mode = e.target.value) },
    ...MODES.map((m) => el("option", { value: m, selected: cfg.mode === m }, MODE_LABELS[m])),
  );
}

function editSeed(cfg, container, ctx) {
  const input = el("input", { type: "number", value: String(cfg.seed) });
  const controller = openDialog({
    title: "Random seed",
    body: el("div", { class: "stack" }, el("p", { class: "muted small" }, "A fixed seed reproduces the same schedule."), input),
    actions: [
      el("button", { class: "btn btn--ghost", type: "button", onClick: () => { cfg.seed = randomSeed(); controller.close(); renderSetup(container, ctx); } }, "Randomize"),
      el("button", { class: "btn btn--primary", type: "button", onClick: () => { cfg.seed = Number(input.value) >>> 0; controller.close(); renderSetup(container, ctx); } }, "Set"),
    ],
  });
}

function toggleAll(cfg, roster, on, container, ctx) {
  for (const p of roster) {
    if (!p.active) continue;
    if (on) cfg.selectedIds.add(p.id);
    else cfg.selectedIds.delete(p.id);
  }
  renderSetup(container, ctx);
}

function addInline(container, ctx) {
  openPlayerForm(ctx).then((newId) => {
    if (newId) {
      const draft = getDraft(container);
      draft.config.selectedIds.add(newId);
      renderSetup(container, ctx);
    }
  });
}

function cancelSetup(container, ctx) {
  const draft = getDraft(container);
  draft.mode = "start";
  draft.config = null;
  ctx.refresh();
}

function computeSummary(activeCount, courtCount) {
  const courtsUsed = Math.min(courtCount, Math.floor(activeCount / 4));
  const playing = courtsUsed * 4;
  return { courtsUsed, playing, sitting: activeCount - playing };
}

function summaryItem(num, label) {
  return el("div", { class: "summary__item" }, el("span", { class: "summary__num" }, String(num)), el("span", { class: "summary__label" }, label));
}

function doGenerate(container, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const draft = getDraft(container);
  const cfg = draft.config;

  const selectedActiveIds = db.players.filter((p) => p.active && cfg.selectedIds.has(p.id)).map((p) => p.id);
  const ratingById = new Map(db.players.map((p) => [p.id, p.rating]));
  const nameById = new Map(db.players.map((p) => [p.id, p.name]));

  const session = createSession({
    date: cfg.date,
    name: cfg.name,
    location: cfg.location,
    courtCount: cfg.courtCount,
    playerIds: selectedActiveIds,
    seed: cfg.seed,
    mode: cfg.mode,
    bookingId: cfg.bookingId,
  });
  session.rules = { targetScore: db.settings.targetScore, winByTwo: db.settings.winByTwo, hardCap: db.settings.hardCap };

  const { rounds, warnings } = generateRounds(
    {
      activeIds: selectedActiveIds,
      ratingById,
      nameById,
      courtCount: cfg.courtCount,
      weights: db.settings.weights,
      mode: cfg.mode,
      constraints: db.constraints,
      seed: cfg.seed,
      priorRounds: [],
      restarts: db.settings.restartCount,
    },
    cfg.roundCount,
  );

  if (!rounds.length) {
    showToast(warnings[0] || "Could not generate a round.", { tone: "danger", duration: 6000 });
    return;
  }
  rounds.forEach((r, i) => (r.status = i === 0 ? "current" : "draft"));
  session.rounds = rounds;

  store.commit("Create session", (d) => {
    d.sessions.push(session);
    if (cfg.bookingId) {
      const b = d.bookings.find((x) => x.id === cfg.bookingId);
      if (b) b.sessionId = session.id;
    }
  });
  store.setUi({ currentSessionId: session.id });
  draft.mode = "play";
  draft.config = null;
  draft.viewIndex = 0;
  if (warnings.length) showToast(warnings[0], { duration: 6000 });
  ctx.refresh();
}

// ---------------------------------------------------------------------------
// Live play
// ---------------------------------------------------------------------------
function renderPlay(container, ctx, session) {
  const { store } = ctx;
  const db = store.getDb();
  const draft = getDraft(container);
  const playerById = new Map(db.players.map((p) => [p.id, p]));
  const rules = effectiveRules(session, db.settings);

  const currentIndex = Math.max(0, session.rounds.findIndex((r) => r.status === "current"));
  if (draft.viewIndex == null || draft.viewIndex >= session.rounds.length) draft.viewIndex = currentIndex;
  const idx = clamp(draft.viewIndex, 0, session.rounds.length - 1);
  const round = session.rounds[idx];

  mount(
    container,
    el(
      "div",
      { class: "page-header" },
      el(
        "div",
        {},
        el("h1", { class: "page-title" }, session.name || "Session"),
        el("p", { class: "muted small" }, `${session.date} \u00b7 ${MODE_LABELS[session.mode]} \u00b7 target ${rules.targetScore}${rules.winByTwo ? ", win by 2" : ""}`),
      ),
      el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => backToStart(container, ctx) }, "Sessions"),
    ),

    roundNav(session, idx, container, ctx),
    renderRound(round, session, ctx, playerById, rules, container),

    el(
      "div",
      { class: "row", style: { marginTop: "16px", flexWrap: "wrap" } },
      el("button", { class: "btn btn--ghost", type: "button", onClick: () => regenerateRound(session, idx, container, ctx) }, "Regenerate"),
      el("button", { class: "btn btn--ghost", type: "button", onClick: () => addPlayerMidSession(session, ctx) }, "+ Add player"),
      el("button", { class: "btn btn--primary grow", type: "button", onClick: () => nextRound(session, idx, container, ctx) }, idx < session.rounds.length - 1 ? "Next round \u2192" : "Close scores & next round \u2192"),
    ),
  );
}

function roundNav(session, idx, container, ctx) {
  const draft = getDraft(container);
  return el(
    "div",
    { class: "row spread", style: { marginBottom: "12px" } },
    el("button", { class: "btn btn--sm btn--ghost", type: "button", disabled: idx <= 0, onClick: () => { draft.viewIndex = idx - 1; draft.selectedSlot = null; ctx.refresh(); } }, "\u2190 Prev"),
    el("strong", {}, `Round ${session.rounds[idx].roundNumber} of ${session.rounds.length}`),
    el("button", { class: "btn btn--sm btn--ghost", type: "button", disabled: idx >= session.rounds.length - 1, onClick: () => { draft.viewIndex = idx + 1; draft.selectedSlot = null; ctx.refresh(); } }, "Next \u2192"),
  );
}

function renderRound(round, session, ctx, playerById, rules, container) {
  const prior = session.rounds.filter((r) => r.roundNumber < round.roundNumber);
  const fairness = analyzeRoundFairness(round, prior);
  const draft = getDraft(container);
  const sel = draft.selectedSlot;

  const sitOutButtons = round.sitOutIds.map((id, index) => {
    const p = playerById.get(id);
    const slot = { kind: "sitout", index };
    const selected = sel && sameSlot(sel, slot);
    return el(
      "button",
      { class: `slot slot--sit${selected ? " slot--selected" : ""}`, type: "button", onClick: () => onSlotTap(session, round, container, ctx, slot) },
      p ? avatar(p, { size: "sm" }) : null,
      el("span", { class: "slot__name" }, p ? p.name : "?"),
    );
  });

  return el(
    "div",
    { class: "stack" },
    round.warnings && round.warnings.length ? el("div", { class: "warnbox" }, round.warnings.join(" ")) : null,
    sel ? el("div", { class: "infobox row spread" }, el("span", {}, "Tap another player to swap positions."), el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => { draft.selectedSlot = null; ctx.refresh(); } }, "Cancel")) : null,
    el("div", { class: "courts" }, ...round.courts.map((court) => renderCourt(court, session, round, ctx, playerById, rules, container))),
    sitOutButtons.length
      ? el("div", { class: "sitout" }, el("strong", {}, "Sitting out: "), el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", marginTop: "6px" } }, ...sitOutButtons))
      : null,
    el(
      "div",
      { class: "row small muted", style: { marginTop: "4px", flexWrap: "wrap" } },
      el("span", {}, `Partner repeats: ${fairness.partnerRepeats}`),
      el("span", {}, `\u00b7 Consecutive: ${fairness.immediatePartnerRepeats}`),
      el("span", {}, `\u00b7 Opponent repeats: ${fairness.opponentRepeats}`),
    ),
  );
}

function renderCourt(court, session, round, ctx, playerById, rules, container) {
  const scoreDisplay = court.score ? `${court.score.a} \u2013 ${court.score.b}` : "\u2014";

  return el(
    "div",
    { class: `court ${court.locked ? "court--locked" : ""}` },
    el(
      "div",
      { class: "court__head" },
      el("span", { class: "court__num" }, `Court ${court.courtNumber}`),
      el(
        "div",
        { class: "row", style: { gap: "4px", alignItems: "center" } },
        court.status === "abandoned" ? el("span", { class: "badge badge--warn" }, "Skipped") : null,
        court.status === "completed" ? el("span", { class: "badge badge--completed" }, "Done") : null,
        el(
          "button",
          {
            class: `iconbtn${court.locked ? " iconbtn--on" : ""}`,
            type: "button",
            title: court.locked ? "Unlock court (allow regenerate)" : "Lock court (keep on regenerate)",
            "aria-label": court.locked ? "Unlock court" : "Lock court",
            "aria-pressed": String(!!court.locked),
            onClick: () => toggleCourtLock(session, round, court, ctx),
          },
          court.locked ? "\uD83D\uDD12" : "\uD83D\uDD13",
        ),
      ),
    ),
    teamBlock(court, "teamA", session, round, ctx, playerById, container),
    el("div", { class: "vs" }, "vs"),
    teamBlock(court, "teamB", session, round, ctx, playerById, container),
    el(
      "button",
      { class: "btn btn--sm btn--block", style: { marginTop: "10px" }, type: "button", onClick: () => openScoreEntry(court, session, round, ctx, playerById, rules) },
      court.score ? `Score: ${scoreDisplay}` : "Enter score",
    ),
  );
}

function teamBlock(court, teamKey, session, round, ctx, playerById, container) {
  const ids = court[teamKey];
  const scoreVal = court.score ? court.score[teamKey === "teamA" ? "a" : "b"] : null;
  const winner = court.score && ((teamKey === "teamA" && court.score.a > court.score.b) || (teamKey === "teamB" && court.score.b > court.score.a));
  const draft = getDraft(container);
  const sel = draft.selectedSlot;

  const slots = ids.map((id, index) => {
    const p = playerById.get(id);
    const slot = { kind: "court", courtNumber: court.courtNumber, teamKey, index };
    const selected = sel && sameSlot(sel, slot);
    return el(
      "button",
      {
        class: `slot${selected ? " slot--selected" : ""}`,
        type: "button",
        disabled: court.locked,
        onClick: () => onSlotTap(session, round, container, ctx, slot),
      },
      p ? avatar(p, { size: "sm" }) : null,
      el("span", { class: "slot__name" }, p ? p.name : "?"),
    );
  });

  return el(
    "div",
    { class: `team ${winner ? "team--winner" : ""}` },
    el("div", { class: "team__players" }, ...slots),
    el("div", { class: "team__score" }, scoreVal == null ? "" : String(scoreVal)),
  );
}

// ---- Round editing: tap-tap player swap + court lock ----

function sameSlot(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "court") return a.courtNumber === b.courtNumber && a.teamKey === b.teamKey && a.index === b.index;
  return a.index === b.index;
}

function slotPlayerId(round, slot) {
  if (slot.kind === "court") {
    const c = round.courts.find((x) => x.courtNumber === slot.courtNumber);
    return c ? c[slot.teamKey][slot.index] : undefined;
  }
  return round.sitOutIds[slot.index];
}

function onSlotTap(session, round, container, ctx, slot) {
  const draft = getDraft(container);
  const sel = draft.selectedSlot;
  if (!sel) {
    draft.selectedSlot = slot;
    ctx.refresh();
    return;
  }
  if (sameSlot(sel, slot)) {
    draft.selectedSlot = null;
    ctx.refresh();
    return;
  }
  commitSwap(session, round, container, ctx, sel, slot);
}

function commitSwap(session, round, container, ctx, slotA, slotB) {
  const { store } = ctx;
  const draft = getDraft(container);

  const idA = slotPlayerId(round, slotA);
  const idB = slotPlayerId(round, slotB);
  if (idA == null || idB == null) {
    draft.selectedSlot = null;
    ctx.refresh();
    return;
  }

  const proposedRound = {
    sitOutIds: round.sitOutIds.slice(),
    courts: round.courts.map((court) => ({ ...court, teamA: court.teamA.slice(), teamB: court.teamB.slice() })),
  };
  setSlotPlayer(proposedRound, slotA, idB);
  setSlotPlayer(proposedRound, slotB, idA);
  const db = store.getDb();
  const nameById = new Map(db.players.map((player) => [player.id, player.name]));
  const constraintCheck = validateConstraints(proposedRound.courts, db.constraints, nameById);
  if (!constraintCheck.valid) {
    draft.selectedSlot = null;
    showToast(`Swap blocked. ${constraintCheck.violations.join(" ")}`, { tone: "danger", duration: 6000 });
    ctx.refresh();
    return;
  }

  const affectedCourtNums = [slotA, slotB].filter((s) => s.kind === "court").map((s) => s.courtNumber);
  const willClear = round.courts.filter((c) => affectedCourtNums.includes(c.courtNumber) && c.status !== "pending");

  const doIt = () => {
    store.commit("Swap players", (d) => {
      const s = d.sessions.find((x) => x.id === session.id);
      const r = s.rounds.find((x) => x.roundNumber === round.roundNumber);
      setSlotPlayer(r, slotA, idB);
      setSlotPlayer(r, slotB, idA);
      for (const c of r.courts) {
        if (affectedCourtNums.includes(c.courtNumber) && c.status !== "pending") {
          c.score = null;
          c.status = "pending";
        }
      }
    });
    draft.selectedSlot = null;
    showToast("Players swapped.", { actionLabel: "Undo", onAction: () => { store.undo(); ctx.refresh(); } });
    ctx.refresh();
  };

  if (willClear.length) {
    confirmDialog({
      title: "Swap players?",
      message: "This changes a court that already has a score. That score will be cleared.",
      confirmLabel: "Swap & clear score",
      tone: "danger",
    }).then((ok) => {
      if (ok) doIt();
      else { draft.selectedSlot = null; ctx.refresh(); }
    });
  } else {
    doIt();
  }
}

function setSlotPlayer(round, slot, value) {
  if (slot.kind === "court") {
    const c = round.courts.find((x) => x.courtNumber === slot.courtNumber);
    if (c) c[slot.teamKey][slot.index] = value;
  } else {
    round.sitOutIds[slot.index] = value;
  }
}

function toggleCourtLock(session, round, court, ctx) {
  ctx.store.commit(court.locked ? "Unlock court" : "Lock court", (d) => {
    const s = d.sessions.find((x) => x.id === session.id);
    const r = s.rounds.find((x) => x.roundNumber === round.roundNumber);
    const c = r.courts.find((x) => x.courtNumber === court.courtNumber);
    c.locked = !c.locked;
  });
  ctx.refresh();
}

function openScoreEntry(court, session, round, ctx, playerById, rules) {
  const { store } = ctx;
  const aInput = el("input", { type: "number", min: "0", inputmode: "numeric", value: court.score ? String(court.score.a) : "", "aria-label": "Team A score" });
  const bInput = el("input", { type: "number", min: "0", inputmode: "numeric", value: court.score ? String(court.score.b) : "", "aria-label": "Team B score" });
  const warnBox = el("div", { class: "warnbox hidden" });

  const teamAName = court.teamA.map((id) => (playerById.get(id) ? playerById.get(id).name : "?")).join(" & ");
  const teamBName = court.teamB.map((id) => (playerById.get(id) ? playerById.get(id).name : "?")).join(" & ");

  const controller = openDialog({
    title: `Court ${court.courtNumber} score`,
    body: el(
      "div",
      { class: "stack" },
      el("div", { class: "field-row" }, field(teamAName || "Team A", aInput), field(teamBName || "Team B", bInput)),
      warnBox,
      el("p", { class: "muted small" }, `Target ${rules.targetScore}${rules.winByTwo ? ", win by 2" : ""}${rules.hardCap ? `, cap ${rules.hardCap}` : ""}.`),
    ),
    actions: [
      el("button", { class: "btn btn--ghost", type: "button", style: { marginRight: "auto" }, onClick: () => skipCourt() }, "Skip game"),
      el("button", { class: "btn btn--ghost", type: "button", onClick: () => controller.close() }, "Cancel"),
      el("button", { class: "btn btn--primary", type: "button", onClick: () => save() }, "Save score"),
    ],
  });

  function save() {
    const score = { a: Number(aInput.value), b: Number(bInput.value) };
    const result = validateScore(score, rules);
    if (!result.ok) {
      warnBox.textContent = result.errors.join(" ");
      warnBox.classList.remove("hidden");
      return;
    }
    if (result.warnings.length && !warnBox.dataset.confirmed) {
      warnBox.textContent = `${result.warnings.join(" ")} Tap Save again to confirm.`;
      warnBox.classList.remove("hidden");
      warnBox.dataset.confirmed = "1";
      return;
    }
    store.commit(`Score court ${court.courtNumber}`, (d) => {
      const s = d.sessions.find((x) => x.id === session.id);
      const r = s.rounds.find((x) => x.roundNumber === round.roundNumber);
      const c = r.courts.find((x) => x.courtNumber === court.courtNumber);
      c.score = score;
      c.status = "completed";
    });
    controller.close();
  }

  function skipCourt() {
    store.commit(`Skip court ${court.courtNumber}`, (d) => {
      const s = d.sessions.find((x) => x.id === session.id);
      const r = s.rounds.find((x) => x.roundNumber === round.roundNumber);
      const c = r.courts.find((x) => x.courtNumber === court.courtNumber);
      c.score = null;
      c.status = "abandoned";
    });
    controller.close();
  }
}

function nextRound(session, idx, container, ctx) {
  const { store } = ctx;
  const draft = getDraft(container);

  // If a later round already exists, just advance the view.
  if (idx < session.rounds.length - 1) {
    draft.viewIndex = idx + 1;
    ctx.refresh();
    return;
  }

  const round = session.rounds[idx];
  const unresolved = round.courts.filter((c) => c.status === "pending");
  if (unresolved.length) {
    showToast(`${unresolved.length} court(s) still need a score or skip.`, { tone: "danger", duration: 5000 });
    return;
  }

  const db = store.getDb();
  const activeIds = session.playerIds.filter((id) => {
    const p = db.players.find((x) => x.id === id);
    return p && p.active;
  });
  const ratingById = new Map(db.players.map((p) => [p.id, p.rating]));
  const nameById = new Map(db.players.map((p) => [p.id, p.name]));
  const roundSeed = deriveRoundSeed(session.seed >>> 0, session.rounds.length + 1);

  const { round: newRound, error } = generateRound({
    activeIds,
    ratingById,
    nameById,
    courtCount: session.courtCount,
    weights: db.settings.weights,
    mode: session.mode,
    constraints: db.constraints,
    priorRounds: session.rounds,
    roundSeed,
    restarts: db.settings.restartCount,
  });

  if (!newRound) {
    showToast(error || "Could not generate the next round.", { tone: "danger", duration: 6000 });
    return;
  }

  store.commit("Next round", (d) => {
    const s = d.sessions.find((x) => x.id === session.id);
    s.rounds.forEach((r) => (r.status = r.status === "current" ? "completed" : r.status));
    newRound.status = "current";
    s.rounds.push(newRound);
  });
  draft.viewIndex = session.rounds.length; // new round index (pre-commit length)
  if (newRound.warnings && newRound.warnings.length) showToast(newRound.warnings[0], { duration: 6000 });
  ctx.refresh();
}

function regenerateRound(session, idx, container, ctx) {
  const { store } = ctx;
  const round = session.rounds[idx];
  const hasScores = round.courts.some((c) => c.status !== "pending");
  confirmDialog({
    title: "Regenerate round?",
    message: hasScores ? "This round has scores. Regenerating will clear them for this round." : "Regenerate this round's matchups?",
    confirmLabel: "Regenerate",
    tone: "primary",
  }).then((ok) => {
    if (!ok) return;
    const db = store.getDb();
    const activeIds = session.playerIds.filter((id) => {
      const p = db.players.find((x) => x.id === id);
      return p && p.active;
    });
    const ratingById = new Map(db.players.map((p) => [p.id, p.rating]));
    const nameById = new Map(db.players.map((p) => [p.id, p.name]));
    const priorRounds = session.rounds.slice(0, idx);
    const lockedCourts = round.courts.filter((c) => c.locked);
    const roundSeed = (deriveRoundSeed(session.seed >>> 0, round.roundNumber) ^ ((round._regen || 0) + 1) * 2654435761) >>> 0;

    const { round: newRound, error } = generateRound({
      activeIds,
      ratingById,
      nameById,
      courtCount: session.courtCount,
      weights: db.settings.weights,
      mode: session.mode,
      constraints: db.constraints,
      priorRounds,
      roundSeed,
      lockedCourts,
      restarts: db.settings.restartCount,
    });
    if (!newRound) {
      showToast(error || "Could not regenerate.", { tone: "danger", duration: 6000 });
      return;
    }
    store.commit("Regenerate round", (d) => {
      const s = d.sessions.find((x) => x.id === session.id);
      newRound.roundNumber = round.roundNumber;
      newRound.status = round.status;
      newRound._regen = (round._regen || 0) + 1;
      s.rounds[idx] = newRound;
    });
    showToast("Round regenerated.", { actionLabel: "Undo", onAction: () => store.undo() });
  });
}

function addPlayerMidSession(session, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const notInSession = db.players.filter((p) => p.active && !session.playerIds.includes(p.id));

  const body = el("div", { class: "stack" });
  if (notInSession.length) {
    body.appendChild(el("p", { class: "muted small" }, "Added players join from the next round onward."));
    body.appendChild(
      el(
        "div",
        { class: "chips" },
        ...notInSession.map((p) => el("button", { class: "chip", type: "button", onClick: () => addOne(p.id, p.name) }, p.name)),
      ),
    );
  } else {
    body.appendChild(el("p", { class: "muted small" }, "All active players are already in this session."));
  }
  body.appendChild(
    el("button", {
      class: "btn btn--ghost btn--block",
      type: "button",
      onClick: () => {
        controller.close();
        openPlayerForm(ctx).then((id) => {
          if (!id) return;
          const player = store.getDb().players.find((item) => item.id === id);
          addOne(id, player && player.name);
        });
      },
    }, "+ Create new player"),
  );

  const controller = openDialog({ title: "Add player to session", body });

  function addOne(id, name) {
    store.commit(`Add ${name || "player"} to session`, (d) => {
      const s = d.sessions.find((x) => x.id === session.id);
      if (!s.playerIds.includes(id)) s.playerIds.push(id);
    });
    showToast(`${name || "Player"} joins from the next round.`, { duration: 4000 });
    controller.close();
  }
}

function backToStart(container, ctx) {
  const draft = getDraft(container);
  draft.mode = "start";
  draft.viewIndex = null;
  ctx.store.setUi({ currentSessionId: null });
  ctx.refresh();
}
