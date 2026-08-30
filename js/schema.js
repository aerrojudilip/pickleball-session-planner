// schema.js — the canonical data model, defaults, IDs, and normalization.
//
// The whole application is a single JSON document. This module owns its shape:
// creating fresh documents, generating IDs, normalizing arbitrary/imported data
// up to the current schema, and validating the schema version on import.
//
// DOM-free and importable in Node.

export const SCHEMA_VERSION = 1;

/** localStorage keys. Credentials live in a SEPARATE key and are never exported. */
export const DB_STORAGE_KEY = "pickleball.db.v1";
export const CREDENTIALS_STORAGE_KEY = "pickleball.github.credentials.v1";

/** Rating bounds for DUPR-style ratings. */
export const RATING_MIN = 2.0;
export const RATING_MAX = 5.5;

/** Fallback rating used when a player has no rating in skill-based math. */
export const DEFAULT_RATING = 3.5;

/** Scheduling modes. */
export const MODES = Object.freeze(["random", "balanced", "tiered", "fixed"]);

/**
 * Default global settings. Note the fifth weight `crossCourtSpread` which the
 * original data model omitted from its example but which the cost function
 * requires.
 */
export function defaultSettings() {
  return {
    targetScore: 11,
    winByTwo: true,
    hardCap: null,
    mode: "random",
    weights: {
      partnerRepeat: 10,
      opponentRepeat: 4,
      skillBalance: 3,
      courtRepeat: 2,
      crossCourtSpread: 1,
    },
    theme: "system", // 'system' | 'light' | 'dark'
    restartCount: 500,
  };
}

/** A brand-new empty database document. */
export function createEmptyDatabase() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: defaultSettings(),
    players: [],
    constraints: { mustPair: [], mustNotPair: [] },
    sessions: [],
    bookings: [],
  };
}

/**
 * Generate a short, prefixed, collision-resistant id.
 * @param {string} prefix e.g. "p", "s", "b"
 */
export function generateId(prefix) {
  const cryptoObj = globalThis.crypto;
  let uuid;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    uuid = cryptoObj.randomUUID();
  } else {
    uuid = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  }
  return `${prefix}_${uuid.replace(/-/g, "").slice(0, 12)}`;
}

/** ISO timestamp for "now". */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Today's date as a local YYYY-MM-DD string (no UTC day shift).
 * @param {Date} [date]
 */
export function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Clamp a number into [min, max]. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createPlayer({ name, rating = null, notes = "", active = true, isSample = false } = {}) {
  return {
    id: generateId("p"),
    name: String(name || "").trim(),
    rating: normalizeRating(rating),
    active: active !== false,
    notes: String(notes || ""),
    isSample: Boolean(isSample),
    createdAt: nowIso(),
  };
}

export function createSession({ date, name = "", location = "", courtCount = 3, playerIds = [], seed, mode = "random", bookingId = null } = {}) {
  return {
    id: generateId("s"),
    date: date || localDateString(),
    name: String(name || ""),
    location: String(location || ""),
    courtCount: clamp(Number(courtCount) || 1, 1, 12),
    playerIds: Array.isArray(playerIds) ? playerIds.slice() : [],
    seed: seed >>> 0,
    mode: MODES.includes(mode) ? mode : "random",
    bookingId: bookingId || null,
    rules: null, // snapshot of scoring rules, filled when first round is generated
    rounds: [],
    createdAt: nowIso(),
  };
}

export function createBooking({ date, startTime = "18:00", durationMinutes = 90, courtCount = 3, name = "", location = "", notes = "", sessionId = null } = {}) {
  return {
    id: generateId("b"),
    date: date || localDateString(),
    startTime: normalizeTime(startTime),
    durationMinutes: clamp(Math.round(Number(durationMinutes) || 90), 15, 24 * 60),
    courtCount: clamp(Number(courtCount) || 1, 1, 12),
    name: String(name || ""),
    location: String(location || ""),
    notes: String(notes || ""),
    sessionId: sessionId || null,
    createdAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Coerce a rating to null or a clamped number within bounds. */
export function normalizeRating(rating) {
  if (rating === null || rating === undefined || rating === "") return null;
  const n = Number(rating);
  if (!Number.isFinite(n)) return null;
  return clamp(Math.round(n * 2) / 2, RATING_MIN, RATING_MAX);
}

/** Coerce a time to a valid HH:MM 24h string, defaulting to 18:00. */
export function normalizeTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
  if (!m) return "18:00";
  const h = clamp(Number(m[1]), 0, 23);
  const min = clamp(Number(m[2]), 0, 59);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Validate the schemaVersion of an imported document.
 * @returns {{ ok: boolean, version: number, reason?: string }}
 */
export function checkSchemaVersion(doc) {
  const version = Number(doc && doc.schemaVersion);
  if (!Number.isFinite(version)) {
    return { ok: false, version: NaN, reason: "Missing or invalid schemaVersion." };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      version,
      reason: `This file uses schema version ${version}, but this app supports up to ${SCHEMA_VERSION}. Update the app first.`,
    };
  }
  return { ok: true, version };
}

/**
 * Normalize an arbitrary object into a valid, current-schema database.
 * Missing pieces are filled with defaults; unknown keys are dropped. This is
 * the single choke point that guarantees the rest of the app sees clean data.
 *
 * @param {any} raw
 * @returns {object} a normalized database
 */
export function normalizeDatabase(raw) {
  const db = createEmptyDatabase();
  if (!raw || typeof raw !== "object") return db;

  // Settings
  const s = raw.settings || {};
  const defaults = defaultSettings();
  db.settings = {
    targetScore: [11, 15, 21].includes(Number(s.targetScore)) ? Number(s.targetScore) : defaults.targetScore,
    winByTwo: s.winByTwo === undefined ? defaults.winByTwo : Boolean(s.winByTwo),
    hardCap: s.hardCap === null || s.hardCap === undefined ? null : clamp(Number(s.hardCap) || 0, 1, 99),
    mode: MODES.includes(s.mode) ? s.mode : defaults.mode,
    weights: { ...defaults.weights, ...(s.weights && typeof s.weights === "object" ? sanitizeWeights(s.weights) : {}) },
    theme: ["system", "light", "dark"].includes(s.theme) ? s.theme : defaults.theme,
    restartCount: clamp(Number(s.restartCount) || defaults.restartCount, 50, 5000),
  };

  // Players
  const seenPlayerIds = new Set();
  db.players = asArray(raw.players)
    .map(normalizePlayer)
    .filter((p) => p && !seenPlayerIds.has(p.id) && seenPlayerIds.add(p.id));
  const validPlayerIds = new Set(db.players.map((p) => p.id));

  // Constraints (only pairs referencing known players survive)
  db.constraints = {
    mustPair: normalizePairList(raw.constraints && raw.constraints.mustPair, validPlayerIds),
    mustNotPair: normalizePairList(raw.constraints && raw.constraints.mustNotPair, validPlayerIds),
  };

  // Sessions
  const seenSessionIds = new Set();
  db.sessions = asArray(raw.sessions)
    .map((sess) => normalizeSession(sess, validPlayerIds))
    .filter((sess) => sess && !seenSessionIds.has(sess.id) && seenSessionIds.add(sess.id));
  const validSessionIds = new Set(db.sessions.map((sess) => sess.id));

  // Bookings (additive top-level array; default to [])
  const seenBookingIds = new Set();
  db.bookings = asArray(raw.bookings)
    .map(normalizeBooking)
    .filter((b) => b && !seenBookingIds.has(b.id) && seenBookingIds.add(b.id))
    .map((b) => {
      // Drop dangling session back-links.
      if (b.sessionId && !validSessionIds.has(b.sessionId)) b.sessionId = null;
      return b;
    });

  // Repair session <-> booking back-links symmetrically.
  const validBookingIds = new Set(db.bookings.map((b) => b.id));
  for (const sess of db.sessions) {
    if (sess.bookingId && !validBookingIds.has(sess.bookingId)) sess.bookingId = null;
  }

  return db;
}

function sanitizeWeights(w) {
  const out = {};
  for (const key of ["partnerRepeat", "opponentRepeat", "skillBalance", "courtRepeat", "crossCourtSpread"]) {
    if (w[key] !== undefined && Number.isFinite(Number(w[key]))) {
      out[key] = clamp(Number(w[key]), 0, 1000);
    }
  }
  return out;
}

function normalizePlayer(p) {
  if (!p || typeof p !== "object") return null;
  const id = typeof p.id === "string" && p.id ? p.id : generateId("p");
  return {
    id,
    name: String(p.name || "").trim() || "Unnamed",
    rating: normalizeRating(p.rating),
    active: p.active !== false,
    notes: String(p.notes || ""),
    isSample: Boolean(p.isSample),
    createdAt: typeof p.createdAt === "string" ? p.createdAt : nowIso(),
  };
}

function normalizeSession(sess, validPlayerIds) {
  if (!sess || typeof sess !== "object") return null;
  const id = typeof sess.id === "string" && sess.id ? sess.id : generateId("s");
  const playerIds = asArray(sess.playerIds).filter((pid) => validPlayerIds.has(pid));
  return {
    id,
    date: typeof sess.date === "string" ? sess.date : localDateString(),
    name: String(sess.name || ""),
    location: String(sess.location || ""),
    courtCount: clamp(Number(sess.courtCount) || 1, 1, 12),
    playerIds,
    seed: Number.isFinite(Number(sess.seed)) ? Number(sess.seed) >>> 0 : 0,
    mode: MODES.includes(sess.mode) ? sess.mode : "random",
    bookingId: typeof sess.bookingId === "string" ? sess.bookingId : null,
    rules: normalizeRules(sess.rules),
    rounds: asArray(sess.rounds).map((r) => normalizeRound(r)).filter(Boolean),
    createdAt: typeof sess.createdAt === "string" ? sess.createdAt : nowIso(),
  };
}

function normalizeRules(rules) {
  if (!rules || typeof rules !== "object") return null;
  return {
    targetScore: [11, 15, 21].includes(Number(rules.targetScore)) ? Number(rules.targetScore) : 11,
    winByTwo: Boolean(rules.winByTwo),
    hardCap: rules.hardCap === null || rules.hardCap === undefined ? null : clamp(Number(rules.hardCap) || 0, 1, 99),
  };
}

function normalizeRound(r) {
  if (!r || typeof r !== "object") return null;
  const round = {
    roundNumber: Number(r.roundNumber) || 1,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : nowIso(),
    status: ["draft", "current", "completed"].includes(r.status) ? r.status : "draft",
    sitOutIds: asArray(r.sitOutIds),
    warnings: asArray(r.warnings).map(String),
    courts: asArray(r.courts).map(normalizeCourt).filter(Boolean),
  };
  const regenerationCount = Number(r._regen);
  if (Number.isInteger(regenerationCount) && regenerationCount > 0) round._regen = regenerationCount;
  return round;
}

function normalizeCourt(c) {
  if (!c || typeof c !== "object") return null;
  const teamA = asArray(c.teamA).slice(0, 2);
  const teamB = asArray(c.teamB).slice(0, 2);
  let score = null;
  if (c.score && typeof c.score === "object" && c.score.a !== undefined && c.score.b !== undefined) {
    score = { a: Number(c.score.a) || 0, b: Number(c.score.b) || 0 };
  }
  return {
    courtNumber: Number(c.courtNumber) || 1,
    teamA,
    teamB,
    score,
    status: ["pending", "completed", "abandoned"].includes(c.status) ? c.status : "pending",
    locked: Boolean(c.locked),
    timerEndsAt: typeof c.timerEndsAt === "string" ? c.timerEndsAt : null,
  };
}

function normalizeBooking(b) {
  if (!b || typeof b !== "object") return null;
  const id = typeof b.id === "string" && b.id ? b.id : generateId("b");
  return {
    id,
    date: typeof b.date === "string" ? b.date : localDateString(),
    startTime: normalizeTime(b.startTime),
    durationMinutes: clamp(Math.round(Number(b.durationMinutes) || 90), 15, 24 * 60),
    courtCount: clamp(Number(b.courtCount) || 1, 1, 12),
    name: String(b.name || ""),
    location: String(b.location || ""),
    notes: String(b.notes || ""),
    sessionId: typeof b.sessionId === "string" ? b.sessionId : null,
    createdAt: typeof b.createdAt === "string" ? b.createdAt : nowIso(),
  };
}

function normalizePairList(list, validIds) {
  const out = [];
  const seen = new Set();
  for (const pair of asArray(list)) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [a, b] = pair;
    if (a === b) continue;
    if (validIds && (!validIds.has(a) || !validIds.has(b))) continue;
    const key = [a, b].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([a, b]);
  }
  return out;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}
