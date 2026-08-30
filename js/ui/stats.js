// ui/stats.js — leaderboard, per-player drill-down, and session history.

import { el, mount, avatar } from "./dom.js";
import { openDialog } from "./feedback.js";
import { buildRepeatMatrix, computeLeaderboard, partnerChemistry, headToHead, sessionSummary } from "../stats.js";
import { exportSessionJson, exportSessionCsv, sessionSummaryText } from "../portability.js";

const viewStates = new WeakMap();
function getViewState(container) {
  if (!viewStates.has(container)) viewStates.set(container, { tab: "leaderboard", mixingSessionId: "all" });
  return viewStates.get(container);
}

export function renderStats(container, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const state = getViewState(container);

  mount(
    container,
    el("div", { class: "page-header" }, el("div", {}, el("h1", { class: "page-title" }, "Stats"))),
    el(
      "div",
      { class: "tabs", role: "tablist" },
      tab(state, "leaderboard", "Leaderboard", container, ctx),
      tab(state, "mixing", "Mixing", container, ctx),
      tab(state, "sessions", "Sessions", container, ctx),
    ),
    state.tab === "leaderboard"
      ? leaderboardView(db, ctx)
      : state.tab === "mixing"
        ? mixingView(db, state, container, ctx)
        : sessionsView(db, ctx),
  );
}

function tab(state, key, label, container, ctx) {
  return el(
    "button",
    {
      class: "tab",
      role: "tab",
      "aria-selected": String(state.tab === key),
      type: "button",
      onClick: () => { state.tab = key; renderStats(container, ctx); },
    },
    label,
  );
}

function mixingView(db, state, container, ctx) {
  const sessions = db.sessions.slice().sort((left, right) => `${right.date}${right.createdAt}`.localeCompare(`${left.date}${left.createdAt}`));
  if (state.mixingSessionId !== "all" && !sessions.some((session) => session.id === state.mixingSessionId)) {
    state.mixingSessionId = "all";
  }
  const filter = state.mixingSessionId === "all" ? null : (session) => session.id === state.mixingSessionId;
  const matrix = buildRepeatMatrix(db, filter);
  const scope = el(
    "select",
    {
      class: "select",
      "aria-label": "Mixing matrix session",
      onChange: (event) => {
        state.mixingSessionId = event.target.value;
        renderStats(container, ctx);
      },
    },
    el("option", { value: "all", selected: state.mixingSessionId === "all" }, "All sessions"),
    ...sessions.map((session) => el("option", { value: session.id, selected: state.mixingSessionId === session.id }, `${session.date} - ${session.name || "Session"}`)),
  );

  return el(
    "div",
    { class: "stack" },
    el("div", { class: "mixing-toolbar" }, el("label", { class: "field" }, el("span", {}, "Scope"), scope)),
    matrix.playerIds.length
      ? el(
          "div",
          { class: "mixing-matrices" },
          repeatMatrixTable(db, matrix, "partner"),
          repeatMatrixTable(db, matrix, "opponent"),
        )
      : el("p", { class: "empty" }, "Generate a round to see mixing quality."),
  );
}

function repeatMatrixTable(db, matrix, kind) {
  const playerById = new Map(db.players.map((player) => [player.id, player]));
  const ids = matrix.playerIds.filter((id) => playerById.has(id));
  const counts = kind === "partner" ? matrix.partnerCounts : matrix.opponentCounts;
  const maximum = kind === "partner" ? matrix.maxPartner : matrix.maxOpponent;
  const title = kind === "partner" ? "Partner repeats" : "Opponent repeats";
  const tone = kind === "partner" ? "coral" : "blue";

  return el(
    "section",
    { class: "repeat-matrix-section" },
    el("h2", { class: "settings-section__title" }, title),
    el(
      "div",
      { class: "repeat-matrix-wrap" },
      el(
        "table",
        { class: "repeat-matrix" },
        el("caption", { class: "sr-only" }, `${title} by player`),
        el(
          "thead",
          {},
          el("tr", {}, el("th", { scope: "col" }, "Player"), ...ids.map((id) => el("th", { scope: "col", title: playerById.get(id).name }, initials(playerById.get(id).name)))),
        ),
        el(
          "tbody",
          {},
          ...ids.map((left) => el(
            "tr",
            {},
            el("th", { scope: "row" }, playerById.get(left).name),
            ...ids.map((right) => matrixCell(left, right, playerById, counts, maximum, tone)),
          )),
        ),
      ),
    ),
  );
}

function matrixCell(left, right, playerById, counts, maximum, tone) {
  if (left === right) return el("td", { class: "repeat-matrix__self", "aria-label": "Same player" }, "-");
  const key = left < right ? `${left}|${right}` : `${right}|${left}`;
  const count = counts.get(key) || 0;
  const intensity = maximum ? count / maximum : 0;
  return el(
    "td",
    {
      class: `repeat-matrix__count repeat-matrix__count--${tone}`,
      style: { "--heat-alpha": String(count ? 0.12 + intensity * 0.68 : 0.03) },
      "aria-label": `${playerById.get(left).name} and ${playerById.get(right).name}: ${count}`,
    },
    String(count),
  );
}

function leaderboardView(db, ctx) {
  const rows = computeLeaderboard(db);
  if (!rows.length) {
    return el("p", { class: "empty" }, "No completed games yet. Play and score a round to build the leaderboard.");
  }
  const playerById = new Map(db.players.map((p) => [p.id, p]));

  const head = el(
    "tr",
    {},
    el("th", {}, "Player"),
    el("th", { class: "num" }, "GP"),
    el("th", { class: "num" }, "W"),
    el("th", { class: "num" }, "L"),
    el("th", { class: "num" }, "Win%"),
    el("th", { class: "num" }, "PF"),
    el("th", { class: "num" }, "PA"),
    el("th", { class: "num" }, "Diff"),
    el("th", { class: "num" }, "Sat"),
  );

  const body = rows.map((r, i) =>
    el(
      "tr",
      { style: { cursor: "pointer" }, onClick: () => openPlayerDrill(db, r.playerId, ctx) },
      el("td", {}, el("div", { class: "row", style: { gap: "8px", alignItems: "center" } }, el("span", { class: "muted small", style: { width: "18px" } }, String(i + 1)), avatar(playerById.get(r.playerId), { size: "sm" }), el("span", {}, r.name))),
      el("td", { class: "num" }, String(r.games)),
      el("td", { class: "num" }, String(r.wins)),
      el("td", { class: "num" }, String(r.losses)),
      el("td", { class: "num" }, pct(r.winPct)),
      el("td", { class: "num" }, String(r.pointsFor)),
      el("td", { class: "num" }, String(r.pointsAgainst)),
      el("td", { class: "num", style: { color: r.diff > 0 ? "var(--court-green)" : r.diff < 0 ? "var(--coral)" : "inherit" } }, (r.diff > 0 ? "+" : "") + r.diff),
      el("td", { class: "num" }, String(r.sitOuts)),
    ),
  );

  return el(
    "div",
    {},
    el("p", { class: "muted small", style: { marginBottom: "8px" } }, "Tap a player for partners and head-to-head."),
    el("div", { class: "table-wrap" }, el("table", { class: "data" }, el("thead", {}, head), el("tbody", {}, ...body))),
  );
}

function openPlayerDrill(db, playerId, ctx) {
  const player = db.players.find((p) => p.id === playerId);
  const nameById = new Map(db.players.map((p) => [p.id, p.name]));
  const partners = partnerChemistry(db, playerId);
  const opponents = headToHead(db, playerId);

  const partnerTable = partners.length
    ? el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          { class: "data" },
          el("thead", {}, el("tr", {}, el("th", {}, "Partner"), el("th", { class: "num" }, "GP"), el("th", { class: "num" }, "W"), el("th", { class: "num" }, "Win%"))),
          el("tbody", {}, ...partners.map((r) => el("tr", {}, el("td", {}, nameById.get(r.partnerId) || "?"), el("td", { class: "num" }, String(r.games)), el("td", { class: "num" }, String(r.wins)), el("td", { class: "num" }, pct(r.winPct))))),
        ),
      )
    : el("p", { class: "muted small" }, "No partner data yet.");

  const oppTable = opponents.length
    ? el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          { class: "data" },
          el("thead", {}, el("tr", {}, el("th", {}, "Opponent"), el("th", { class: "num" }, "GP"), el("th", { class: "num" }, "W"), el("th", { class: "num" }, "L"), el("th", { class: "num" }, "Win%"))),
          el("tbody", {}, ...opponents.map((r) => el("tr", {}, el("td", {}, nameById.get(r.opponentId) || "?"), el("td", { class: "num" }, String(r.games)), el("td", { class: "num" }, String(r.wins)), el("td", { class: "num" }, String(r.losses)), el("td", { class: "num" }, pct(r.winPct))))),
        ),
      )
    : el("p", { class: "muted small" }, "No opponent data yet.");

  openDialog({
    title: player ? player.name : "Player",
    size: "lg",
    body: el(
      "div",
      { class: "stack" },
      el("h2", {}, "Best partners"),
      partnerTable,
      el("h2", { style: { marginTop: "12px" } }, "Head-to-head"),
      oppTable,
    ),
  });
}

function sessionsView(db, ctx) {
  const sessions = db.sessions.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (!sessions.length) return el("p", { class: "empty" }, "No sessions yet.");
  return el(
    "div",
    { class: "list" },
    ...sessions.map((s) => {
      const summary = sessionSummary(db, s.id);
      return el(
        "button",
        { class: "player-row", type: "button", style: { textAlign: "left", width: "100%", cursor: "pointer" }, onClick: () => openSessionSummary(db, s.id, ctx) },
        el(
          "div",
          { class: "player-row__info" },
          el("div", { class: "player-row__name" }, s.name || s.date),
          el("div", { class: "muted small" }, `${s.date} \u00b7 ${summary.rounds} round(s) \u00b7 ${summary.gamesPlayed} game(s)`),
        ),
        el("span", { class: "badge badge--completed" }, `${s.playerIds.length}p`),
      );
    }),
  );
}

function openSessionSummary(db, sessionId, ctx) {
  const summary = sessionSummary(db, sessionId);
  const session = db.sessions.find((s) => s.id === sessionId);
  const rows = summary.leaderboard;

  const table = rows.length
    ? el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          { class: "data" },
          el("thead", {}, el("tr", {}, ...["Player", "GP", "W", "L", "Win%", "PF", "PA", "Diff", "Sat"].map((label, index) => el("th", { class: index ? "num" : "" }, label)))),
          el("tbody", {}, ...rows.map((r) => el("tr", {}, el("td", {}, r.name), el("td", { class: "num" }, String(r.games)), el("td", { class: "num" }, String(r.wins)), el("td", { class: "num" }, String(r.losses)), el("td", { class: "num" }, pct(r.winPct)), el("td", { class: "num" }, String(r.pointsFor)), el("td", { class: "num" }, String(r.pointsAgainst)), el("td", { class: "num" }, (r.diff > 0 ? "+" : "") + r.diff), el("td", { class: "num" }, String(r.sitOuts))))),
        ),
      )
    : el("p", { class: "muted small" }, "No completed games in this session yet.");

  const openBtn = el(
    "button",
    { class: "btn btn--primary", type: "button" },
    "Open session",
  );
  const jsonBtn = el("button", { class: "btn btn--ghost", type: "button" }, "JSON");
  const csvBtn = el("button", { class: "btn btn--ghost", type: "button" }, "CSV");
  const copyBtn = el("button", { class: "btn btn--ghost", type: "button" }, "Copy text");
  const printBtn = el("button", { class: "btn btn--ghost", type: "button" }, "Print");
  const dialog = openDialog({
    title: session.name || session.date,
    size: "lg",
    body: el(
      "div",
      { class: "stack" },
      el("p", { class: "muted small" }, `${session.date} \u00b7 ${summary.rounds} round(s) \u00b7 ${summary.gamesPlayed} game(s)`),
      table,
      fullSessionSchedule(db, session),
      el("div", { class: "btn-row no-print", style: { marginTop: "12px" } }, el("span", { class: "muted small", style: { alignSelf: "center" } }, "Export:"), jsonBtn, csvBtn, copyBtn),
    ),
    actions: [printBtn, openBtn],
  });
  dialog.panel.classList.add("session-summary-dialog");
  const stamp = (session.name || session.date).replace(/[^\w-]+/g, "_");
  jsonBtn.addEventListener("click", () => downloadText(`session-${stamp}.json`, exportSessionJson(db, sessionId), "application/json", ctx));
  csvBtn.addEventListener("click", () => downloadText(`session-${stamp}.csv`, exportSessionCsv(db, sessionId), "text/csv", ctx));
  copyBtn.addEventListener("click", async () => {
    const text = sessionSummaryText(db, sessionId);
    try {
      await navigator.clipboard.writeText(text);
      ctx.showToast("Summary copied to clipboard.");
    } catch {
      downloadText(`session-${stamp}.txt`, text, "text/plain", ctx);
    }
  });
  printBtn.addEventListener("click", printSessionSummary);
  openBtn.addEventListener("click", () => {
    dialog.close();
    ctx.store.setUi({ currentSessionId: sessionId });
    ctx.navigate("session");
  });
}

function fullSessionSchedule(db, session) {
  const nameById = new Map(db.players.map((player) => [player.id, player.name]));
  const playerNames = (ids) => ids.map((id) => nameById.get(id) || "Unknown player").join(" & ");
  return el(
    "section",
    { class: "session-history-schedule" },
    el("h2", {}, "Schedule and results"),
    ...session.rounds.map((round) => {
      const sitOutIds = round.sitOutIds || [];
      return el(
        "section",
        { class: "session-history-round" },
        el("h3", {}, `Round ${round.roundNumber}`),
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "data" },
            el("thead", {}, el("tr", {}, el("th", {}, "Court"), el("th", {}, "Team A"), el("th", {}, "Team B"), el("th", {}, "Score"), el("th", {}, "Status"))),
            el("tbody", {}, ...round.courts.map((court) => el(
              "tr",
              {},
              el("td", {}, String(court.courtNumber)),
              el("td", {}, playerNames(court.teamA)),
              el("td", {}, playerNames(court.teamB)),
              el("td", { class: "num" }, court.score ? `${court.score.a}\u2013${court.score.b}` : "\u2014"),
              el("td", {}, court.status === "completed" ? "Completed" : court.status === "abandoned" ? "Skipped" : "Pending"),
            ))),
          ),
        ),
        sitOutIds.length ? el("p", { class: "muted small session-history-sitouts" }, `Sitting out: ${sitOutIds.map((id) => nameById.get(id) || "Unknown player").join(", ")}`) : null,
      );
    }),
  );
}

function printSessionSummary() {
  document.body.classList.add("printing-session-summary");
  window.addEventListener("afterprint", () => document.body.classList.remove("printing-session-summary"), { once: true });
  window.print();
}

function downloadText(filename, text, mime, ctx) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (ctx) ctx.showToast(`Downloaded ${filename}.`);
}

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

