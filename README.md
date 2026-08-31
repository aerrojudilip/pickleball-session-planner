# Pickleball Session Planner

A static, offline-first web app for managing pickleball players, booking court time, generating fair rotations, entering scores, and reviewing session statistics. It uses plain HTML, CSS, and JavaScript modules and can be hosted directly from a GitHub Pages repository.

## Features

- Persistent players with ratings, notes, active status, and sample data
- Day/week court-booking calendar linked to play sessions
- Seeded, constrained round generation for 1-12 courts
- Random, balanced, king-of-the-court, and fixed-partner modes
- Fair sit-outs, hard pair constraints, editable scheduler weights, and locked courts
- Tap-to-swap round editing with undo/redo
- Score validation, skipped games, per-court timers, and full-screen display mode
- All-time and per-session statistics, chemistry, head-to-head records, and repeat heatmaps
- Full session history with confirmed deletion, print layouts, and JSON/CSV/text exports
- Supabase multi-device persistence, local offline cache, optional GitHub backup, and schema-checked imports
- Installable PWA with an offline app shell and light/dark themes
- Session-scoped administrator access through the More tab for cloud sync and protected settings

## Administrator Access

Players, Schedule, Play, and Stats open without a login. Only the More tab displays administrator sign-in. The username is `admin`; when Supabase is configured, it maps to the Auth user named in [js/config.js](js/config.js). Authentication lasts for the current browser tab and can be ended with the lock button in the header. In a cloud-configured deployment, player and session changes require authentication. Starting, scoring, editing, or deleting a session while signed out opens More and resumes the action after sign-in. Other changes made while signed out remain in the browser's offline queue until an administrator signs in through More; Supabase rejects anonymous cloud writes.

Supabase Auth issues the session token and Row Level Security enforces administrator-only inserts and updates at the database. The browser never receives the database password, a password-derived verifier, or a service-role key. If Supabase is left unconfigured, public statistics and existing cached data remain readable, but administrator actions cannot be unlocked unless a host application explicitly injects its own authentication provider.

## Configure The Free Database

1. Create a free project at [supabase.com](https://supabase.com). Enter the generated database password directly in Supabase and keep it outside this repository.
2. Open **SQL Editor** in the project, paste [supabase/schema.sql](supabase/schema.sql), and run it once. This creates the single JSONB document table, version checks, grants, and RLS policies.
3. Open **Authentication > Users**, select **Add user**, and create `admin@pickleball-planner.app`. Set it to the administrator password agreed for this deployment and mark the email confirmed. Passwords belong only in Supabase Auth, never in source control.
4. Open **Project Settings > API** and copy the **Project URL** and **Publishable key**. A legacy `anon` key also works. Do not copy the `service_role` key.
5. Put only those public values into [js/config.js](js/config.js):

```js
const deployedConfig = {
  url: "https://YOUR-PROJECT-REF.supabase.co",
  anonKey: "YOUR-PUBLISHABLE-KEY",
  adminEmail: "admin@pickleball-planner.app",
  stateId: "primary",
};

export const SUPABASE_CONFIG = Object.freeze(deployedConfig);
```

6. Commit and deploy the configuration. Open the app, sign in as `admin`, and select **More > Cloud database > Sync now**. If the table is empty, the first administrator sign-in also uploads the current browser database automatically.

The supplied read policy is public so players and read-only statistics can load on any device without a login. Because the app stores one complete JSON document, player names, notes, bookings, sessions, and scores are consequently readable through the public API. Do not put confidential information in this deployment. For private data, remove `anon` from the select grant and policy in [supabase/schema.sql](supabase/schema.sql); public data will then require authentication too.

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

### Primary: Supabase

When configured, Supabase is the shared source of truth. Startup loads the remote JSONB document before the browser cache unless that cache contains pending offline changes. A markerless cache from an older release is treated as pending during the first cloud-enabled startup, so migration cannot silently replace it. Cloud writes are debounced, serialized, and sent with the administrator's Auth token. A monotonically increasing version prevents a stale device from silently overwriting a newer document. After a conflict, export the browser copy if it is needed, or choose **Reload cloud data** and explicitly confirm that its pending changes may be discarded.

The free tier is sufficient for this app's single-document workload. Auth credentials and tokens are not part of the application database or JSON exports.

### Offline Cache: Browser Storage

The complete database is also cached as JSON in `localStorage` under `pickleball.db.v1`. Every mutation atomically stores the document with its internal cloud version and pending marker; failed writes are retried when the page is hidden. If Supabase cannot be reached, startup uses this cache and failed cloud writes remain safe locally. Internal sync metadata is omitted from exports. Browser storage belongs to one browser profile on one device; clearing site data removes the cache.

Use **More > Data backup > Export all data** regularly. Imports support merge or replace and reject unsupported schema versions. GitHub credentials are kept under a separate key and are never included in data exports.

### Optional: GitHub Repository Backup

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

## PWA And Offline Use

Visit the deployed app once while online so the service worker can cache the app shell. Supported browsers can then install it from their normal **Install app** or **Add to Home Screen** action. Offline mode covers the application itself and cached data; Supabase synchronization and GitHub backup require a network connection.

When a new service worker finishes installing, the app shows **A new version is ready**. Select **Update** to activate it and reload. If a browser has retained a much older development worker, clear this site's storage/service worker once and reload online.

Service workers require HTTPS, except that browsers also allow them on `localhost` and `127.0.0.1`.

## Data Model

All durable application data is JSON with `schemaVersion: 1`. Player IDs, rather than names, are used as references in sessions, bookings, rounds, scores, and pair constraints, so players can be renamed without damaging history.

Players are stored in the Supabase `public.app_state` row under `document.players`. Each authenticated cloud save writes the complete versioned document, so player additions, edits, active status, ratings, and notes are available in new browsers and on other devices.

Sessions are stored in the same row under `document.sessions`, including their player IDs, rounds, assignments, scores, locks, and status. Deleting a session removes it from the shared document but keeps any linked court booking and clears that booking's session link.

The default first run loads 12 clearly marked sample players. **Players > Clear samples** removes them in one undoable action.
