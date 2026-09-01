// ==UserScript==
// @name         Res Bot - OpenTable Runner
// @namespace    res-bot
// @version      1.0.0
// @description  Drives OpenTable bookings from your own signed-in browser tab instead of a separate automated browser process (OpenTable's bot detection blocks CDP/headless-driven Chrome even when it's local and signed in).
// @match        *://www.opentable.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  // Fill these in from backend/.env before installing. runnerToken must match
  // OPENTABLE_RUNNER_TOKEN; internalToken must match INTERNAL_CALLBACK_TOKEN.
  const CONFIG = {
    backendUrl: 'http://localhost:3001',
    runnerToken: 'REPLACE_WITH_OPENTABLE_RUNNER_TOKEN',
    internalToken: 'REPLACE_WITH_INTERNAL_CALLBACK_TOKEN',
    pollIntervalMs: 5_000,
    cooldownMs: 60_000,
    jobTimeoutMs: 10 * 60_000,
    tickMs: 150,
    anchorTimeoutMs: 1_500,
  };

  const ACTIVE_JOB_KEY = 'otr_activeJob';
  const RECENT_KEY = 'otr_recentlyFinished';

  function log(...args) {
    console.log(`[OpenTableRunner] ${new Date().toISOString()}`, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function gmGet(key, def) {
    return GM_getValue(key, def);
  }

  function gmSet(key, value) {
    GM_setValue(key, value);
  }

  // ---- Backend client ----

  function gmRequest(method, path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: CONFIG.backendUrl + path,
        headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
        data: body ? JSON.stringify(body) : undefined,
        timeout: 15_000,
        onload: (response) => {
          let parsed = null;
          try { parsed = JSON.parse(response.responseText); } catch { /* non-JSON body */ }
          resolve({ status: response.status, data: parsed });
        },
        onerror: reject,
        ontimeout: () => reject(new Error('request timed out')),
      });
    });
  }

  function fetchDueJobs() {
    return gmRequest('GET', '/api/opentable/jobs', {
      headers: { 'x-opentable-runner-token': CONFIG.runnerToken },
    }).then((res) => (Array.isArray(res.data?.data) ? res.data.data : []));
  }

  async function reportStatus(jobId, status, details) {
    try {
      await gmRequest('POST', '/internal/reservation-status', {
        headers: { 'x-internal-token': CONFIG.internalToken },
        body: {
          type: 'opentable_runner_status',
          jobId,
          data: { status, ...details },
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      log('reportStatus failed', status, err);
    }
  }

  // Party size and date are passed as query params and OpenTable's page
  // honors them, so there's no separate DOM step needed for either. The time
  // param anchors which ~30-45min neighborhood of times gets shown, so it
  // must be a preferred time - not timeRange.start - or a preference far
  // from the range's start (e.g. 7pm preferred in a 5-10pm range) would
  // never appear in the results at all. anchorIndex selects which preferred
  // time to anchor on (see tick()'s re-anchor sweep for when it advances).
  function buildOpenTableUrl(job) {
    const anchorTime = job.timeRange.preferredTimes?.[job.anchorIndex || 0] || job.timeRange.start;
    const base = 'https://www.opentable.com/';
    const slug = job.restaurantSlug?.trim();
    if (slug) {
      return `${base}r/${slug}?dateTime=${encodeURIComponent(`${job.targetDate} ${anchorTime}`)}&partySize=${job.partySize}`;
    }
    const query = encodeURIComponent(job.restaurantName);
    const date = encodeURIComponent(job.targetDate);
    const start = encodeURIComponent(anchorTime);
    const end = encodeURIComponent(job.timeRange.end);
    return `${base}search?query=${query}&date=${date}&time=${start}&end=${end}&partySize=${job.partySize}`;
  }

  // Backend returns a job once it's within OPENTABLE_JOB_LOOKAHEAD_MS of its
  // scheduledPollTime (see backend/src/utils/opentableJobs.ts), not only once
  // it's already due - this computes the exact remaining gap so pollForJobs
  // can setTimeout-wait it out precisely instead of firing as soon as seen.
  function computeFireDelay(job, now = Date.now()) {
    if (!job.scheduledPollTime) return 0;
    const fireAt = Date.parse(job.scheduledPollTime);
    if (Number.isNaN(fireAt)) return 0;
    return Math.max(0, fireAt - now);
  }

  // ---- DOM helpers ----

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Collapses all whitespace variants (including the non-breaking space
  // OpenTable renders between e.g. "5:00" and "PM") into a single regular
  // space, so template-literal candidate labels reliably match real DOM text.
  function normalizeText(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Known non-booking promo content that happens to use ordinary <button>
  // markup - e.g. OpenTable's Chase Sapphire dining-program banner ("Unlock
  // Sapphire Reserve access"), whose text can coincidentally contain words a
  // fallback selector searches for. Excluded structurally by its stable
  // data-test attribute rather than by matching against its wording, since a
  // future rewording (different card partner, different copy) would just as
  // easily collide again if we only excluded specific phrases.
  const EXCLUDED_CONTAINER_SELECTOR = '[data-test="chase-dining-program-banner"]';

  function isInsideExcludedBanner(el) {
    return !!el.closest?.(EXCLUDED_CONTAINER_SELECTOR);
  }

  // Blocks the generic click-matching loop from clicking a time slot inside
  // the "View full availability" modal until multiDayModalShowsTargetDate()
  // has actually verified its calendar matches our target date. Without
  // this, the matching loop (which scans all button/a elements site-wide,
  // every tick) would click a modal time slot the instant the modal renders
  // - on the very tick it becomes visible, before the date-verification code
  // ever runs - defeating the whole point of that check. multiDayModalVerified
  // is a plain module-level flag, not persisted job state, because it's only
  // meaningful for the lifetime of the current page load: any navigation (a
  // fresh anchor, a new job) reruns this whole script from scratch and
  // starts it back at false, which is exactly the reset behavior we want.
  let multiDayModalVerified = false;
  const MULTI_DAY_TIME_SLOTS_SELECTOR = '[data-test="multi-day-availability-modal-v2-time-slots-container"]';

  function isInsideUnverifiedFullAvailability(el) {
    return !multiDayModalVerified && !!el.closest?.(MULTI_DAY_TIME_SLOTS_SELECTOR);
  }

  // Test-only control for the module-level flag above - real code only ever
  // sets it via the verified branch in tick()'s full-availability handling.
  function __setMultiDayModalVerifiedForTest(value) {
    multiDayModalVerified = value;
  }

  // Scans every element matching `selector` (optionally filtered by text) and
  // returns the first one that's actually visible - NOT just the first
  // text/selector match, since a hidden/off-screen duplicate (responsive
  // layout variants, sr-only a11y text, tooltip templates, etc.) earlier in
  // the DOM would otherwise shadow the real interactive element entirely.
  function findVisible(selector, text, exact) {
    const wanted = text != null ? normalizeText(text) : null;
    for (const el of document.querySelectorAll(selector)) {
      if (isInsideExcludedBanner(el)) continue;
      if (isInsideUnverifiedFullAvailability(el)) continue;
      if (wanted != null) {
        const t = normalizeText(el.textContent);
        const matches = exact ? t === wanted : t.includes(wanted);
        if (!matches) continue;
      }
      if (isVisible(el)) return el;
    }
    return null;
  }

  // Some custom "card select" components (specials/seating-options cards)
  // don't respond to a bare el.click() - dispatch a fuller pointer/mouse
  // sequence with realistic coordinates instead.
  function simulateClick(el) {
    try {
      const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const opts = {
        bubbles: true, cancelable: true, view: win,
        clientX: cx, clientY: cy,
        screenX: cx + (win.screenX || 0), screenY: cy + (win.screenY || 0),
      };
      const pointerOpts = { ...opts, pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0 };
      el.dispatchEvent(new win.PointerEvent('pointerdown', pointerOpts));
      el.dispatchEvent(new win.MouseEvent('mousedown', { ...opts, button: 0 }));
      el.dispatchEvent(new win.PointerEvent('pointerup', pointerOpts));
      el.dispatchEvent(new win.MouseEvent('mouseup', { ...opts, button: 0 }));
    } catch (err) {
      log('simulateClick: pointer/mouse dispatch failed, falling back to plain click', err);
    }
    el.click();
  }

  // candidates: [{ selector, text?, exact? }] - first visible match wins.
  // Returns { candidate, el } (not just true/false) so callers can log
  // exactly what was selected, not just that something was.
  function findFirstVisible(candidates) {
    for (const c of candidates) {
      const el = findVisible(c.selector, c.text, c.exact);
      if (el) return { candidate: c, el };
    }
    return null;
  }

  function clickFirstVisible(candidates) {
    const found = findFirstVisible(candidates);
    if (!found) return null;
    simulateClick(found.el);
    return found.candidate;
  }

  function describeCandidate(c) {
    return c.text != null ? `${c.selector} text~="${c.text}"` : c.selector;
  }

  // A matched selector can be visible but non-functional (e.g. a submit
  // button disabled until a required field/checkbox is filled) - clicking it
  // every tick would silently do nothing forever. Surfacing this distinctly
  // from "found nothing" is what makes that failure mode diagnosable.
  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute?.('aria-disabled') === 'true');
  }

  // Snapshot of visible interactive elements, for reporting back to the
  // backend when the runner is stuck - this is the only way to see what the
  // page actually looked like after the fact, since there's no console access
  // once the tab's closed.
  function describePageState() {
    const out = [];
    for (const el of document.querySelectorAll('button, a, input[type="checkbox"], input[type="radio"]')) {
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const text = tag === 'input' ? (el.getAttribute('aria-label') || el.name || '') : normalizeText(el.textContent);
      if (!text) continue;
      const flags = [
        isDisabled(el) && 'disabled',
        tag === 'input' && (el.checked ? 'checked' : 'unchecked'),
      ].filter(Boolean).join(',');
      out.push(flags ? `${tag}(${flags}): ${text}` : `${tag}: ${text}`);
      if (out.length >= 20) break;
    }
    return out;
  }

  // The final "complete reservation" review page (shown when the restaurant
  // requires a card hold) can have two custom-styled checkboxes: `tcAccepted`
  // (terms and conditions) and `optInCollectPoints` (loyalty points). Both
  // are best-effort only - check them when present and visible, but never
  // withhold the submit click waiting on either one. OpenTable renders
  // `tcAccepted` even on restaurants that don't need a card (just hidden
  // rather than omitted), so treating it as a hard requirement risks
  // blocking forever on a checkbox nobody can ever check; if it's genuinely
  // required and our click on it didn't register, submission will just fail
  // validation naturally rather than us guessing wrong and hanging the job.
  const OPT_IN_IDS = ['tcAccepted', 'optInCollectPoints'];

  function clickCheckboxById(id) {
    const input = document.getElementById(id);
    if (!input || input.checked) return;
    const target = isVisible(input) ? input : input.closest('label');
    if (target && isVisible(target)) simulateClick(target);
  }

  function checkBookingDetailsOptIns() {
    for (const id of OPT_IN_IDS) clickCheckboxById(id);
  }

  function dismissCommonPrompts() {
    clickFirstVisible([
      { selector: '#onetrust-reject-all-handler' },
      { selector: '#onetrust-accept-btn-handler' },
      { selector: 'button', text: 'accept' },
      { selector: 'button', text: 'got it' },
      { selector: 'button', text: 'close' },
    ]);
  }

  // ---- Core booking path ----
  // 1. go to restaurant URL (party size/date/time already in query params)
  // 2. select the best preferred available time
  // 3. seating-options: pick the standard/default seating card
  // 4. specials: pick the standard-reservation card
  // 5. complete reservation

  function buildTimeLabels(time24) {
    const [h, m] = time24.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = ((h + 11) % 12) + 1;
    const mm = String(m).padStart(2, '0');
    return [`${h12}:${mm} ${suffix}`, `${h12}:${mm}${suffix}`, `${h12}:${mm}`, time24];
  }

  const TIME_LABEL_RE = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;

  function scanAvailableTimes() {
    const times = new Set();
    for (const el of document.querySelectorAll('button, a')) {
      const raw = (el.textContent || '').trim();
      if (TIME_LABEL_RE.test(raw) && isVisible(el)) times.add(raw.replace(/\s+/g, ' '));
    }
    return Array.from(times);
  }

  // True if `time` (24h "HH:MM") already appeared in a previous anchor's
  // scanned results - i.e. we've already effectively checked it (the
  // click-matching loop tries every preferred time against whatever's
  // currently shown, so if it were selectable it would already be selected).
  function timeAlreadySeen(time, seenTimes) {
    const labels = buildTimeLabels(time).map(normalizeText);
    return seenTimes.some((seen) => labels.includes(normalizeText(seen)));
  }

  // Next preferred-time index (after currentIndex) worth trying as a fresh
  // URL anchor - skipping any already covered by a previously-scanned
  // anchor's neighborhood, since those are already known not to be bookable.
  function findNextAnchorIndex(preferredTimes, currentIndex, seenTimes) {
    for (let i = currentIndex + 1; i < preferredTimes.length; i++) {
      if (!timeAlreadySeen(preferredTimes[i], seenTimes)) return i;
    }
    return null;
  }

  // "View full availability" opens a modal showing every time slot for one
  // specific date (not just the ~30-45min neighborhood the base page shows),
  // keyed off whatever date is already selected on the page - which is
  // always job.targetDate here, since that's what our URL's dateTime param
  // drives. We still verify the calendar's selected day before trusting its
  // time list, as a cheap safety net against ever booking the wrong date,
  // rather than assuming that link always holds. If it doesn't check out (or
  // the button isn't present at all), we fall back to the URL re-anchor
  // sweep below unchanged. The modal's time slots are ordinary <a> elements,
  // so the existing per-preferred-time matching loop above picks them up
  // automatically on the next tick once the modal is open (findVisible's
  // isInsideUnverifiedFullAvailability check keeps that loop from clicking
  // them any earlier than that, before this verification has run) - no
  // separate click-handling needed here.
  const MULTI_DAY_BUTTON_SELECTOR = '[data-test="multi-day-availability-button"]';
  const MULTI_DAY_MODAL_SELECTOR = '[data-test="multi-day-availability-modal"]';
  const MULTI_DAY_CALENDAR_SELECTOR = '[data-testid="multi-day-availability-calendar"]';
  const MULTI_DAY_MODAL_TIMEOUT_MS = 2_000;

  // Matches react-day-picker's day-button aria-label format ("Tuesday,
  // September 1" - weekday, month, day, no year). Parsed as UTC so this
  // doesn't drift with the browser's local timezone - targetDate is a plain
  // calendar date, not a timezone-aware instant.
  function expectedCalendarDayLabel(targetDate) {
    const [y, m, d] = targetDate.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }

  function multiDayModalShowsTargetDate(targetDate) {
    const selectedDay = document.querySelector(`${MULTI_DAY_CALENDAR_SELECTOR} button[aria-pressed="true"]`);
    if (!selectedDay) return false;
    return normalizeText(selectedDay.getAttribute('aria-label') || '') === normalizeText(expectedCalendarDayLabel(targetDate));
  }

  function isConfirmationPage() {
    const url = location.href.toLowerCase();
    if (url.includes('/confirmation') || url.includes('/booked')) return true;
    const heading = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
      .find((el) => /you'?re\s+(all\s+)?booked|reservation\s+confirmed|booking\s+confirmed/i.test(normalizeText(el.textContent)));
    return !!(heading && isVisible(heading));
  }

  function extractConfirmationCode(text) {
    const match = text.match(/confirmation(?:\s+code)?[^a-z0-9]*([a-z0-9-]{6,})/i);
    return match ? match[1].toUpperCase() : undefined;
  }

  // Stage selector table: given the current URL, which selectors are
  // relevant right now. Every tick just looks this up and clicks whatever
  // matches - no separate "did we already do this stage" tracking.
  function selectorsForCurrentStage() {
    const path = location.pathname;
    if (path.includes('/booking/seating-options')) {
      return [{ selector: '[data-test="seatingOption-default-button"]' }, { selector: '#complete-reservation' }, { selector: '[data-test="complete-reservation-button"]' }];
    }
    if (path.includes('/booking/specials')) {
      return [{ selector: '[data-test="noSpecialLink"]' }, { selector: '#complete-reservation' }, { selector: '[data-test="complete-reservation-button"]' }];
    }
    // Landing page / review page fallback. exact: true on the text-based
    // candidates matters here - a substring match on "reserve" also matches
    // unrelated marketing copy that happens to contain the word (e.g. a
    // Chase card promo banner's "Unlock Sapphire Reserve access"), which
    // isn't a real submit button but would get clicked every tick forever.
    return [
      { selector: '#complete-reservation' },
      { selector: '[data-test="complete-reservation-button"]' },
      { selector: 'button', text: 'reserve', exact: true },
      { selector: 'button', text: 'confirm', exact: true },
    ];
  }

  // ---- Job state machine ----

  function isExpired(job) {
    if (Date.now() - job.startedAt > CONFIG.jobTimeoutMs) return true;
    if (job.runUntil && Date.now() > Date.parse(job.runUntil)) return true;
    return false;
  }

  async function finishJob(job, status, details) {
    await reportStatus(job.id, status, details);
    gmSet(ACTIVE_JOB_KEY, null);
    gmSet(RECENT_KEY, { ...gmGet(RECENT_KEY, {}), [job.id]: Date.now() });
  }

  let tickCount = 0;
  let lastStageChoice; // dedupe: only log stage-click when the result changes
  let lastStageClickKey = null;
  let lastStageClickAt = 0;
  // Once a candidate is clicked, don't re-click the exact same one on the
  // same page every 150ms while waiting for it to take effect (e.g. a
  // "Complete reservation" submit whose result takes a moment to land) -
  // but do retry after this grace period in case the click genuinely didn't
  // register the first time.
  const STAGE_CLICK_COOLDOWN_MS = 1000;
  // Throttle for "stuck" diagnostics (nothing matched / matched-but-disabled)
  // so a page stuck for minutes doesn't spam a report every tick.
  const STUCK_REPORT_INTERVAL_MS = 10000;
  let lastStuckReportAt = 0;

  // One tick of the loop: check URL/page state, click whatever's relevant,
  // return true when the job has reached a terminal state.
  async function tick(job) {
    tickCount++;

    // Pre-navigated ahead of the fire time: just wait (cheaply - skip the
    // rest of the tick entirely) until it arrives, then reload right at T=0
    // for fresh availability data before interacting with anything.
    const delay = computeFireDelay(job);
    if (delay > 0) {
      if (delay <= CONFIG.tickMs) {
        await sleep(delay);
        log('action=fire choice=', job.id);
        location.reload();
      } else if (!job.reportedWaiting) {
        job.reportedWaiting = true;
        gmSet(ACTIVE_JOB_KEY, job);
        log('action=wait-on-page choice=', job.id, `${delay}ms remaining until`, job.scheduledPollTime);
      }
      return false;
    }

    // Throttle the consent-banner scan to every other tick once the page has
    // had one clean check - always runs on tick 1 of every fresh page load.
    if (tickCount % 2 === 1) dismissCommonPrompts();

    if (isConfirmationPage()) {
      const code = extractConfirmationCode(document.body.innerText.toLowerCase());
      log('action=confirmed choice=', code || '(no confirmation code found)');
      await finishJob(job, 'booking_success', { selectedTime: job.selectedTime, confirmationCode: code, finalUrl: location.href });
      return true;
    }

    if (!job.selectedTime) {
      const preferredTimes = job.timeRange.preferredTimes?.length ? job.timeRange.preferredTimes : [job.timeRange.start];
      const anchorTime = preferredTimes[job.anchorIndex || 0];

      // Measured from the first tick we actually look at this anchor's
      // rendered content - not from pickup/navigation time, since pre-nav
      // waiting and page-load time shouldn't count against its budget.
      if (!job.anchorStartedAt) {
        job.anchorStartedAt = Date.now();
        job.anchorsTried = [...(job.anchorsTried || []), anchorTime];
        job.multiDayModalTried = false;
        job.multiDayModalOpenedAt = null;
        gmSet(ACTIVE_JOB_KEY, job);
      }

      const availableTimes = scanAvailableTimes();
      if (availableTimes.length && !job.reportedSlots) {
        job.reportedSlots = true;
        job.seenTimes = Array.from(new Set([...(job.seenTimes || []), ...availableTimes]));
        gmSet(ACTIVE_JOB_KEY, job);
        log('action=slots-found choice=', `near ${anchorTime}:`, availableTimes.join(', '));
        // Fire-and-forget: this is informational logging, not a step the
        // booking flow depends on - don't let a network round-trip block
        // the next click attempt.
        reportStatus(job.id, 'slots_found', {
          anchorTime,
          slotCount: availableTimes.length,
          availableTimes: availableTimes.slice(0, 10),
          anchorsTried: job.anchorsTried,
        });
      }

      for (const time of preferredTimes) {
        for (const label of buildTimeLabels(time)) {
          const matched = clickFirstVisible([{ selector: 'button', text: label }, { selector: 'a', text: label }]);
          if (matched) {
            const summary = job.anchorsTried.length > 1
              ? `tried ${job.anchorsTried.join(' -> ')}, ${time} worked`
              : `${time} worked on the first try`;
            log('action=select-time choice=', time, `(matched label "${label}")`, summary);
            job.selectedTime = time;
            gmSet(ACTIVE_JOB_KEY, job);
            // Fire-and-forget - see note above.
            reportStatus(job.id, 'slot_selected', { selectedTime: time, url: location.href, anchorsTried: job.anchorsTried, summary });
            return false;
          }
        }
      }

      // None of the preferred times are showing near this anchor. Once it's
      // had a fair chance to render and be tried, try "View full
      // availability" before resorting to the reload-based sweep below - it
      // covers the whole day in one click instead of one page load per
      // anchor tried.
      if (Date.now() - job.anchorStartedAt > CONFIG.anchorTimeoutMs && !job.multiDayModalTried) {
        if (!job.multiDayModalOpenedAt) {
          const opened = clickFirstVisible([{ selector: MULTI_DAY_BUTTON_SELECTOR }]);
          if (!opened) {
            // Not offered for this restaurant - fall through to the sweep
            // below immediately, no point waiting on something absent.
            job.multiDayModalTried = true;
            gmSet(ACTIVE_JOB_KEY, job);
          } else {
            job.multiDayModalOpenedAt = Date.now();
            gmSet(ACTIVE_JOB_KEY, job);
            return false;
          }
        } else if (findVisible(MULTI_DAY_MODAL_SELECTOR)) {
          job.multiDayModalTried = true;
          gmSet(ACTIVE_JOB_KEY, job);
          if (multiDayModalShowsTargetDate(job.targetDate)) {
            multiDayModalVerified = true;
            log('action=full-availability-opened choice=', job.targetDate);
            reportStatus(job.id, 'full_availability_opened', { targetDate: job.targetDate }); // fire-and-forget
            return false; // next tick's matching loop above will find its slots
          }
          // Date mismatch: multiDayModalVerified stays false, so the matching
          // loop above continues ignoring this modal's contents. No need to
          // close it here - the sweep below either reloads onto a fresh
          // anchor or ends the job, both of which make the open modal moot.
          log('action=full-availability-date-mismatch choice=', job.targetDate);
          reportStatus(job.id, 'full_availability_skipped', { reason: 'calendar date did not match targetDate', targetDate: job.targetDate }); // fire-and-forget
        } else if (Date.now() - job.multiDayModalOpenedAt > MULTI_DAY_MODAL_TIMEOUT_MS) {
          // Clicked it but the modal never appeared - don't wait forever.
          job.multiDayModalTried = true;
          gmSet(ACTIVE_JOB_KEY, job);
        } else {
          return false; // still waiting for the modal to render
        }
      }

      // Last resort: sweep to the next not-yet-covered preferred time as a
      // fresh URL anchor. Only reached once the full-availability modal
      // above has been tried and ruled out for this attempt (absent, date
      // mismatch, or timed out) - job.multiDayModalTried is false until then,
      // which keeps this block from ever firing before that resolves.
      if (Date.now() - job.anchorStartedAt > CONFIG.anchorTimeoutMs && job.multiDayModalTried) {
        const nextIndex = findNextAnchorIndex(preferredTimes, job.anchorIndex || 0, job.seenTimes || []);
        if (nextIndex != null) {
          job.anchorIndex = nextIndex;
          job.reportedSlots = false;
          job.anchorStartedAt = null;
          gmSet(ACTIVE_JOB_KEY, job);
          const url = buildOpenTableUrl(job);
          log('action=re-anchor choice=', preferredTimes[nextIndex], url);
          // Fire-and-forget - the actual re-navigation below is time-critical,
          // this is just visibility into the sweep for the dashboard.
          reportStatus(job.id, 'anchor_exhausted', { triedAnchor: anchorTime, nextAnchor: preferredTimes[nextIndex], anchorsTried: job.anchorsTried });
          location.href = url;
          return false;
        }

        const summary = `tried ${job.anchorsTried.join(' -> ')}, none had a matching slot`;
        log('action=booking-failed choice=', summary);
        await finishJob(job, 'booking_failed', {
          error: 'No preferred time was available near any anchor tried',
          summary,
          anchorsTried: job.anchorsTried,
          finalUrl: location.href,
        });
        return true;
      }

      return false;
    }

    // Best-effort every tick, cheap (two getElementById lookups) even on
    // pages where neither checkbox exists.
    checkBookingDetailsOptIns();

    const found = findFirstVisible(selectorsForCurrentStage());
    const choice = found ? describeCandidate(found.candidate) : '(nothing matched)';
    if (choice !== lastStageChoice) {
      lastStageChoice = choice;
      log('action=stage-click path=', location.pathname, 'choice=', choice);
    }

    // Nothing on this page matched any known selector - report periodically
    // so a stall here (e.g. an unexpected interstitial) is diagnosable after
    // the fact instead of only visible in a console nobody was watching.
    if (!found) {
      const now = Date.now();
      if (now - lastStuckReportAt > STUCK_REPORT_INTERVAL_MS) {
        lastStuckReportAt = now;
        reportStatus(job.id, 'stage_stuck', { path: location.pathname, visible: describePageState() }); // fire-and-forget
      }
      return false;
    }

    const key = `${location.pathname}|${choice}`;
    const now = Date.now();
    const isFinal = found.candidate.selector === '#complete-reservation' || found.candidate.selector === '[data-test="complete-reservation-button"]';

    // A matched button can be visible but disabled (e.g. a required field
    // isn't filled in yet) - clicking it does nothing, so report it
    // distinctly from a normal click instead of silently retrying forever
    // until the reservation's hold times out.
    if (isDisabled(found.el)) {
      if (key !== lastStageClickKey || now - lastStageClickAt > STUCK_REPORT_INTERVAL_MS) {
        lastStageClickKey = key;
        lastStageClickAt = now;
        log('action=stage-blocked path=', location.pathname, 'choice=', choice);
        reportStatus(job.id, 'stage_blocked', { path: location.pathname, choice, visible: describePageState() }); // fire-and-forget
      }
      return false;
    }

    if (key !== lastStageClickKey || now - lastStageClickAt > STAGE_CLICK_COOLDOWN_MS) {
      lastStageClickKey = key;
      lastStageClickAt = now;
      simulateClick(found.el);
      reportStatus(job.id, isFinal ? 'booking_submitted' : 'stage_advanced', { path: location.pathname, choice }); // fire-and-forget
    }
    return false;
  }

  async function pollForJobs() {
    if (gmGet(ACTIVE_JOB_KEY, null)) return;

    let jobs;
    try {
      jobs = await fetchDueJobs();
    } catch (err) {
      log('poll failed', err);
      return;
    }

    const recent = gmGet(RECENT_KEY, {});
    const now = Date.now();

    for (const job of jobs) {
      const cooldownUntil = (recent[job.id] || 0) + CONFIG.cooldownMs;
      if (now < cooldownUntil) continue;

      if (job.runUntil && now > Date.parse(job.runUntil)) {
        await reportStatus(job.id, 'booking_failed', { error: `runUntil elapsed at ${job.runUntil}` });
        gmSet(RECENT_KEY, { ...recent, [job.id]: now });
        continue;
      }

      // Navigate immediately rather than sleeping here first - pre-loading
      // the restaurant page ahead of the fire time (the backend's lookahead
      // window guarantees several seconds of runway) means the page/assets
      // are already warm by the time the fire moment actually arrives.
      // tick() waits out any remaining delay and reloads right at T=0.
      const url = buildOpenTableUrl(job);
      log('action=pickup-job choice=', job.id, url);
      reportStatus(job.id, 'runner_started', { url, partySize: job.partySize }); // fire-and-forget - don't delay navigation

      gmSet(ACTIVE_JOB_KEY, {
        id: job.id,
        restaurantSlug: job.restaurantSlug,
        restaurantName: job.restaurantName,
        targetDate: job.targetDate,
        timeRange: job.timeRange,
        partySize: job.partySize,
        runUntil: job.runUntil,
        scheduledPollTime: job.scheduledPollTime,
        startedAt: now,
        anchorIndex: 0,
        seenTimes: [],
        anchorsTried: [],
      });

      location.href = url;
      return;
    }
  }

  GM_registerMenuCommand('OpenTable Runner: show status', () => {
    console.log('[OpenTableRunner] active job:', gmGet(ACTIVE_JOB_KEY, null));
    console.log('[OpenTableRunner] recently finished:', gmGet(RECENT_KEY, {}));
    alert('OpenTable Runner status logged to the console.');
  });

  GM_registerMenuCommand('OpenTable Runner: clear stuck job', () => {
    gmSet(ACTIVE_JOB_KEY, null);
    alert('Cleared active job state.');
  });

  // Single continuous loop: no page-load/URL-change event triggers to
  // reason about - just keep checking the URL and clicking the relevant
  // selector for whatever stage we're on, until success or timeout.
  async function runLoop() {
    while (true) {
      const job = gmGet(ACTIVE_JOB_KEY, null);

      if (!job) {
        await pollForJobs();
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }

      if (isExpired(job)) {
        await finishJob(job, 'booking_failed', { error: 'Timed out before reaching a terminal booking state', finalUrl: location.href });
        continue;
      }

      try {
        await tick(job);
      } catch (err) {
        log('tick failed', err);
      }

      await sleep(CONFIG.tickMs);
    }
  }

  // Testability hook: inert in the real Tampermonkey/browser runtime (there's
  // no `module` global there), but lets a plain Node test `require()` this
  // file to unit-test the pure logic below without starting the live loop.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildTimeLabels,
      normalizeText,
      extractConfirmationCode,
      buildOpenTableUrl,
      selectorsForCurrentStage,
      computeFireDelay,
      isConfirmationPage,
      timeAlreadySeen,
      findNextAnchorIndex,
      isDisabled,
      describePageState,
      isInsideExcludedBanner,
      expectedCalendarDayLabel,
      multiDayModalShowsTargetDate,
      isInsideUnverifiedFullAvailability,
      __setMultiDayModalVerifiedForTest,
    };
  } else {
    runLoop();
  }
})();
