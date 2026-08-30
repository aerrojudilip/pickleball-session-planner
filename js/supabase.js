// supabase.js — Supabase Auth and PostgREST adapter for the shared database.
//
// The publishable/anon key identifies the public app; Row Level Security is
// the authorization boundary. Access and refresh tokens stay in sessionStorage.

import { checkSchemaVersion, DB_STORAGE_KEY, normalizeDatabase } from "./schema.js";
import { CLOUD_SYNC_FIELD } from "./storage.js";

export const SUPABASE_SESSION_KEY = "pickleball.supabase.session.v1";
// Read-only migration fallback for development builds that used a separate key.
export const SUPABASE_SYNC_KEY = "pickleball.supabase.sync.v1";

export class SupabaseError extends Error {
  constructor(message, { status = 0, code = "", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SupabaseError";
    this.status = status;
    this.code = code;
  }
}

export class SupabaseConflictError extends SupabaseError {
  constructor(message = "Cloud data changed on another device. Review or discard this browser's pending changes before syncing.") {
    super(message, { status: 409, code: "version_conflict" });
    this.name = "SupabaseConflictError";
  }
}

export function createSupabaseBackend(options = {}, dependencies = {}) {
  const config = normalizeConfig(options);
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const storage = dependencies.storage || globalThis.sessionStorage;
  const syncStorage = dependencies.syncStorage || globalThis.localStorage;
  const now = dependencies.now || Date.now;
  let session = readSession(storage, config.url);
  let syncState = normalizeSyncState(
    dependencies.syncState || readSyncState(syncStorage, config.url, config.stateId),
    config.url,
    config.stateId,
  );
  let remoteVersion = syncState.version;
  let observedRemoteVersion = null;
  let pendingGeneration = syncState.pending ? 1 : 0;
  let writeQueue = Promise.resolve();

  function isConfigured() {
    return Boolean(config.url && config.anonKey);
  }

  function isAuthenticated() {
    return Boolean(session && (session.accessToken || session.refreshToken));
  }

  async function signIn(username, password) {
    assertConfigured();
    if (String(username || "").trim().toLowerCase() !== "admin") return false;

    const response = await fetchResponse(
      `${config.url}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ email: config.adminEmail, password: String(password || "") }),
      },
      "Could not reach the cloud sign-in service.",
    );
    if (response.status === 400 || response.status === 401) return false;
    if (!response.ok) throw await responseError(response, "Administrator sign-in failed.");

    session = sessionFromResponse(await response.json(), config.url, now());
    writeSession(storage, session);
    return true;
  }

  async function signOut() {
    const accessToken = session && session.accessToken;
    session = null;
    writeSession(storage, null);
    if (!accessToken || !isConfigured()) return;
    try {
      await fetchImpl(`${config.url}/auth/v1/logout`, {
        method: "POST",
        headers: { ...baseHeaders(), Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // The local session is already gone; an offline logout still succeeds.
    }
  }

  async function loadDatabase(options = {}) {
    assertConfigured();
    const accessToken = await validAccessToken(false);
    const query = `id=eq.${encodeURIComponent(config.stateId)}&select=document,version,updated_at&limit=1`;
    const response = await fetchResponse(
      `${config.url}/rest/v1/app_state?${query}`,
      { method: "GET", headers: restHeaders(accessToken) },
      "Could not reach the cloud database.",
    );
    if (!response.ok) throw await responseError(response, "Could not load cloud data.");

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      observedRemoteVersion = null;
      assertPendingBase(null, options.allowConflict);
      if (!syncState.pending) {
        remoteVersion = null;
        observeRemote(null, null);
      }
      return { database: null, version: null, updatedAt: null };
    }
    const row = rows[0];
    const schema = checkSchemaVersion(row.document);
    if (!schema.ok) {
      throw new SupabaseError(`Could not load cloud data. ${schema.reason}`, { code: "unsupported_schema" });
    }
    observedRemoteVersion = Number(row.version) || 1;
    assertPendingBase(observedRemoteVersion, options.allowConflict);
    if (!syncState.pending) {
      remoteVersion = observedRemoteVersion;
      observeRemote(remoteVersion, row.updated_at || null);
    }
    return {
      database: normalizeDatabase(row.document),
      version: observedRemoteVersion,
      updatedAt: row.updated_at || null,
    };
  }

  function assertPendingBase(version, allowConflict) {
    if (!syncState.pending || version === remoteVersion || allowConflict) return;
    throw new SupabaseConflictError();
  }

  function saveDatabase(database) {
    const generation = pendingGeneration;
    const task = async () => {
      const result = await writeDatabase(normalizeDatabase(database));
      finishSave(result, generation);
      return result;
    };
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  }

  async function writeDatabase(database) {
    assertConfigured();
    const accessToken = await validAccessToken(true);
    const currentVersion = remoteVersion;
    const response = currentVersion == null
      ? await insertDatabase(database, accessToken)
      : await updateDatabase(database, currentVersion, accessToken);

    if (response.status === 409) throw new SupabaseConflictError();
    if (!response.ok) throw await responseError(response, "Could not save cloud data.");
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) throw new SupabaseConflictError();

    remoteVersion = Number(rows[0].version) || (currentVersion == null ? 1 : currentVersion + 1);
    return { version: remoteVersion, updatedAt: rows[0].updated_at || null };
  }

  function markPending() {
    if (!isConfigured()) return pendingGeneration;
    pendingGeneration += 1;
    updateSyncState({ pending: true, version: remoteVersion });
    return pendingGeneration;
  }

  function finishSave(result, generation) {
    updateSyncState({
      pending: generation !== pendingGeneration,
      version: result.version,
      updatedAt: result.updatedAt,
    });
  }

  function markCacheSynced(result = {}) {
    pendingGeneration = 0;
    updateSyncState({
      pending: false,
      version: result.version ?? remoteVersion,
      updatedAt: result.updatedAt ?? syncState.updatedAt,
    });
  }

  function observeRemote(version, updatedAt) {
    updateSyncState({ pending: syncState.pending, version, updatedAt });
  }

  function updateSyncState(next) {
    syncState = {
      projectUrl: config.url,
      stateId: config.stateId,
      pending: Boolean(next.pending),
      version: normalizeVersion(next.version),
      updatedAt: next.updatedAt || null,
    };
  }

  function acceptRemote(result, persist) {
    const next = normalizeSyncState({
      pending: false,
      version: result.version,
      updatedAt: result.updatedAt,
    }, config.url, config.stateId);
    if (typeof persist === "function") persist(result.database, next);
    syncState = next;
    remoteVersion = next.version;
    observedRemoteVersion = next.version;
    pendingGeneration = 0;
  }

  function insertDatabase(database, accessToken) {
    return fetchResponse(
      `${config.url}/rest/v1/app_state?select=version,updated_at`,
      {
        method: "POST",
        headers: { ...restHeaders(accessToken), Prefer: "return=representation" },
        body: JSON.stringify({ id: config.stateId, document: database, version: 1 }),
      },
      "Could not reach the cloud database.",
    );
  }

  function updateDatabase(database, version, accessToken) {
    const query = `id=eq.${encodeURIComponent(config.stateId)}&version=eq.${version}&select=version,updated_at`;
    return fetchResponse(
      `${config.url}/rest/v1/app_state?${query}`,
      {
        method: "PATCH",
        headers: { ...restHeaders(accessToken), Prefer: "return=representation" },
        body: JSON.stringify({ document: database, version: version + 1 }),
      },
      "Could not reach the cloud database.",
    );
  }

  async function validAccessToken(required) {
    if (!session) {
      if (required) throw new SupabaseError("Administrator sign-in is required to save cloud data.", { status: 401 });
      return null;
    }
    if (session.accessToken && session.expiresAt > now() + 30000) return session.accessToken;
    if (!session.refreshToken) {
      session = null;
      writeSession(storage, null);
      if (required) throw new SupabaseError("Your administrator session expired. Sign in again.", { status: 401 });
      return null;
    }

    const response = await fetchResponse(
      `${config.url}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      },
      "Could not refresh the administrator session.",
    );
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        session = null;
        writeSession(storage, null);
        if (!required) return null;
        throw await responseError(response, "Your administrator session expired. Sign in again.");
      }
      throw await responseError(response, "Could not refresh the administrator session.");
    }
    session = sessionFromResponse(await response.json(), config.url, now());
    writeSession(storage, session);
    return session.accessToken;
  }

  function baseHeaders() {
    return { apikey: config.anonKey, "Content-Type": "application/json" };
  }

  function restHeaders(accessToken) {
    const headers = baseHeaders();
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return headers;
  }

  function assertConfigured() {
    if (!isConfigured()) throw new SupabaseError("Cloud storage has not been configured.", { code: "not_configured" });
    if (typeof fetchImpl !== "function") throw new SupabaseError("Cloud requests are unavailable in this browser.");
  }

  async function fetchResponse(url, init, networkMessage) {
    try {
      return await fetchImpl(url, init);
    } catch (cause) {
      throw new SupabaseError(networkMessage, { cause });
    }
  }

  return {
    isConfigured,
    isAuthenticated,
    signIn,
    signOut,
    loadDatabase,
    saveDatabase,
    getSyncState: () => ({ ...syncState }),
    getObservedRemoteVersion: () => observedRemoteVersion,
    markPending,
    markCacheSynced,
    acceptRemote,
    getRemoteVersion: () => remoteVersion,
  };
}

export function createCloudPersister(store, backend, options = {}) {
  const delay = Number.isFinite(options.delay) ? Math.max(0, options.delay) : 700;
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const shouldMarkPending = options.markPending !== false;
  const canPersist = typeof options.canPersist === "function" ? options.canPersist : () => true;
  let timer = null;
  let dirty = Boolean(typeof backend.getSyncState === "function" && backend.getSyncState().pending);
  let running = null;
  let stopped = false;

  function emit(state, details = {}) {
    onStatus({ state, ...details });
  }

  function schedule() {
    if (stopped || !backend.isConfigured() || !canPersist()) return;
    dirty = true;
    if (shouldMarkPending && typeof backend.markPending === "function") backend.markPending();
    emit("pending");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void writeNow().catch(() => {});
    }, delay);
  }

  async function writeNow() {
    if (stopped || !backend.isConfigured() || !canPersist()) return null;
    if (!dirty) return running;
    if (!backend.isAuthenticated()) {
      emit("requires-auth");
      return null;
    }
    if (!running) {
      const task = drain();
      running = task.finally(() => {
        if (running === wrapped) running = null;
      });
      const wrapped = running;
    }
    return running;
  }

  async function drain() {
    let lastResult = null;
    while (dirty && !stopped && backend.isAuthenticated()) {
      dirty = false;
      emit("syncing");
      try {
        lastResult = await backend.saveDatabase(store.getDb());
        emit("synced", lastResult || {});
      } catch (error) {
        dirty = true;
        emit("error", { error });
        onError(error);
        throw error;
      }
    }
    return lastResult;
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (running) await running;
    return dirty ? writeNow() : null;
  }

  function syncNow() {
    schedule();
    return flush();
  }

  function markClean() {
    dirty = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  const unsubscribeStore = store.subscribe((_state, meta) => {
    if (meta && (meta.type === "ui" || meta.persist === false || meta.cloud === false)) return;
    schedule();
  });

  function unsubscribe() {
    stopped = true;
    markClean();
    unsubscribeStore();
  }

  return { schedule, syncNow, flush, markClean, hasPending: () => dirty, unsubscribe };
}

function normalizeConfig(options) {
  const url = String(options.url || "").trim().replace(/\/+$/, "");
  if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    throw new TypeError("Supabase URL must look like https://project-ref.supabase.co.");
  }
  const adminEmail = String(options.adminEmail || "").trim().toLowerCase();
  if (url && !adminEmail) throw new TypeError("An administrator email is required for Supabase Auth.");
  return {
    url,
    anonKey: String(options.anonKey || "").trim(),
    adminEmail,
    stateId: String(options.stateId || "primary").trim() || "primary",
  };
}

function sessionFromResponse(payload, projectUrl, nowValue) {
  if (!payload || !payload.access_token) throw new SupabaseError("The cloud sign-in response was incomplete.");
  const expiresAt = Number(payload.expires_at)
    ? Number(payload.expires_at) * 1000
    : nowValue + Math.max(1, Number(payload.expires_in) || 3600) * 1000;
  return {
    projectUrl,
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token || ""),
    expiresAt,
    email: String((payload.user && payload.user.email) || ""),
  };
}

function readSession(storage, projectUrl) {
  if (!storage || !projectUrl) return null;
  try {
    const parsed = JSON.parse(storage.getItem(SUPABASE_SESSION_KEY));
    if (!parsed || parsed.projectUrl !== projectUrl || (!parsed.accessToken && !parsed.refreshToken)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(storage, session) {
  if (!storage) return;
  try {
    if (session) storage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(session));
    else storage.removeItem(SUPABASE_SESSION_KEY);
  } catch {
    // Storage restrictions do not prevent the in-memory session from working.
  }
}

function readSyncState(storage, projectUrl, stateId) {
  const empty = { projectUrl, stateId, pending: false, version: null, updatedAt: null };
  if (!storage || !projectUrl) return empty;
  try {
    const cached = JSON.parse(storage.getItem(DB_STORAGE_KEY));
    if (cached && typeof cached[CLOUD_SYNC_FIELD] === "object") return cached[CLOUD_SYNC_FIELD];
    return JSON.parse(storage.getItem(SUPABASE_SYNC_KEY)) || empty;
  } catch {
    return empty;
  }
}

function normalizeSyncState(value, projectUrl, stateId) {
  const state = value && typeof value === "object" ? value : {};
  if (state.projectUrl && (state.projectUrl !== projectUrl || state.stateId !== stateId)) {
    return { projectUrl, stateId, pending: false, version: null, updatedAt: null };
  }
  return {
    projectUrl,
    stateId,
    pending: Boolean(state.pending),
    version: normalizeVersion(state.version),
    updatedAt: state.updatedAt || null,
  };
}

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

async function responseError(response, fallback) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const detail = body && (body.msg || body.message || body.error_description || body.error);
  return new SupabaseError(detail ? `${fallback} ${detail}` : fallback, {
    status: response.status,
    code: String((body && body.code) || ""),
  });
}