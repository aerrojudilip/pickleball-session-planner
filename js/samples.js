// samples.js — first-run seed data loader.
//
// Loads 12 clearly-labeled sample players so the app is explorable on first
// visit. Falls back to an inline list if the JSON file can't be fetched (e.g.
// opened from a context where fetch of a relative file fails).

import { createEmptyDatabase, createPlayer } from "./schema.js";

const FALLBACK = [
  { name: "Alex Rivera", rating: 3.5 },
  { name: "Bailey Chen", rating: 4.0 },
  { name: "Cameron Diaz", rating: 3.0 },
  { name: "Dakota Singh", rating: 4.5 },
  { name: "Emerson Park", rating: 2.5 },
  { name: "Finley Brooks", rating: 3.5 },
  { name: "Gray Morales", rating: 4.0 },
  { name: "Harper Nguyen", rating: 3.0 },
  { name: "Indira Kaur", rating: 5.0 },
  { name: "Jordan Blake", rating: 3.5 },
  { name: "Kai Anderson", rating: 2.5 },
  { name: "Logan Reyes", rating: 4.0 },
];

export async function bootstrapSamples() {
  const db = createEmptyDatabase();
  let list = FALLBACK;
  try {
    const res = await fetch("./data/sample-players.json", { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.players) && data.players.length) {
        const customNames = new Set(data.players.map((player) => String(player.name || "").trim().toLocaleLowerCase()));
        const supplements = FALLBACK.filter((player) => !customNames.has(player.name.toLocaleLowerCase()));
        list = data.players.length >= FALLBACK.length
          ? data.players
          : [...data.players, ...supplements].slice(0, FALLBACK.length);
      }
    }
  } catch {
    /* use fallback */
  }
  db.players = list.map((p) =>
    createPlayer({ name: p.name, rating: p.rating, notes: p.notes || "Sample player", isSample: true }),
  );
  return db;
}
