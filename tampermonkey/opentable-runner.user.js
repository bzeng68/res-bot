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
  // honors them, so there's no separate DOM step needed for either.
  function buildOpenTableUrl(job) {
    const base = 'https://www.opentable.com/';
    const slug = job.restaurantSlug?.trim();
    if (slug) {
      return `${base}r/${slug}?dateTime=${encodeURIComponent(`${job.targetDate} ${job.timeRange.start}`)}&partySize=${job.partySize}`;
    }
    const query = encodeURIComponent(job.restaurantName);
    const date = encodeURIComponent(job.targetDate);
    const start = encodeURIComponent(job.timeRange.start);
    const end = encodeURIComponent(job.timeRange.end);
    return `${base}search?query=${query}&date=${date}&time=${start}&end=${end}&partySize=${job.partySize}`;
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

  // Scans every element matching `selector` (optionally filtered by text) and
  // returns the first one that's actually visible - NOT just the first
  // text/selector match, since a hidden/off-screen duplicate (responsive
  // layout variants, sr-only a11y text, tooltip templates, etc.) earlier in
  // the DOM would otherwise shadow the real interactive element entirely.
  function findVisible(selector, text, exact) {
    const wanted = text != null ? normalizeText(text) : null;
    for (const el of document.querySelectorAll(selector)) {
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
  // Returns the matched candidate (not just true/false) so callers can log
  // exactly what was selected, not just that something was.
  function clickFirstVisible(candidates) {
    for (const c of candidates) {
      const el = findVisible(c.selector, c.text, c.exact);
      if (el) {
        simulateClick(el);
        return c;
      }
    }
    return null;
  }

  function describeCandidate(c) {
    return c.text != null ? `${c.selector} text~="${c.text}"` : c.selector;
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
    // Landing page / review page fallback.
    return [{ selector: '#complete-reservation' }, { selector: '[data-test="complete-reservation-button"]' }, { selector: 'button', text: 'reserve' }, { selector: 'button', text: 'confirm' }];
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

  // One tick of the loop: check URL/page state, click whatever's relevant,
  // return true when the job has reached a terminal state.
  async function tick(job) {
    log('action=tick path=', location.pathname, 'selectedTime=', job.selectedTime || '(none yet)');
    dismissCommonPrompts();

    if (isConfirmationPage()) {
      const code = extractConfirmationCode(document.body.innerText.toLowerCase());
      log('action=confirmed choice=', code || '(no confirmation code found)');
      await finishJob(job, 'booking_success', { selectedTime: job.selectedTime, confirmationCode: code, finalUrl: location.href });
      return true;
    }

    if (!job.selectedTime) {
      const preferredTimes = job.timeRange.preferredTimes?.length ? job.timeRange.preferredTimes : [job.timeRange.start];
      const availableTimes = scanAvailableTimes();
      log('action=scan-times choice=', availableTimes.length ? availableTimes.join(', ') : '(none found yet)');
      if (availableTimes.length && !job.reportedSlots) {
        job.reportedSlots = true;
        gmSet(ACTIVE_JOB_KEY, job);
        await reportStatus(job.id, 'slots_found', { slotCount: availableTimes.length, availableTimes: availableTimes.slice(0, 10) });
      }

      for (const time of preferredTimes) {
        for (const label of buildTimeLabels(time)) {
          const matched = clickFirstVisible([{ selector: 'button', text: label }, { selector: 'a', text: label }]);
          if (matched) {
            log('action=select-time choice=', time, `(matched label "${label}")`);
            job.selectedTime = time;
            gmSet(ACTIVE_JOB_KEY, job);
            await reportStatus(job.id, 'slot_selected', { selectedTime: time, url: location.href });
            return false;
          }
        }
      }
      log('action=select-time choice=(no preferred time matched this tick)');
      return false;
    }

    const stageMatch = clickFirstVisible(selectorsForCurrentStage());
    log('action=stage-click choice=', stageMatch ? describeCandidate(stageMatch) : '(nothing matched this tick)');
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

      const url = buildOpenTableUrl(job);
      log('action=pickup-job choice=', job.id, url);
      await reportStatus(job.id, 'runner_started', { url, partySize: job.partySize });

      gmSet(ACTIVE_JOB_KEY, {
        id: job.id,
        restaurantSlug: job.restaurantSlug,
        restaurantName: job.restaurantName,
        targetDate: job.targetDate,
        timeRange: job.timeRange,
        partySize: job.partySize,
        runUntil: job.runUntil,
        startedAt: now,
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

      await sleep(300);
    }
  }

  runLoop();
})();
