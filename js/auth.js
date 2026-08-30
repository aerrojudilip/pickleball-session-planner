// auth.js — administrator access for this static application.
//
// A configured Supabase backend provides the authorization boundary. Local
// verification is available only when a host explicitly injects a verifier.

export const ADMIN_USERNAME = "admin";
export const ADMIN_SESSION_KEY = "pickleball.admin.session.v1";

export function createAdminAuth(options = {}) {
  const backend = options.backend;
  if (backend && backend.isConfigured()) {
    return {
      isAuthenticated: () => backend.isAuthenticated(),
      signIn: (username, password) => backend.signIn(username, password),
      signOut: () => backend.signOut(),
      usesCloud: () => true,
    };
  }

  const storage = options.storage || globalThis.sessionStorage;
  const verify = options.verify;
  let authenticated = readSession(storage);

  return {
    isAuthenticated: () => authenticated,
    async signIn(username, password) {
      if (typeof verify !== "function") return false;
      const valid = await verify(username, password);
      if (!valid) return false;
      authenticated = true;
      writeSession(storage, true);
      return true;
    },
    signOut() {
      authenticated = false;
      writeSession(storage, false);
    },
    usesCloud: () => false,
  };
}

function readSession(storage) {
  try {
    return storage.getItem(ADMIN_SESSION_KEY) === "authenticated";
  } catch {
    return false;
  }
}

function writeSession(storage, authenticated) {
  try {
    if (authenticated) storage.setItem(ADMIN_SESSION_KEY, "authenticated");
    else storage.removeItem(ADMIN_SESSION_KEY);
  } catch {
    /* Private browsing restrictions should not break the rest of the app. */
  }
}