export const DB_KEY = "pickleball.db.v1";
export const CREDENTIALS_KEY = "pickleball.github.credentials.v1";
export const ADMIN_SESSION_KEY = "pickleball.admin.session.v1";
export const SUPABASE_SYNC_KEY = "pickleball.supabase.sync.v1";
export const CLOUD_SYNC_FIELD = "_cloudSync";

export async function isolateCloud(page) {
  await page.route("https://ejxxfkrmboawioqwrezg.supabase.co/**", () => {
    throw new Error("An E2E test attempted to contact the production Supabase project.");
  });
  await page.addInitScript(() => {
    if (!("__PICKLEBALL_SUPABASE_CONFIG__" in globalThis)) {
      globalThis.__PICKLEBALL_SUPABASE_CONFIG__ = { url: "", anonKey: "", adminEmail: "", stateId: "primary" };
    }
  });
}

export async function configureCloud(page) {
  await page.addInitScript(() => {
    globalThis.__PICKLEBALL_SUPABASE_CONFIG__ = {
      url: "https://fixture.supabase.co",
      anonKey: "public-key",
      adminEmail: "admin@pickleball-planner.app",
      stateId: "primary",
    };
  });
}

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createTestDatabase({ withSession = false, withBooking = false } = {}) {
  const date = localDateString();
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    rating: 2.5 + (index % 6) * 0.5,
    active: true,
    notes: "",
    isSample: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  const database = {
    schemaVersion: 1,
    settings: {
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
      theme: "system",
      restartCount: 500,
    },
    players,
    constraints: { mustPair: [], mustNotPair: [] },
    sessions: [],
    bookings: [],
  };

  if (withSession) {
    database.sessions.push({
      id: "s1",
      date,
      name: "Evening Rally",
      location: "Community Courts",
      courtCount: 2,
      playerIds: players.map((player) => player.id),
      seed: 424242,
      mode: "random",
      bookingId: withBooking ? "b1" : null,
      rules: { targetScore: 11, winByTwo: true, hardCap: null },
      rounds: [
        {
          roundNumber: 1,
          startedAt: "2026-08-30T18:00:00.000Z",
          status: "current",
          sitOutIds: [],
          warnings: [],
          courts: [
            { courtNumber: 1, teamA: ["p1", "p2"], teamB: ["p3", "p4"], score: null, status: "pending", locked: false, timerEndsAt: null },
            { courtNumber: 2, teamA: ["p5", "p6"], teamB: ["p7", "p8"], score: null, status: "pending", locked: false, timerEndsAt: null },
          ],
        },
      ],
      createdAt: "2026-08-30T17:00:00.000Z",
    });
  }

  if (withBooking) {
    database.bookings.push({
      id: "b1",
      date,
      startTime: "18:00",
      durationMinutes: 90,
      courtCount: 2,
      name: "Evening Rally",
      location: "Community Courts",
      notes: "",
      sessionId: withSession ? "s1" : null,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  }

  return database;
}

export async function seedDatabase(page, database, { authenticated = true, syncState = null } = {}) {
  await page.addInitScript(
    ({ dbKey, authKey, syncKey, syncField, authenticated: shouldAuthenticate, sync, value }) => {
      if (sessionStorage.getItem("pickleball.e2e.seeded") !== "1") {
        localStorage.setItem(dbKey, JSON.stringify(sync ? { ...value, [syncField]: sync } : value));
        localStorage.removeItem(syncKey);
        if (shouldAuthenticate) sessionStorage.setItem(authKey, "authenticated");
        else sessionStorage.removeItem(authKey);
        sessionStorage.setItem("pickleball.e2e.seeded", "1");
      }
    },
    { dbKey: DB_KEY, authKey: ADMIN_SESSION_KEY, syncKey: SUPABASE_SYNC_KEY, syncField: CLOUD_SYNC_FIELD, authenticated, sync: syncState, value: database },
  );
}

export function collectBrowserErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}