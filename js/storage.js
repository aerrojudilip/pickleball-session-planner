// storage.js — Tier 1 persistence: the full JSON document in localStorage.
//
// Each mutation atomically stores the document and cloud-sync metadata.
// Corrupt JSON is preserved (never silently overwritten) so the user can
// choose to reset or import. Failed writes remain pending for a later flush.
//
// This module touches localStorage only; it has no other DOM dependencies.

import { DB_STORAGE_KEY, normalizeDatabase } from "./schema.js";

export const CLOUD_SYNC_FIELD = "_cloudSync";

/**
 * @typedef {Object} LoadResult
 * @property {object|null} db - normalized database, or null if none stored
 * @property {boolean} corrupt - true if stored data existed but failed to parse
 * @property {object} [syncState] - cloud state atomically stored with the database
 * @property {string} [raw] - the raw corrupt string, if any
 */

/**
 * Load and normalize the database from localStorage.
 * @returns {LoadResult}
 */
export function loadDatabase() {
  let raw;
  try {
    raw = localStorage.getItem(DB_STORAGE_KEY);
  } catch {
    return { db: null, corrupt: false };
  }
  if (raw == null) return { db: null, corrupt: false };
  try {
    const parsed = JSON.parse(raw);
    const result = { db: normalizeDatabase(parsed), corrupt: false };
    if (parsed && typeof parsed[CLOUD_SYNC_FIELD] === "object") {
      result.syncState = parsed[CLOUD_SYNC_FIELD];
    }
    return result;
  } catch {
    return { db: null, corrupt: true, raw };
  }
}

/**
 * Create an atomic local saver bound to a store.
 * @param {object} store - the app store (from createStore)
 * @param {(err: Error) => void} [onError]
 */
export function createPersister(store, onError, options = {}) {
  let pending = false;
  const onMutation = typeof options.onMutation === "function" ? options.onMutation : null;
  const getSyncState = typeof options.getSyncState === "function" ? options.getSyncState : null;

  function writeNow() {
    try {
      const db = store.getDb();
      const syncState = getSyncState ? getSyncState() : null;
      localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(cacheDocument(db, syncState)));
      pending = false;
      return true;
    } catch (err) {
      pending = true;
      if (onError) onError(err);
      return false;
    }
  }

  function schedule() {
    pending = true;
    if (onMutation) onMutation();
    writeNow();
  }

  function flush() {
    if (pending) writeNow();
  }

  // React to store mutations that request persistence.
  const unsubscribe = store.subscribe((_state, meta) => {
    if (meta && meta.type === "ui") return; // UI-only changes are not persisted
    if (meta && meta.persist === false) return;
    schedule();
  });

  return { schedule, flush, writeNow, unsubscribe };
}

/** Overwrite storage with a specific database object immediately. */
export function overwriteDatabase(db, syncState = null) {
  localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(cacheDocument(db, syncState)));
}

/** Remove the stored database entirely. */
export function clearDatabase() {
  localStorage.removeItem(DB_STORAGE_KEY);
}

function cacheDocument(db, syncState) {
  const document = normalizeDatabase(db);
  if (!syncState || !syncState.projectUrl) return document;
  return { ...document, [CLOUD_SYNC_FIELD]: { ...syncState } };
}
