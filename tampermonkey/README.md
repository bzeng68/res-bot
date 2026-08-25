# OpenTable Runner (Tampermonkey)

This userscript runs as injected page JS inside a tab in your own,
normal, manually-driven browser session. There's no external automation
harness attached, so the CDP-specific fingerprint goes away. It is **not** a
guaranteed bypass — synthetic (non-trusted) click events are still a residual
signal some anti-bot systems check for — but it's a meaningfully different
and generally lower-risk profile.

## How it works

- The backend still exposes the same two endpoints the old runner used:
  `GET /api/opentable/jobs` (poll for due jobs) and
  `POST /internal/reservation-status` (report progress/results). Nothing
  server-side needed to change except a token rename.
- The script polls `/api/opentable/jobs` on an interval while any
  `opentable.com` tab is open and idle. When it finds a due job, it navigates
  that tab to the restaurant's booking URL and drives the same steps the old
  automator did (party size, date incl. month navigation, time selection,
  seating options, specials, final reserve/confirm) using plain DOM queries
  instead of Playwright locators.
- Job state persists across page loads via `GM_setValue`/`GM_getValue`
  (Tampermonkey's storage API), since each navigation is a fresh script
  execution — the script re-reads "what job am I working on and what page am
  I on" on every load and picks up where it left off.

## Requirements / constraints

- **A tab must stay open.** Userscripts only run while a page matching
  `@match` (`*://www.opentable.com/*`) is loaded — there's no background
  execution like a real browser extension's service worker. Keep one
  `opentable.com` tab open (e.g. pinned to the homepage) for polling to
  happen. Your computer and browser need to stay awake/open the whole time.
- Only one job runs at a time; a second due job waits until the first
  finishes (matches the old runner's single-in-flight behavior).

## Setup

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser
   extension if you don't already have it.
2. Open Tampermonkey's dashboard → "Create a new script" → replace the
   contents with `opentable-runner.user.js`.
3. Edit the `CONFIG` block near the top:
   - `backendUrl` — where your backend is reachable (`http://localhost:3001`
     for local dev).
   - `runnerToken` — must match `OPENTABLE_RUNNER_TOKEN` in `backend/.env`.
   - `internalToken` — must match `INTERNAL_CALLBACK_TOKEN` in
     `backend/.env`.
4. If `backendUrl` isn't `localhost`, add a matching `@connect` line in the
   script's metadata block (Tampermonkey's `GM_xmlhttpRequest` requires the
   target host to be explicitly allow-listed).
5. Save, make sure the script is enabled, and open/keep open a tab on
   `https://www.opentable.com/`.
6. Create a reservation job as usual (`POST /api/reservations` with
   `platform: "opentable"`) — the script should pick it up on its next poll
   (`pollIntervalMs`, default 30s) and log progress to that tab's devtools
   console (prefixed `[OpenTableRunner]`).

## Debugging

- Open devtools console on the `opentable.com` tab to watch step-by-step
  logs.
- Tampermonkey's icon → this script → menu commands:
  - **"OpenTable Runner: show status"** — logs the currently active job (if
    any) and recently-finished cooldown map to the console.
  - **"OpenTable Runner: clear stuck job"** — manually clears persisted job
    state if something gets stuck (e.g. after editing the script mid-run).
- There's no screenshot/trace artifact capture like the old Playwright
  runner produced — inspect the live page and console directly instead.
