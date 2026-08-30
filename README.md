# Pickleball Session Planner

A static, offline-first web app for managing a pickleball roster, booking court time, generating fair rotations, entering scores, and reviewing session statistics. It uses plain HTML, CSS, and JavaScript modules and can be hosted directly from a GitHub Pages repository.

## Features

- Persistent player roster with ratings, notes, active status, and sample data
- Day/week court-booking calendar linked to play sessions
- Seeded, constrained round generation for 1-12 courts
- Random, balanced, king-of-the-court, and fixed-partner modes
- Fair sit-outs, hard pair constraints, editable scheduler weights, and locked courts
- Tap-to-swap round editing with undo/redo
- Score validation, skipped games, per-court timers, and full-screen display mode
- All-time and per-session statistics, chemistry, head-to-head records, and repeat heatmaps
- Full session history, print layouts, and JSON/CSV/text exports
- Local JSON persistence, optional GitHub repository backup, and schema-checked imports
- Installable PWA with an offline app shell and light/dark themes

## Run Locally

Requirements: Node.js 20 or newer.

```powershell
npm install
npm start
```

Open `http://localhost:5173`. The included server uses correct module and manifest MIME types and allows service-worker testing on localhost.

Run the unit tests:

```powershell
npm test
```

Run the Playwright browser journeys:

```powershell
npm run test:e2e:install
npm run test:e2e
```

The browser suite starts the local server automatically and covers the 375px layout, persistence, bookings, sessions, display mode, timers, GitHub request isolation, printing, and offline behavior.

## Deploy To GitHub Pages

1. Create an empty repository on GitHub. Do not initialize it with another README or `.gitignore` if this folder is already under Git.
2. From this project folder, commit and push the app to the repository's `main` branch:

```powershell
git init
git add .
git commit -m "Deploy Pickleball Session Planner"
git branch -M main
git remote add origin https://github.com/YOUR-USER/YOUR-REPOSITORY.git
git push -u origin main
```

3. On GitHub, open the repository and select **Settings**.
4. Select **Pages** in the sidebar.
5. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
6. Select the `main` branch and the `/(root)` folder, then select **Save**.
7. Wait for the Pages deployment to finish. The app will be available at:

```text
https://YOUR-USER.github.io/YOUR-REPOSITORY/
```

All application URLs are relative, and `.nojekyll` is included, so no build step or Pages workflow is required.

## Storage And Backups

### Tier 1: Browser Storage

The complete database is stored as JSON in `localStorage` under `pickleball.db.v1`. Changes are saved after every mutation with a short debounce and flushed when the page is hidden. Browser storage belongs to one browser profile on one device; clearing site data removes it.

Use **More > Data backup > Export all data** regularly. Imports support merge or replace and reject unsupported schema versions. GitHub credentials are kept under a separate key and are never included in data exports.

### Tier 2: GitHub Repository Backup

GitHub backup is optional. The rest of the app remains fully functional when it is disabled.

For the safest setup:

1. Create a separate **private** GitHub repository for the data.
2. In GitHub, open **Settings > Developer settings > Personal access tokens > Fine-grained tokens** and select **Generate new token**.
3. Choose a short expiration date.
4. Under **Repository access**, select **Only select repositories** and choose only the data repository.
5. Under **Repository permissions**, grant **Contents: Read and write**. Do not grant unrelated permissions.
6. In the app, open **More > GitHub backup (optional)**.
7. Enter the repository owner, repository name, branch, and token. Select **Test connection**, then **Sync now**.

A sync writes:

```text
data/players.json
data/sessions/YYYY-MM-DD-<session-id>.json
```

Existing files are updated with their current SHA. A `409 Conflict` causes one SHA refresh and one retry. Unchanged files are skipped.

The token is stored only in this browser's `localStorage`; it is never placed in the repository, an export, or a request URL. It is still readable by anyone who can access this browser profile or run code on the app's origin. Prefer a private data repository, use the shortest practical expiry, revoke lost tokens promptly, and avoid this option on shared devices. Data synced to a public repository is public.

### Tier 3: Future Multi-Device Options

These options are intentionally not implemented in this static release:

- GitHub Gist API
- Cloudflare Workers with KV
- Supabase free tier

Any future sync layer should add authentication, conflict semantics, and migration handling without weakening local-only operation.

## PWA And Offline Use

Visit the deployed app once while online so the service worker can cache the app shell. Supported browsers can then install it from their normal **Install app** or **Add to Home Screen** action. Offline mode covers the application itself and local data; GitHub backup still requires a network connection.

When a new service worker finishes installing, the app shows **A new version is ready**. Select **Update** to activate it and reload. If a browser has retained a much older development worker, clear this site's storage/service worker once and reload online.

Service workers require HTTPS, except that browsers also allow them on `localhost` and `127.0.0.1`.

## Data Model

All durable application data is JSON with `schemaVersion: 1`. Player IDs, rather than names, are used as references in sessions, bookings, rounds, scores, and pair constraints, so players can be renamed without damaging history.

The default first run loads 12 clearly marked sample players. **Roster > Clear samples** removes them in one undoable action.
