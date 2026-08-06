# Res-Bot

Automated reservation bot for Resy that books restaurant reservations the moment the booking window opens.

## Disclaimer

This tool is for **personal educational use only**. Using automated bots violates the Terms of Service of Resy. Use at your own risk.

## Features

- Restaurant search
- Calendar-based date selection
- Flexible time range selection
- Scheduler that sleeps until the booking window opens, then fires with up to 5 retries
- Real-time dashboard with live status updates
- Success/failure notifications
- AES-256 encrypted credential storage

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

### 3. Get Your Resy Auth Token

1. Open [resy.com](https://resy.com) and log in
2. Open DevTools (F12 or Cmd+Option+I) → **Network** tab
3. Search for any restaurant on Resy
4. Find any request to `api.resy.com`
5. Click it → **Headers** → copy the value of `x-resy-auth-token`

### 4. Start

```bash
npm run dev  # Backend: localhost:3001, Frontend: localhost:5173
```

### 5. Schedule a Booking

1. Open `http://localhost:5173`
2. Search for a restaurant
3. Select date, time range, and party size
4. Paste your auth token
5. Click **Schedule Booking**

The scheduler fires automatically at the exact moment the booking window opens.

## How It Works

**Booking Flow:**

1. You create a reservation through the web UI
2. Backend computes the exact timestamp the booking window opens (`targetDate − daysInAdvance` at `releaseTime`)
3. A `setTimeout` fires 1 second after the window opens to account for clock skew
4. The bot calls the Resy API to find available slots matching your party size and time range
5. On first match: books immediately and broadcasts success to the dashboard
6. On transient error: retries up to 5 times with a 3s delay between attempts
7. Hard-stops immediately on `401`/`403` (expired or invalid token)

**Scheduler resilience:** A cron job runs every 10 seconds and picks up any jobs due within the next 10 minutes, so the scheduler recovers automatically after a server restart. Already-queued reservations are never double-scheduled.

## Architecture

```
res-bot/
├── frontend/         # React + TypeScript + Tailwind CSS (Vite)
├── backend/
│   └── src/
│       ├── index.ts              # Control plane entry point: HTTP + WebSocket server
│       ├── worker.ts             # Worker entry point: fires one reservation, then exits
│       ├── ws.ts                 # WebSocket state and broadcast helpers
│       ├── database.ts           # Firestore-backed storage (AES-256 encrypted credentials)
│       ├── scheduler/
│       │   ├── index.ts          # In-process cron scheduler (local dev fallback)
│       │   ├── pipeline.ts       # Shared prewarm/fallback/fire logic — used by both
│       │   │                     # the in-process scheduler and the worker
│       │   └── poller.ts         # bookWithRetry — 5 attempts, 500ms apart
│       ├── routes/               # REST API routes (+ internal.ts: worker status callback)
│       ├── utils/
│       │   └── tasksQueue.ts     # Cloud Tasks enqueue/cancel (production deploys)
│       └── api/
│           └── resy-client.ts    # Resy API wrapper
├── shared/           # Shared TypeScript types
├── infra/            # Terraform + Dockerfiles for the GCP deployment — see infra/README.md
└── .github/
    └── workflows/
        └── test.yml  # CI — runs on every push / pull request
```

**Tech Stack:**
- Frontend: React + TypeScript + Tailwind CSS + Vite
- Backend: Node.js + Express + `ws` + `node-cron`
- Storage: Firestore, with AES-256 encrypted credentials
- API: Resy public API (reverse-engineered)

## Deploying

Locally, `npm run dev` runs everything in one process with an in-process
cron scheduler. In production (see `infra/`), the control plane and a
separate ephemeral worker service run on Cloud Run: the control plane
enqueues a Cloud Task ~15 minutes before each reservation's booking window
opens, and the worker wakes up, fires the booking, and exits — so nothing
sits idle (and billing) between reservations. See `infra/README.md` for
setup and `infra/docker/` for the two services' Dockerfiles.

## Testing

```bash
cd backend && npm test
```

Tests live in `backend/src/tests/` and use Mocha + Chai + Sinon + esmock. CI runs automatically on every push via GitHub Actions.

**Coverage:**
- `getFireTime` — past/future computation and millisecond delay accuracy
- `checkAndScheduleJobs` — immediate scheduling, future scheduling, 10-minute horizon cutoff, no double-scheduling, skips completed reservations

## Troubleshooting

**Bookings fail with 401/403**
Auth token has expired — get a fresh one from the Network tab and reschedule.

**Bookings fail with 400 (invalid party size)**
The restaurant may not offer that party size; verify on resy.com directly.

**No slots found but restaurant shows availability**
Broaden your time window or verify the party size is offered on Resy.

**Backend won't start / port in use**

```bash
lsof -ti :3001 | xargs kill -9
```

## License

MIT — For educational purposes only
