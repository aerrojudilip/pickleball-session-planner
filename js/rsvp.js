// rsvp.js — per-player attendance replies for scheduled court bookings.
//
// Bookings live inside the shared app document, which only the administrator
// may write. Attendance has to be writable by every visitor, so a reply is its
// own small record keyed by (bookingId, playerId) and is carried by an injected
// transport: the cloud `booking_rsvps` table in a configured deployment, or
// browser storage in a standalone build.
//
// DOM-free and importable in Node.

/** The three replies a player can give, in display order. */
export const RSVP_RESPONSES = Object.freeze(["going", "maybe", "not_going"]);

/** Human labels for each reply. */
export const RSVP_LABELS = Object.freeze({
  going: "Going",
  maybe: "Maybe",
  not_going: "Not going",
});

/** Browser storage keys: standalone replies, and the remembered "this is me". */
export const RSVP_STORAGE_KEY = "pickleball.rsvps.v1";
export const RSVP_IDENTITY_KEY = "pickleball.rsvp.identity.v1";

const EPOCH_ISO = new Date(0).toISOString();

/** Composite key for one player's reply to one booking. */
export function rsvpKey(bookingId, playerId) {
  return `${bookingId} ${playerId}`;
}

/** Coerce a reply to one of the three known values, or null. */
export function normalizeResponse(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return RSVP_RESPONSES.includes(text) ? text : null;
}

/**
 * Normalize one reply record. Both camelCase (local) and snake_case (PostgREST)
 * field names are accepted so transports stay dumb.
 * @returns {{bookingId: string, playerId: string, response: string, updatedAt: string}|null}
 */
export function normalizeRsvp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const bookingId = String(raw.bookingId ?? raw.booking_id ?? "").trim();
  const playerId = String(raw.playerId ?? raw.player_id ?? "").trim();
  const response = normalizeResponse(raw.response);
  if (!bookingId || !playerId || !response) return null;
  const updatedAt = raw.updatedAt ?? raw.updated_at;
  return {
    bookingId,
    playerId,
    response,
    updatedAt: typeof updatedAt === "string" && updatedAt ? updatedAt : EPOCH_ISO,
  };
}

/**
 * Normalize a list of replies, dropping invalid rows and collapsing duplicates
 * for the same (booking, player) down to the most recently updated one.
 */
export function normalizeRsvpList(rows) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const rsvp = normalizeRsvp(row);
    if (!rsvp) continue;
    const key = rsvpKey(rsvp.bookingId, rsvp.playerId);
    const existing = byKey.get(key);
    if (!existing || existing.updatedAt <= rsvp.updatedAt) byKey.set(key, rsvp);
  }
  return [...byKey.values()];
}

/**
 * Group a roster by its replies to one booking.
 * @param {Array<{id: string, name: string}>} players
 * @param {Map<string, object>|Array<object>} replies - by player id, or a list
 * @returns {{going: Array, maybe: Array, not_going: Array, pending: Array, counts: object}}
 */
export function summarizeRsvps(players, replies) {
  const byPlayer =
    replies instanceof Map
      ? replies
      : new Map(normalizeRsvpList(replies).map((r) => [r.playerId, r]));

  const groups = { going: [], maybe: [], not_going: [], pending: [] };
  for (const player of Array.isArray(players) ? players : []) {
    const reply = byPlayer.get(player.id);
    const bucket = reply ? groups[reply.response] : groups.pending;
    bucket.push(player);
  }
  return {
    ...groups,
    counts: {
      going: groups.going.length,
      maybe: groups.maybe.length,
      not_going: groups.not_going.length,
      pending: groups.pending.length,
      replied: groups.going.length + groups.maybe.length + groups.not_going.length,
    },
  };
}

/** Player ids that replied "going" to one booking. */
export function goingPlayerIds(replies) {
  const list = replies instanceof Map ? [...replies.values()] : normalizeRsvpList(replies);
  return list.filter((r) => r.response === "going").map((r) => r.playerId);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Create the attendance store: an in-memory cache of replies plus the
 * remembered identity of whoever is holding the phone.
 *
 * Replies are applied optimistically and rolled back if the transport rejects
 * them, so a tap always feels immediate but never lies about what was stored.
 *
 * @param {{load: () => Promise<Array>, save: (rsvp: object) => Promise<object|void>, removeBooking?: (bookingId: string) => Promise<void>}} transport
 * @param {{storage?: Storage, staleAfter?: number, now?: () => number, onError?: (err: Error) => void}} [options]
 */
export function createRsvpStore(transport, options = {}) {
  const storage = options.storage === undefined ? globalThis.localStorage : options.storage;
  const staleAfter = Number.isFinite(options.staleAfter) ? Math.max(0, options.staleAfter) : 15000;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onError = typeof options.onError === "function" ? options.onError : () => {};

  /** @type {Map<string, object>} */
  let entries = new Map();
  /** Optimistic writes that an in-flight refresh must not clobber. */
  const inflight = new Map();
  let identity = readIdentity(storage);
  let loadedAt = 0;
  let loading = null;
  let ready = false;
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function replaceAll(rows) {
    const normalized = normalizeRsvpList(rows);
    const next = new Map(normalized.map((r) => [rsvpKey(r.bookingId, r.playerId), r]));
    for (const [key, record] of inflight) next.set(key, record);
    const changed = fingerprint(next) !== fingerprint(entries);
    entries = next;
    loadedAt = now();
    ready = true;
    if (changed) notify();
    return changed;
  }

  /**
   * Fetch replies from the transport. Repeat calls within `staleAfter` reuse
   * the last result, so views may call this on every render.
   * @param {{force?: boolean}} [opts]
   */
  function refresh(opts = {}) {
    if (loading) return loading;
    if (!opts.force && ready && now() - loadedAt < staleAfter) return Promise.resolve(false);
    loading = Promise.resolve()
      .then(() => transport.load())
      .then((rows) => replaceAll(rows))
      .catch((error) => {
        onError(error);
        throw error;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  /** Every known reply, across all bookings. */
  function list() {
    return [...entries.values()];
  }

  /** Replies to one booking, as a Map of player id to reply. */
  function forBooking(bookingId) {
    const byPlayer = new Map();
    for (const rsvp of entries.values()) {
      if (rsvp.bookingId === bookingId) byPlayer.set(rsvp.playerId, rsvp);
    }
    return byPlayer;
  }

  /** One player's reply to one booking, or null. */
  function get(bookingId, playerId) {
    return entries.get(rsvpKey(bookingId, playerId)) || null;
  }

  /**
   * Record a reply. Resolves once the transport has stored it; rejects (after
   * rolling the optimistic value back) if it could not.
   */
  async function setResponse(bookingId, playerId, response) {
    const normalized = normalizeResponse(response);
    if (!bookingId || !playerId || !normalized) {
      throw new TypeError("A booking, a player, and a valid response are required.");
    }
    const key = rsvpKey(bookingId, playerId);
    const record = {
      bookingId: String(bookingId),
      playerId: String(playerId),
      response: normalized,
      updatedAt: new Date(now()).toISOString(),
    };
    const previous = entries.get(key) || null;

    entries.set(key, record);
    inflight.set(key, record);
    ready = true;
    notify();

    try {
      const saved = normalizeRsvp(await transport.save({ ...record }));
      // A newer tap may have landed while this one was in flight; leave it be.
      if (inflight.get(key) === record) {
        if (saved) entries.set(key, saved);
        notify();
      }
      return saved || record;
    } catch (error) {
      if (inflight.get(key) === record) {
        if (previous) entries.set(key, previous);
        else entries.delete(key);
        notify();
      }
      // The caller reports this one: it knows which reply failed.
      throw error;
    } finally {
      if (inflight.get(key) === record) inflight.delete(key);
    }
  }

  /** Forget every reply to a booking (used when the booking is deleted). */
  async function removeBooking(bookingId) {
    let changed = false;
    for (const [key, rsvp] of [...entries]) {
      if (rsvp.bookingId !== bookingId) continue;
      entries.delete(key);
      changed = true;
    }
    if (changed) notify();
    if (typeof transport.removeBooking !== "function") return;
    try {
      await transport.removeBooking(bookingId);
    } catch (error) {
      onError(error);
    }
  }

  /** The player id this device last replied as, or null. */
  function getIdentity() {
    return identity;
  }

  /** Remember (or clear) the player this device replies as. */
  function setIdentity(playerId) {
    const next = playerId ? String(playerId) : null;
    if (next === identity) return;
    identity = next;
    writeIdentity(storage, identity);
    notify();
  }

  return {
    subscribe,
    refresh,
    list,
    forBooking,
    get,
    setResponse,
    removeBooking,
    getIdentity,
    setIdentity,
    isReady: () => ready,
  };
}

function fingerprint(map) {
  return [...map.values()]
    .map((r) => `${r.bookingId}|${r.playerId}|${r.response}`)
    .sort()
    .join("\n");
}

function readIdentity(storage) {
  try {
    return storage ? storage.getItem(RSVP_IDENTITY_KEY) || null : null;
  } catch {
    return null;
  }
}

function writeIdentity(storage, playerId) {
  if (!storage) return;
  try {
    if (playerId) storage.setItem(RSVP_IDENTITY_KEY, playerId);
    else storage.removeItem(RSVP_IDENTITY_KEY);
  } catch {
    // Private browsing restrictions must not break replying.
  }
}

/**
 * Browser-storage transport for standalone builds (no Supabase configured).
 * Replies stay on the one device, which is the best a static build can do.
 */
export function createLocalRsvpTransport(storage = globalThis.localStorage) {
  function readAll() {
    try {
      return normalizeRsvpList(JSON.parse(storage.getItem(RSVP_STORAGE_KEY)));
    } catch {
      return [];
    }
  }
  function writeAll(rows) {
    try {
      storage.setItem(RSVP_STORAGE_KEY, JSON.stringify(rows));
    } catch {
      throw new Error("This browser's storage is full, so your reply was not saved.");
    }
  }
  return {
    async load() {
      return readAll();
    },
    async save(record) {
      const rsvp = normalizeRsvp(record);
      if (!rsvp) throw new TypeError("Invalid attendance reply.");
      const key = rsvpKey(rsvp.bookingId, rsvp.playerId);
      writeAll([...readAll().filter((r) => rsvpKey(r.bookingId, r.playerId) !== key), rsvp]);
      return rsvp;
    },
    async removeBooking(bookingId) {
      writeAll(readAll().filter((r) => r.bookingId !== bookingId));
    },
  };
}
