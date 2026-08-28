# OpenTable Runner (Tampermonkey)

Drives OpenTable bookings from your own signed-in browser tab instead of a
separate automated browser process. OpenTable's bot detection blocks
CDP/headless-driven Chrome even when it's local and signed in; a userscript
running as injected page JS in a tab you're already using has no external
automation harness attached, so that fingerprint goes away. It's **not** a
guaranteed bypass — synthetic (non-trusted) click events are still a residual
signal some anti-bot systems check for — but it's a meaningfully different
and generally lower-risk profile.

## How it works

The whole thing is one continuous loop (`runLoop`, ticking every
`CONFIG.tickMs`, default 150ms) — no page-load/URL-change event wiring to
reason about. Each tick just looks at the current URL/page and clicks
whatever's relevant for that stage:

1. **Idle**: poll `GET /api/opentable/jobs` (`CONFIG.pollIntervalMs`, default
   5s) while no job is active.
2. **Pickup**: navigate to the restaurant URL immediately on discovering a
   due job — party size, date, and a time are passed as query params
   (`?dateTime=...&partySize=...`), which OpenTable's page honors, so there's
   no DOM interaction needed for those. If the job has a future
   `scheduledPollTime` (see [Precise-time scheduling](#precise-time-scheduling)),
   this pre-navigation happens *before* the fire time so the page is already
   warm.
3. **Time selection**: scan the page for time-shaped buttons, report what's
   found (`slots_found`), then click whichever preferred time (in priority
   order) is actually showing. See
   [Preferred times outside the initial window](#preferred-times-outside-the-initial-window)
   for what happens if none are.
4. **Seating-options / specials**: click the standard/default option
   (`[data-test="seatingOption-default-button"]` /
   `[data-test="noSpecialLink"]`) and the completion CTA
   (`#complete-reservation` / `[data-test="complete-reservation-button"]`).
   Once a selector is clicked, it won't be re-clicked on the same page for
   `STAGE_CLICK_COOLDOWN_MS` (2s) — submitting a form can take a moment to
   redirect, and hammering the same button every tick in the meantime risks
   double-submission.
5. **Confirmation**: URL contains `/confirmation`/`/booked`, or a heading
   matches "you're booked"/"reservation confirmed" — reports
   `booking_success` with the extracted confirmation code.

Job state (`otr_activeJob` in `GM_setValue`/`GM_getValue`) persists across
every navigation and reload, since each one is a fresh script execution that
just reads back "what job am I on, what page is this" and continues.

### Precise-time scheduling

If a reservation has a `bookingWindow`, the backend computes
`scheduledPollTime` and only returns the job from `/api/opentable/jobs` once
`now >= scheduledPollTime - OPENTABLE_JOB_LOOKAHEAD_MS` (10s — see
`backend/src/utils/opentableJobs.ts`). The script uses that lead time to
pre-navigate and sit on the already-loaded page, then does one precise
`setTimeout` for the remaining gap and `location.reload()` right at T=0 for
fresh data before touching anything. In testing this fires within ~1s of the
target time. **This only works if the tab stays focused/foregrounded** —
Chrome throttles timers in background tabs, and there's no way for a
userscript to force-focus its own tab.

### Preferred times outside the initial window

OpenTable's page only shows a ~30-45min neighborhood of times around
whatever the URL's `dateTime` param says. The script anchors on your
*top-priority* preferred time (not the range start), so nearby preferences
are covered for free. If none of your preferred times show up near that
anchor within `CONFIG.anchorTimeoutMs` (1.5s), it re-navigates using the next
preferred time (skipping any already ruled out by a previous anchor's scan)
as a fresh anchor, repeating until one hits or all are exhausted — only then
does it report `booking_failed`. This costs a page load per extra anchor
checked, so it only kicks in when preferences are genuinely spread wider
than one neighborhood covers.

## Requirements / constraints

- **A tab must stay open.** Userscripts only run while a page matching
  `@match` (`*://www.opentable.com/*`) is loaded — there's no background
  execution like a real browser extension's service worker. Keep one
  `opentable.com` tab open (e.g. pinned to the homepage) for polling to
  happen, and keep it focused for precise-time scheduling to be accurate.
- Only one job runs at a time; a second due job waits until the first
  finishes.
- Chrome's Manifest V3 build of Tampermonkey has a separate **"Allow User
  Scripts"** permission (`chrome://extensions` → Tampermonkey → Details) —
  without it, scripts silently never run even though everything looks
  correctly installed/enabled.

## Setup

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser
   extension, and make sure **Allow User Scripts** is on for it (see above).
2. Open Tampermonkey's dashboard → "Create a new script" → replace the
   contents with `opentable-runner.user.js`.
3. Edit the `CONFIG` block near the top:
   - `backendUrl` — where your backend is reachable (`http://localhost:3001`
     for local dev).
   - `runnerToken` — must match `OPENTABLE_RUNNER_TOKEN` in `backend/.env`.
   - `internalToken` — must match `INTERNAL_CALLBACK_TOKEN` in
     `backend/.env`.
4. If `backendUrl` isn't `localhost`, add a matching `@connect` line in the
   script's metadata block (`GM_xmlhttpRequest` requires the target host to
   be explicitly allow-listed).
5. Save, confirm the script is enabled, and open (and keep focused) a tab on
   `https://www.opentable.com/`.
6. Create a reservation via `POST /api/reservations` with `platform:
   "opentable"` (no `credentials` needed — auth is just your signed-in
   browser session) — the script picks it up on its next poll and logs
   progress to that tab's console, prefixed `[OpenTableRunner]` with an ISO
   timestamp on every line.

## Debugging

- Console logs are event-based, not per-tick: `action=pickup-job`,
  `action=wait-on-page` (once), `action=fire`, `action=slots-found`,
  `action=select-time`, `action=re-anchor`, `action=stage-click` (only when
  the match changes), `action=confirmed`.
- Tampermonkey's icon → this script → menu commands:
  - **"OpenTable Runner: show status"** — logs the active job (if any) and
    the recently-finished cooldown map.
  - **"OpenTable Runner: clear stuck job"** — clears persisted job state if
    something gets stuck (e.g. after editing the script mid-run).
- There's no screenshot/trace artifact capture — inspect the live page and
  console directly.

## Testing

Pure logic (URL building, time-label formatting, confirmation-code
extraction, stage-selector routing, the anchor-sweep helpers, fire-delay
computation) is covered by `opentable-runner.test.js`, using Node's built-in
test runner — no dependencies:

```bash
cd tampermonkey && npm test
```

DOM click behavior itself (whether a given selector actually works against
OpenTable's live page) isn't unit-testable and is verified by running the
script for real instead.
