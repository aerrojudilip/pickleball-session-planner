// github.js — optional GitHub Contents API backup adapter.
// DOM-free: credentials are supplied by the caller and are never persisted here.

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubApiError extends Error {
  constructor(message, { status = 0, path = "", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = path;
  }
}

export function createGitHubClient(options = {}) {
  const config = normalizeConfig(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  let writeQueue = Promise.resolve();

  function enqueue(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  }

  async function testConnection() {
    const response = await request(`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`);
    return {
      fullName: String(response.full_name || `${config.owner}/${config.repo}`),
      private: Boolean(response.private),
      defaultBranch: String(response.default_branch || config.branch),
      permissions: response.permissions || null,
    };
  }

  async function getFile(path) {
    const normalizedPath = normalizePath(path);
    const url = contentsUrl(normalizedPath, true);
    const response = await fetchResponse(url, { method: "GET" }, normalizedPath, true);
    if (response.status === 404) return { exists: false, sha: null };
    const data = await response.json();
    return { exists: true, sha: String(data.sha || "") };
  }

  function putFile(path, content, message) {
    return enqueue(() => writeFile(path, content, message));
  }

  async function writeFile(path, content, message) {
    const normalizedPath = normalizePath(path);
    let remote = await getFile(normalizedPath);
    try {
      return await putAttempt(normalizedPath, content, message, remote.sha);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 409) throw error;
      remote = await getFile(normalizedPath);
      return putAttempt(normalizedPath, content, message, remote.sha);
    }
  }

  async function putAttempt(path, content, message, sha) {
    const body = {
      message: String(message || `Update ${path}`),
      content: utf8ToBase64(String(content)),
      branch: config.branch,
    };
    if (sha) body.sha = sha;

    const response = await fetchResponse(
      contentsUrl(path, false),
      { method: "PUT", body: JSON.stringify(body) },
      path,
    );
    const data = await response.json();
    return {
      path,
      sha: String((data.content && data.content.sha) || ""),
      commitSha: String((data.commit && data.commit.sha) || ""),
      created: response.status === 201,
    };
  }

  async function syncDatabase(db, options = {}) {
    const previousHashes = { ...(options.previousHashes || {}) };
    const nextHashes = { ...previousHashes };
    const files = databaseFiles(db);
    const result = { written: [], skipped: [], hashes: nextHashes, lastSyncAt: null };

    for (const file of files) {
      const hash = hashContent(file.content);
      if (previousHashes[file.path] === hash) {
        result.skipped.push(file.path);
        if (options.onProgress) options.onProgress({ type: "skipped", path: file.path, result });
        continue;
      }

      try {
        await putFile(file.path, file.content, file.message);
      } catch (error) {
        error.syncResult = result;
        throw error;
      }
      nextHashes[file.path] = hash;
      result.written.push(file.path);
      if (options.onProgress) options.onProgress({ type: "written", path: file.path, result });
    }

    result.lastSyncAt = new Date().toISOString();
    return result;
  }

  async function request(path) {
    const response = await fetchResponse(`${API_ROOT}${path}`, { method: "GET" }, path);
    return response.json();
  }

  function contentsUrl(path, includeRef) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const base = `${API_ROOT}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodedPath}`;
    return includeRef ? `${base}?ref=${encodeURIComponent(config.branch)}` : base;
  }

  async function fetchResponse(url, init, path, allowNotFound = false) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${config.token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...(init.headers || {}),
        },
      });
    } catch (cause) {
      throw new GitHubApiError("Could not reach GitHub. Check your connection and try again.", { path, cause });
    }

    if (response.ok || (allowNotFound && response.status === 404)) return response;

    let detail = "";
    try {
      const body = await response.json();
      detail = body && body.message ? String(body.message) : "";
    } catch {
      detail = "";
    }
    throw new GitHubApiError(errorMessage(response, detail), { status: response.status, path });
  }

  return { testConnection, getFile, putFile, syncDatabase };
}

export function databaseFiles(db) {
  const schemaVersion = Number(db && db.schemaVersion) || 1;
  const players = Array.isArray(db && db.players) ? db.players : [];
  const sessions = Array.isArray(db && db.sessions) ? db.sessions : [];
  const files = [
    {
      path: "data/players.json",
      content: `${JSON.stringify({ schemaVersion, players }, null, 2)}\n`,
      message: "Backup pickleball players",
    },
  ];

  for (const session of sessions) {
    const date = safeSegment(session.date || "undated");
    const id = safeSegment(session.id || "session");
    const path = `data/sessions/${date}-${id}.json`;
    files.push({
      path,
      content: `${JSON.stringify({ schemaVersion, session }, null, 2)}\n`,
      message: `Backup pickleball session ${session.date || session.id || ""}`.trim(),
    });
  }
  return files;
}

export function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return globalThis.btoa(binary);
}

export function hashContent(value) {
  const bytes = new TextEncoder().encode(String(value));
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeConfig(options) {
  const owner = String(options.owner || "").trim();
  const repo = String(options.repo || "").trim();
  const branch = String(options.branch || "main").trim() || "main";
  const token = String(options.token || "").trim();
  if (!owner) throw new TypeError("GitHub owner is required.");
  if (!repo) throw new TypeError("GitHub repository is required.");
  if (!token) throw new TypeError("GitHub token is required.");
  return { owner, repo, branch, token };
}

function normalizePath(path) {
  const value = String(path || "").replace(/^\/+/, "");
  if (!value || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("A safe repository-relative file path is required.");
  }
  return value;
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function errorMessage(response, detail) {
  const suffix = detail ? ` ${detail}` : "";
  if (response.status === 401) return `GitHub rejected the token. Check that it is valid and not expired.${suffix}`;
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    return "GitHub's API rate limit has been reached. Wait for the reset time and try again.";
  }
  if (response.status === 403) return `GitHub denied this write. Grant this token Contents: write access to the selected repository.${suffix}`;
  if (response.status === 404) return `GitHub could not find that repository or branch, or the token cannot access it.${suffix}`;
  if (response.status === 409) return `GitHub reported a file conflict after one retry.${suffix}`;
  return `GitHub request failed (${response.status}).${suffix}`;
}