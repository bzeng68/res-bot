# Res-Bot

Automated reservation bot that books restaurant reservations the moment the
booking window opens, for **Resy** and **OpenTable**.

The two platforms work differently under the hood: Resy is booked directly
via its API from the backend, since a valid auth token is all that's needed.
OpenTable actively blocks headless/CDP-driven browsers, so those bookings
instead run through a Tampermonkey userscript in your own signed-in browser
tab — see [`tampermonkey/README.md`](tampermonkey/README.md) for details.

## Disclaimer

This tool is for **personal educational use only**. Using automated bots
violates the Terms of Service of both Resy and OpenTable. Use at your own risk.

## Features

- Restaurant search (Resy) or paste a restaurant link (OpenTable)
- Calendar-based date selection, flexible time range + priority-ordered preferred times
- Scheduler that sleeps until the booking window opens, then fires precisely
  (Resy: backend `setTimeout` + up to 5 retries; OpenTable: browser-side
  pre-navigation + reload right at the target moment — see
  [`tampermonkey/README.md`](tampermonkey/README.md))
- Real-time dashboard with live status updates and per-attempt logs
- Success/failure notifications
- AES-256 encrypted credential storage (Resy only — OpenTable needs none)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Backend

Reservations are stored in Firestore. For local dev, run the emulator instead
of pointing at real GCP:

```bash
gcloud emulators firestore start --host-port=localhost:8081
export FIRESTORE_EMULATOR_HOST=localhost:8081
```

Create `backend/.env` (see `backend/.env.example` for the full list, including
optional Cloud Tasks vars used in production — see [Deploying](#deploying)):

```env
PORT=3001
GCP_PROJECT_ID=any-placeholder-when-using-the-emulator
ENCRYPTION_KEY=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
```

### 3a. Resy: Get Your Auth Token

1. Open [resy.com](https://resy.com) and log in
2. Open DevTools (F12 or Cmd+Option+I) → **Network** tab
3. Search for any restaurant on Resy
4. Find any request to `api.resy.com`
5. Click it → **Headers** → copy the value of `x-resy-auth-token`

### 3b. OpenTable: Install the Browser Runner

OpenTable bookings run through a Tampermonkey userscript in your own browser
instead of the backend calling an API directly (OpenTable blocks
headless/automated browsers). Follow
[`tampermonkey/README.md`](tampermonkey/README.md) to install it and fill in
`OPENTABLE_RUNNER_TOKEN`/`INTERNAL_CALLBACK_TOKEN` — both must match the
values in `backend/.env`.

### 4. Start

```bash
npm run dev  # Backend: localhost:3001, Frontend: localhost:5173
```

### 5. Schedule a Booking

1. Open `http://localhost:5173`
2. Pick the **Resy** or **OpenTable** tab
3. Resy: search for a restaurant. OpenTable: paste the restaurant's OpenTable link
4. Select date, time range, party size, and (optionally) priority-ordered preferred times
5. Resy: paste your auth token. OpenTable: nothing else needed — just keep an
   `opentable.com` tab open and focused
6. Click **Schedule Reservation**

The scheduler fires automatically at the exact moment the booking window opens.

## How It Works

Both platforms share the same `targetDate − daysInAdvance` at `releaseTime`
booking-window computation (`scheduledPollTime`), but fire it differently.

**Resy booking flow:**

1. You create a reservation through the web UI
2. Backend computes the exact timestamp the booking window opens
3. A `setTimeout` fires 1 second after the window opens to account for clock skew
4. The bot calls the Resy API to find available slots matching your party size and time range
5. On first match: books immediately and broadcasts success to the dashboard
6. On transient error: retries up to 5 times with a 3s delay between attempts
7. Hard-stops immediately on `401`/`403` (expired or invalid token)

**Scheduler resilience:** A cron job runs every 10 seconds and picks up any jobs due within the next 10 minutes, so the scheduler recovers automatically after a server restart. Already-queued reservations are never double-scheduled.

**OpenTable booking flow:** driven by the Tampermonkey userscript, not the
backend — the backend only exposes `GET /api/opentable/jobs` (returns a job
once it's within 10s of `scheduledPollTime`) and
`POST /internal/reservation-status` (progress callbacks). The script
pre-navigates to the restaurant page ahead of time, reloads right at the
target moment, and drives party-size/date (via URL query params) → time
selection → seating-options → specials → confirmation. Full details in
[`tampermonkey/README.md`](tampermonkey/README.md).

## Architecture

```
res-bot/
├── frontend/         # React + TypeScript + Tailwind CSS (Vite)
│   └── src/components/
│       ├── BookingForm.tsx         # Resy/OpenTable tab toggle + 3-step wizard
│       ├── RestaurantSearch.tsx    # Resy restaurant search (step 1, Resy tab)
│       ├── OpenTableLinkInput.tsx  # Paste-a-link restaurant picker (step 1, OpenTable tab)
│       ├── DateSelector.tsx        # Calendar (step 2, shared)
│       ├── TimeSelector.tsx        # Time range + preferred times (step 3, shared)
│       └── Dashboard.tsx           # Reservation list, live status, per-attempt log
├── backend/
│   └── src/
│       ├── index.ts              # Control plane entry point: HTTP + WebSocket server
│       │                         # (also serves GET /api/opentable/jobs)
│       ├── worker.ts             # Worker entry point: fires one Resy reservation, then exits
│       ├── ws.ts                 # WebSocket state and broadcast helpers
│       ├── database.ts           # Firestore-backed storage (AES-256 encrypted Resy credentials;
│       │                         # OpenTable jobs carry none)
│       ├── scheduler/
│       │   ├── index.ts          # In-process cron scheduler (local dev fallback, Resy only)
│       │   ├── pipeline.ts       # Shared prewarm/fallback/fire logic — used by both
│       │   │                     # the in-process scheduler and the worker
│       │   └── poller.ts         # bookWithRetry — 5 attempts, 500ms apart
│       ├── routes/               # REST API routes
│       │   └── internal.ts       # Status callbacks from both the Resy worker and the
│       │                         # OpenTable Tampermonkey runner
│       ├── utils/
│       │   ├── tasksQueue.ts     # Cloud Tasks enqueue/cancel (Resy production deploys)
│       │   └── opentableJobs.ts  # isOpenTableJobDue() — the 10s lookahead-window gate
│       └── api/
│           └── resy-client.ts    # Resy API wrapper
├── tampermonkey/     # OpenTable browser runner (userscript) — see tampermonkey/README.md
├── shared/           # Shared TypeScript types
├── infra/            # Terraform + Dockerfiles for the GCP deployment — see infra/README.md
└── .github/
    └── workflows/
        └── test.yml  # CI — runs on every push / pull request
```

**Tech Stack:**
- Frontend: React + TypeScript + Tailwind CSS + Vite
- Backend: Node.js + Express + `ws` + `node-cron`
- Storage: Firestore, with AES-256 encrypted Resy credentials
- Resy: reverse-engineered public API, called directly from the backend
- OpenTable: no API — booked via a Tampermonkey userscript driving your own
  signed-in browser session (see [`tampermonkey/README.md`](tampermonkey/README.md))

## Deploying

Locally, `npm run dev` runs everything in one process with an in-process
cron scheduler. In production (see `infra/`), the control plane and a
separate ephemeral worker service run on Cloud Run: the control plane
enqueues a Cloud Task ~15 minutes before each **Resy** reservation's booking
window opens, and the worker wakes up, fires the booking, and exits — so
nothing sits idle (and billing) between reservations. See `infra/README.md`
for setup and `infra/docker/` for the two services' Dockerfiles.

**OpenTable reservations skip this entirely** — no Cloud Task is enqueued,
and there's nothing for the worker to do. The deployed control plane only
needs to be reachable so your local Tampermonkey runner can poll it; the
actual booking runs on your machine, not in the cloud.

## Testing

```bash
cd backend && npm test        # Mocha + Chai + Sinon + esmock
cd tampermonkey && npm test   # Node's built-in test runner, no dependencies
```

Backend tests live in `backend/tests/`. CI runs the backend suite automatically on every push via GitHub Actions.

**Backend coverage:**
- `getFireTime` — past/future computation and millisecond delay accuracy
- `checkAndScheduleJobs` — immediate scheduling, future scheduling, 10-minute horizon cutoff, no double-scheduling, skips completed reservations
- `isOpenTableJobDue` — lookahead-window gating for the OpenTable runner's job feed

**Tampermonkey coverage:** URL building (including the preferred-time anchor
and multi-anchor sweep logic), time-label formatting, confirmation-code
extraction, stage-selector routing, fire-delay computation. DOM click
behavior against OpenTable's live page isn't unit-testable and is verified
by running the script for real.

## Troubleshooting

**Resy: bookings fail with 401/403**
Auth token has expired — get a fresh one from the Network tab and reschedule.

**Resy: bookings fail with 400 (invalid party size)**
The restaurant may not offer that party size; verify on resy.com directly.

**OpenTable: job never gets picked up**
Confirm an `opentable.com` tab is open, the userscript is enabled, and (Chrome)
"Allow User Scripts" is on for Tampermonkey (`chrome://extensions` →
Tampermonkey → Details) — this permission is separate from the extension
being enabled, and scripts silently never run without it.

**OpenTable: stuck partway through booking**
Check that tab's console for `[OpenTableRunner]` logs, and try the
Tampermonkey menu's "clear stuck job" command — see
[`tampermonkey/README.md`](tampermonkey/README.md#debugging).

**Resy: no slots found but restaurant shows availability**
Broaden your time window or verify the party size is offered on Resy.

**Backend won't start / port in use**

```bash
lsof -ti :3001 | xargs kill -9
```

## License

MIT — For educational purposes only
