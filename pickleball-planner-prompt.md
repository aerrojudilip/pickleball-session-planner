# Build Prompt: Pickleball Session Planner (Static Web App)

Copy everything below the line into Claude Code, Cursor, v0, or any AI coding tool.

---

## Role

You are a senior frontend engineer. Build a complete, production-quality **Pickleball Session Planner** web app that runs entirely in the browser and is hosted free on GitHub Pages.

## Hard constraints

- **100% static.** No server, no build-time secrets, no paid services. Must run from `https://<user>.github.io/<repo>/`.
- **Single-page app.** Plain HTML + CSS + vanilla JavaScript (ES modules), OR React + Vite with `base` configured for GitHub Pages. Prefer no framework unless React meaningfully simplifies state.
- **No external CSS/JS frameworks required.** If you use one, load it from a CDN and make the app degrade gracefully offline.
- **Mobile-first.** Most people will use this on a phone, at the courts, one-handed, in sunlight. Large tap targets, high contrast.
- All data is JSON. Never invent a binary format.

## Core requirements

1. **Session setup screen**
   - Date picker (defaults to today).
   - Optional session name and location.
   - Number of courts (1–12).
   - Player selection: pick from a saved roster via checkboxes/chips, or add new players inline.
   - Show a live summary: "14 players, 3 courts, 12 playing, 2 sitting out per round."

2. **Round generation**
   - Each court holds exactly **4 players = 2 teams of 2**.
   - Courts used = `min(courtCount, floor(activePlayers / 4))`.
   - Leftover players sit out that round.
   - Assignment is **randomized**, but constrained so that **players do not repeat the same partner or the same opponents in consecutive rounds** wherever mathematically possible.
   - Generate one round at a time, or pre-generate N rounds for the whole session.

3. **Score entry**
   - After each round, prompt for each court's score (e.g. `11 – 7`).
   - Configurable rules: target score (11 / 15 / 21), win-by-2 on/off, hard cap on/off.
   - Validate scores against the rules; warn rather than block on unusual entries.
   - Allow skipping a court (game not played / abandoned).

4. **Persistence**
   - Everything stored as JSON. See the data model below.
   - See the persistence section for the three storage tiers.

## Assignment algorithm (implement exactly)

Do not use a naive shuffle. Use **constrained randomized optimization**:

**Step 1 — choose sit-outs.** Rank active players by `sitOutCount` ascending, break ties randomly, and sit out the players with the *most* sit-outs last. Nobody sits twice before everyone sits once.

**Step 2 — generate candidate assignments.** Run K random restarts (K ≈ 500; it's milliseconds). For each restart, shuffle the playing pool and slice into courts and teams.

**Step 3 — score each candidate** with a cost function (lower is better):

```
cost =
    w1 * Σ partnerRepeatPenalty(a, b)     // same partner as before
  + w2 * Σ opponentRepeatPenalty(a, b)    // faced each other before
  + w3 * Σ |teamSkillA - teamSkillB|      // team imbalance (balanced mode only)
  + w4 * Σ courtRepeatPenalty(player)     // stuck on the same court
  + w5 * Σ crossCourtSkillSpread          // keeps courts roughly level
```

Weight repeats in the **immediately previous round** far more heavily than repeats from earlier rounds (e.g. penalty `10` for last round, `1` for any earlier round). Expose the weights in a settings panel.

**Step 4 — hard constraints** (reject the candidate outright, never soft-penalize):
- `mustNotPair` pairs (e.g. a couple who want to split up).
- `mustPair` pairs (fixed partners for a ladder or a lesson).
- Inactive players never assigned.

**Step 5 — pick the lowest-cost candidate.** If every candidate violates a hard constraint, relax `mustPair` first, then report clearly to the user why a perfect round isn't possible.

Support a **seeded RNG** (e.g. mulberry32) so a given seed reproduces a given schedule — useful for debugging and for regenerating a session identically.

## Extra features to include

**Roster and player management**
- Persistent player roster with name, optional skill rating (DUPR-style 2.0–5.5), and notes.
- Mark players active/inactive mid-session for late arrivals and early departures — the next round adapts automatically.
- Avatar initials with auto-assigned colors so courts are scannable at a glance.

**Scheduling modes**
- *Pure random* — maximum mixing, ignores skill.
- *Balanced* — minimizes team skill differential within each court.
- *Tiered / king-of-the-court* — stronger players on court 1, descending; winners move up a court, losers move down.
- *Fixed partners* — teams stay together, only opponents rotate.

**Round editing**
- Manually swap two players between courts by tap-tap (or drag and drop on desktop); the app recalculates fairness stats live.
- **Lock a court** so regenerating the round leaves it untouched.
- Undo / redo for the last 20 actions.

**Live session view**
- Big-screen "display mode": full-screen court cards, huge type, readable from across the court. Good for a tablet propped on a bench.
- Optional per-court countdown timer for timed rotation play, with an audible end signal.
- One-tap "next round" that closes out scores and generates the following round.

**Stats and leaderboard**
- Per-session and all-time: games played, wins, losses, win %, points for, points against, point differential.
- Sit-out counter so you can prove the rotation was fair.
- **Partner chemistry**: win rate with each partner.
- **Head-to-head**: record against each opponent.
- A partner/opponent **repeat matrix** heatmap so you can see the mixing quality at a glance.
- Session history browser: pick a past date, see the full schedule and results.

**Data portability**
- Export the whole database as a downloadable `.json` file.
- Export a single session as JSON or CSV.
- Import a JSON file with a merge-or-replace choice and a schema-version check.
- Copy a plain-text round summary to the clipboard for pasting into WhatsApp/GroupMe.

**Quality of life**
- Dark mode and light mode, following the OS setting by default.
- PWA manifest + service worker so it installs to the home screen and works offline at courts with bad signal.
- Print stylesheet for a paper schedule.
- Full keyboard navigation and ARIA labels.
- Confirmation before any destructive action; nothing is deleted without an undo window.

## Persistence: three tiers

**Tier 1 — default, zero setup.** `localStorage` under key `pickleball.db.v1`, holding the full JSON document. Write on every mutation, debounced. Plus manual JSON export/import.

**Tier 2 — optional real JSON files in the repo.** A settings panel where the user pastes a GitHub fine-grained personal access token (scoped to *one* repo, `contents: write`). The app then commits sessions to `data/sessions/YYYY-MM-DD-<id>.json` and `data/players.json` via the GitHub REST Contents API. Requirements:
- Store the token in `localStorage` only; never in the repo, never in a URL.
- Show a clear warning that a browser-held token is visible to anyone with access to that device, and recommend a private repo plus a short expiry.
- Handle 409 conflicts by re-fetching the file SHA and retrying once.
- Everything must still work fully with Tier 2 disabled.

**Tier 3 — mention in the README as future options**, don't build: GitHub Gist API, Cloudflare Workers + KV, or Supabase free tier for multi-device sync.

## Data model

```json
{
  "schemaVersion": 1,
  "settings": {
    "targetScore": 11,
    "winByTwo": true,
    "hardCap": null,
    "mode": "random",
    "weights": { "partnerRepeat": 10, "opponentRepeat": 4, "skillBalance": 3, "courtRepeat": 2 }
  },
  "players": [
    {
      "id": "p_a1b2",
      "name": "Dilip",
      "rating": 3.5,
      "active": true,
      "notes": "",
      "createdAt": "2026-08-30T14:00:00Z"
    }
  ],
  "constraints": {
    "mustPair": [["p_a1b2", "p_c3d4"]],
    "mustNotPair": [["p_e5f6", "p_g7h8"]]
  },
  "sessions": [
    {
      "id": "s_20260830_01",
      "date": "2026-08-30",
      "name": "Saturday Open Play",
      "location": "Frisco Athletic Center",
      "courtCount": 3,
      "playerIds": ["p_a1b2", "p_c3d4"],
      "seed": 1837462,
      "rounds": [
        {
          "roundNumber": 1,
          "startedAt": "2026-08-30T14:05:00Z",
          "sitOutIds": ["p_x9y8"],
          "courts": [
            {
              "courtNumber": 1,
              "teamA": ["p_a1b2", "p_c3d4"],
              "teamB": ["p_e5f6", "p_g7h8"],
              "score": { "a": 11, "b": 7 },
              "status": "completed",
              "locked": false
            }
          ]
        }
      ]
    }
  ]
}
```

Player IDs, never names, as foreign keys — names must be renameable without corrupting history.

## Suggested file structure

```
/
├── index.html
├── manifest.webmanifest
├── sw.js
├── css/styles.css
├── js/
│   ├── app.js            # bootstrap, routing between views
│   ├── state.js          # single store + subscribe/notify
│   ├── storage.js        # localStorage + import/export
│   ├── github.js         # Tier 2 commit adapter
│   ├── scheduler.js      # sit-outs, candidate generation, cost function
│   ├── stats.js          # leaderboard, chemistry, head-to-head
│   ├── rng.js            # seeded PRNG
│   └── ui/               # one module per view
├── data/
│   ├── players.json      # seeded empty, used by Tier 2
│   └── sessions/
├── tests/scheduler.test.js
└── README.md
```

## Deliverables

1. All source files, complete and runnable — no `TODO` stubs.
2. `scheduler.js` with clear comments explaining the cost function.
3. Unit tests for the scheduler covering: 4 / 8 / 13 / 15 players, sit-out fairness across 10 rounds, no consecutive-round partner repeats when ≥8 players, and hard-constraint enforcement.
4. A `README.md` with exact GitHub Pages deployment steps (create repo → push → Settings → Pages → deploy from `main` / root), plus the Tier 2 token setup and its security caveat.
5. Seed data: 12 sample players so the app is explorable on first load, clearly labeled and one-tap clearable.

## Acceptance criteria

- With 14 players and 3 courts, generating 8 rounds produces zero consecutive-round partner repeats and a sit-out count spread of at most 1 across all players.
- Refreshing the browser loses nothing.
- Exported JSON re-imports to an identical application state.
- The app is fully usable on a 375px-wide viewport.
- Adding a player mid-session correctly includes them from the next round onward.
- No console errors. No unhandled promise rejections.

## Build order

Build and verify in this sequence, showing me working code at each checkpoint: roster → session setup → scheduler + round display → score entry → localStorage → stats/leaderboard → export/import → editing/locking/undo → display mode + PWA → GitHub API tier → tests + README.

Ask me any clarifying questions before you start writing code.
