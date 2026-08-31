# Pickleball Session Planner

A static, cloud-backed web app for managing pickleball players, booking court time, generating fair rotations, entering scores, and reviewing session statistics. It uses plain HTML, CSS, and JavaScript modules and can be hosted directly from a GitHub Pages repository.

## Features

- Persistent players with ratings, notes, active status, and sample data
- Day/week court-booking calendar linked to play sessions
- Player attendance replies (Going, Maybe, Not going) on any booked court, with no login
- Seeded, constrained round generation for 1-12 courts
- Random, balanced, king-of-the-court, and fixed-partner modes
- Fair sit-outs, hard pair constraints, editable scheduler weights, and locked courts
- Tap-to-swap round editing with undo/redo
- Score validation, skipped games, per-court timers, and full-screen display mode
- All-time and per-session statistics, chemistry, head-to-head records, and repeat heatmaps
- Full session history with confirmed deletion, print layouts, and JSON/CSV/text exports
- Supabase-only multi-device data persistence, optional GitHub backup, and schema-checked imports
- Installable PWA with an offline app shell and light/dark themes
- Session-scoped administrator access through the More tab for cloud sync and protected settings

## Administrator Access

Players, Schedule, Play, and Stats open without a login. Only the More tab displays administrator sign-in. The username is `admin`; when Supabase is configured, it maps to the Auth user named in [js/config.js](js/config.js). Authentication lasts for the current browser tab and can be ended with the lock button in the header. In a cloud-configured deployment, player, booking, session, and settings changes require authentication. Starting one of these changes while signed out opens More and resumes the intended action after sign-in. Supabase rejects anonymous writes to the planner document.

Attendance replies are the one deliberate exception: any visitor can answer Going, Maybe, or Not going for a booked court. See [Attendance Replies](#attendance-replies).

Supabase Auth issues the session token and Row Level Security enforces administrator-only inserts and updates at the database. The browser never receives the database password, a password-derived verifier, or a service-role key. If Supabase is left unconfigured, public statistics and existing cached data remain readable, but administrator actions cannot be unlocked unless a host application explicitly injects its own authentication provider.

## Configure The Free Database

1. Create a free project at [supabase.com](https://supabase.com). Enter the generated database password directly in Supabase and keep it outside this repository.
2. Open **SQL Editor** in the project, paste [supabase/schema.sql](supabase/schema.sql), and run it once. This creates the single JSONB document table, the attendance replies table, version checks, grants, and RLS policies. Re-run the whole file after upgrading an existing deployment: it is idempotent, and attendance replies do not work until `public.booking_rsvps` exists.
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

6. Commit and deploy the configuration. Open the app and sign in as `admin`. If the table is empty, the first administrator sign-in initializes it with the built-in sample players. Use **More > Cloud database > Sync now** to request an immediate save after later changes.

The supplied read policy is public so players and read-only statistics can load on any device without a login. Because the app stores one complete JSON document, player names, notes, bookings, sessions, and scores are consequently readable through the public API. Do not put confidential information in this deployment. For private data, remove `anon` from the select grant and policy in [supabase/schema.sql](supabase/schema.sql); public data will then require authentication too.

## Attendance Replies

Every booked court on the **Schedule** tab collects attendance. Tap a booking block, then **Who's coming?**. Pick a name from the roster and answer **Going**, **Maybe**, or **Not going**. Replying again replaces the previous answer rather than adding a second one.

- No sign-in is needed. Anyone with the app URL can reply, which is the point: players answer on their own phones.
- The chosen name is remembered on that device, so a returning player only taps their answer.
- The dialog lists everyone grouped by answer, including who has not replied yet.
- Calendar blocks show a check mark and the going count, and the printed week gains a **Going** column.
- Starting a session from a booking preselects whoever replied **Going**. If nobody has replied, the full active roster is preselected as before.
- Deleting a booking (an administrator action) also deletes its replies.

Replies are stored in `public.booking_rsvps`, one row per booking and player, separate from the planner document. Only the administrator can write the planner document; anyone may insert or update an attendance row, and only the administrator may delete one. Answers are constrained to the three values by a database check, and the calendar and picker only ever offer real bookings and real players.

There is no per-player password, so a name picker is exactly as trustworthy as the group holding the link: whoever selects a name can set that name's answer. That trade-off is deliberate for a club planner. Treat attendance as a roll call, not an authenticated record, and do not deploy this to an untrusted audience.

Where Supabase is not configured, replies fall back to that browser's `localStorage` under `pickleball.rsvps.v1` and stay on the one device. The remembered name lives in `pickleball.rsvp.identity.v1`.

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

When configured, Supabase is the only durable application data store. Every startup deletes legacy planner data and sync markers from browser storage, then loads the remote JSONB document. If Supabase is unavailable, the app does not fall back to stale browser records. Cloud writes are debounced, serialized, and sent with the administrator's Auth token. A monotonically increasing version prevents a stale page from overwriting a newer document; if another device saves first, the stale page automatically reloads the latest database instead of showing a browser-data conflict prompt.

The free tier is sufficient for this app's single-document workload. Auth credentials and tokens are not part of the application database or JSON exports.

### Standalone Mode: Browser Storage

Browser database storage is active only when Supabase has not been configured, such as an explicitly standalone development build. In that mode, the complete database is stored as JSON in `localStorage` under `pickleball.db.v1`. The deployed cloud configuration neither reads nor writes this planner key except to delete data left by older releases.

Use **More > Data backup > Export all data** regularly. Imports support merge or replace and reject unsupported schema versions. Supabase Auth tokens remain in session storage for authentication, and optional GitHub credentials use a separate browser key; neither is application data nor included in exports.

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

Visit the deployed app once while online so the service worker can cache the app shell. Supported browsers can then install it from their normal **Install app** or **Add to Home Screen** action. The shell can open offline, but players, bookings, sessions, scores, statistics, and settings require a Supabase connection and are not stored by the service worker.

When a new service worker finishes installing, the app shows **A new version is ready**. Select **Update** to activate it and reload. If a browser has retained a much older development worker, clear this site's storage/service worker once and reload online.

Service workers require HTTPS, except that browsers also allow them on `localhost` and `127.0.0.1`.

## Data Model

All durable application data is JSON with `schemaVersion: 1`. Player IDs, rather than names, are used as references in sessions, bookings, rounds, scores, and pair constraints, so players can be renamed without damaging history.

Players are stored in the Supabase `public.app_state` row under `document.players`. Each authenticated cloud save writes the complete versioned document, so player additions, edits, active status, ratings, and notes are available in new browsers and on other devices.

Sessions are stored in the same row under `document.sessions`, including their player IDs, rounds, assignments, scores, locks, and status. Deleting a session removes it from the shared document but keeps any linked court booking and clears that booking's session link.

Attendance replies are the one piece of durable data kept outside the document, in `public.booking_rsvps`, because every visitor may write their own reply. They are keyed by booking ID and player ID, are not part of JSON exports, and are removed with their booking.

The default first run loads 12 clearly marked sample players. **Players > Clear samples** removes them in one undoable action.
