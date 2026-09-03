// Unit tests for the pure logic in opentable-runner.user.js.
//
// The userscript exports its testable functions via a `module.exports` guard
// at the bottom that's inert in the real Tampermonkey/browser runtime (there's
// no `module` global there) - here in Node we stub the handful of globals the
// script touches at require-time (GM_registerMenuCommand) and at call-time
// (location/document/getComputedStyle), then unit-test the logic directly.
// DOM-click behavior itself (does a selector actually work against a live
// OpenTable page) is verified by running the script for real, not here.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.GM_getValue = () => undefined;
global.GM_setValue = () => {};
global.GM_xmlhttpRequest = () => {};
global.GM_registerMenuCommand = () => {};
global.location = { pathname: '/', href: 'https://www.opentable.com/' };
global.document = { querySelectorAll: () => [] };
global.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });

const runner = require(path.join(__dirname, 'opentable-runner.user.js'));

test('buildTimeLabels produces AM/PM and 24h variants', () => {
  assert.deepEqual(runner.buildTimeLabels('19:30'), ['7:30 PM', '7:30PM', '7:30', '19:30']);
  assert.deepEqual(runner.buildTimeLabels('09:05'), ['9:05 AM', '9:05AM', '9:05', '09:05']);
  assert.deepEqual(runner.buildTimeLabels('00:00'), ['12:00 AM', '12:00AM', '12:00', '00:00']);
  assert.deepEqual(runner.buildTimeLabels('12:00'), ['12:00 PM', '12:00PM', '12:00', '12:00']);
});

test('normalizeText collapses whitespace variants (including non-breaking space) and lowercases', () => {
  assert.equal(runner.normalizeText('  5:00 PM  '), '5:00 pm');
  assert.equal(runner.normalizeText('Multiple   Spaces'), 'multiple spaces');
  assert.equal(runner.normalizeText(null), '');
});

test('extractConfirmationCode pulls the code out of confirmation copy', () => {
  assert.equal(runner.extractConfirmationCode('your confirmation code: abc123xyz'), 'ABC123XYZ');
  assert.equal(runner.extractConfirmationCode('confirmation abc-999999'), 'ABC-999999');
  assert.equal(runner.extractConfirmationCode('no code here'), undefined);
});

test('buildOpenTableUrl uses the restaurant slug route when a slug is available', () => {
  const url = runner.buildOpenTableUrl({
    restaurantSlug: 'gyu-kaku-japanese-bbq-brookline-beacon-street',
    restaurantName: 'Gyu-Kaku',
    targetDate: '2026-09-02',
    timeRange: { start: '17:00', end: '21:00' },
    partySize: 2,
  });
  assert.equal(
    url,
    'https://www.opentable.com/r/gyu-kaku-japanese-bbq-brookline-beacon-street?dateTime=2026-09-02%2017%3A00&partySize=2',
  );
});

test('buildOpenTableUrl falls back to search when no slug is known', () => {
  const url = runner.buildOpenTableUrl({
    restaurantName: 'Gyu-Kaku',
    targetDate: '2026-09-02',
    timeRange: { start: '17:00', end: '21:00' },
    partySize: 2,
  });
  assert.equal(
    url,
    'https://www.opentable.com/search?query=Gyu-Kaku&date=2026-09-02&time=17%3A00&end=21%3A00&partySize=2',
  );
});

test('buildOpenTableUrl anchors on the top preferred time, not the range start', () => {
  // OpenTable only shows a ~30-45min neighborhood of times around whatever
  // the dateTime param says - a preferred time far from timeRange.start
  // (e.g. 7pm preferred in a 5-10pm range) would never show up otherwise.
  const url = runner.buildOpenTableUrl({
    restaurantSlug: 'gyu-kaku-japanese-bbq-brookline-beacon-street',
    restaurantName: 'Gyu-Kaku',
    targetDate: '2026-09-02',
    timeRange: { start: '17:00', end: '22:00', preferredTimes: ['19:00', '18:00'] },
    partySize: 2,
  });
  assert.equal(
    url,
    'https://www.opentable.com/r/gyu-kaku-japanese-bbq-brookline-beacon-street?dateTime=2026-09-02%2019%3A00&partySize=2',
  );
});

test('buildOpenTableUrl anchors on the preferred time at anchorIndex when the sweep has advanced', () => {
  const url = runner.buildOpenTableUrl({
    restaurantSlug: 'gyu-kaku-japanese-bbq-brookline-beacon-street',
    restaurantName: 'Gyu-Kaku',
    targetDate: '2026-09-02',
    timeRange: { start: '17:00', end: '22:00', preferredTimes: ['19:00', '18:00', '21:00'] },
    partySize: 2,
    anchorIndex: 2,
  });
  assert.match(url, /dateTime=2026-09-02%2021%3A00/);
});

test('timeAlreadySeen matches a preferred time against a previously scanned display string', () => {
  assert.equal(runner.timeAlreadySeen('19:00', ['6:30 PM', '6:45 PM', '7:00 PM']), true);
  assert.equal(runner.timeAlreadySeen('19:00', ['4:30 PM', '4:45 PM', '5:00 PM']), false);
  // Non-breaking-space / exact-format resilience.
  assert.equal(runner.timeAlreadySeen('09:00', ['9:00 AM']), true);
});

test('findNextAnchorIndex skips preferred times already covered by a previous anchor scan', () => {
  const preferredTimes = ['19:00', '19:15', '17:00', '21:00'];
  // Anchor 0 (19:00) scanned a window that happened to also show 19:15 -
  // that one's already known not to be bookable (the click loop would have
  // taken it), so the sweep should skip straight past it to 17:00.
  const seenTimes = ['6:30 PM', '6:45 PM', '7:00 PM', '7:15 PM', '7:30 PM'];
  assert.equal(runner.findNextAnchorIndex(preferredTimes, 0, seenTimes), 2);
});

test('findNextAnchorIndex returns null once every preferred time has been tried or covered', () => {
  const preferredTimes = ['19:00', '19:15'];
  const seenTimes = ['6:30 PM', '6:45 PM', '7:00 PM', '7:15 PM', '7:30 PM'];
  assert.equal(runner.findNextAnchorIndex(preferredTimes, 0, seenTimes), null);
});

test('selectorsForCurrentStage targets the standard seating card on the seating-options page', () => {
  global.location.pathname = '/booking/seating-options';
  const selectors = runner.selectorsForCurrentStage();
  assert.ok(selectors.some((c) => c.selector === '[data-test="seatingOption-default-button"]'));
});

test('selectorsForCurrentStage targets the standard-reservation card on the specials page', () => {
  global.location.pathname = '/booking/specials';
  const selectors = runner.selectorsForCurrentStage();
  assert.ok(selectors.some((c) => c.selector === '[data-test="noSpecialLink"]'));
});

test('selectorsForCurrentStage falls back to generic reserve/confirm selectors elsewhere', () => {
  global.location.pathname = '/r/some-restaurant';
  const selectors = runner.selectorsForCurrentStage();
  assert.ok(selectors.some((c) => c.selector === '#complete-reservation'));
  assert.ok(selectors.some((c) => c.text === 'reserve'));
});

test('selectorsForCurrentStage requires an exact match on the generic reserve/confirm fallback', () => {
  // A promo banner's marketing copy (e.g. "Unlock Sapphire Reserve access")
  // must not match just because it contains the word "reserve" - only a
  // button whose whole label is that word should count.
  global.location.pathname = '/r/some-restaurant';
  const selectors = runner.selectorsForCurrentStage();
  const reserveCandidate = selectors.find((c) => c.text === 'reserve');
  assert.equal(reserveCandidate.exact, true);
  const confirmCandidate = selectors.find((c) => c.text === 'confirm');
  assert.equal(confirmCandidate.exact, true);
});

test('computeFireDelay waits out the remaining gap until scheduledPollTime', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const job = { scheduledPollTime: '2026-08-25T12:00:07.000Z' };
  assert.equal(runner.computeFireDelay(job, now), 7000);
});

test('computeFireDelay returns 0 once the fire time has already passed', () => {
  const now = Date.parse('2026-08-25T12:00:10.000Z');
  const job = { scheduledPollTime: '2026-08-25T12:00:00.000Z' };
  assert.equal(runner.computeFireDelay(job, now), 0);
});

test('computeFireDelay returns 0 when there is no scheduledPollTime', () => {
  assert.equal(runner.computeFireDelay({}), 0);
});

test('isConfirmationPage detects the /confirmation URL regardless of page content', () => {
  global.location.href = 'https://www.opentable.com/booking/confirmation?foo=bar';
  global.document.querySelectorAll = () => [];
  assert.equal(runner.isConfirmationPage(), true);
});

test('isConfirmationPage detects a "you\'re booked" heading even off the confirmation URL', () => {
  global.location.href = 'https://www.opentable.com/r/some-restaurant';
  global.document.querySelectorAll = () => [
    { textContent: "You're booked!", isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }) },
  ];
  assert.equal(runner.isConfirmationPage(), true);
});

test('isConfirmationPage returns false on an ordinary page', () => {
  global.location.href = 'https://www.opentable.com/r/some-restaurant';
  global.document.querySelectorAll = () => [];
  assert.equal(runner.isConfirmationPage(), false);
});

test('isDisabled detects a disabled button or one flagged via aria-disabled', () => {
  assert.equal(runner.isDisabled({ disabled: true }), true);
  assert.equal(runner.isDisabled({ getAttribute: () => 'true' }), true);
  assert.equal(runner.isDisabled({ disabled: false, getAttribute: () => null }), false);
});

test('isInsideExcludedContainer flags elements inside the Chase dining-program promo banner', () => {
  const bannerButton = { closest: (sel) => (sel.includes('chase-dining-program-banner') ? bannerButton : null) };
  assert.equal(runner.isInsideExcludedContainer(bannerButton), true);
});

test('isInsideExcludedContainer leaves ordinary elements alone', () => {
  const normalButton = { closest: () => null };
  assert.equal(runner.isInsideExcludedContainer(normalButton), false);
});

test('isInsideExcludedContainer flags time slots in the no-availability "you may also like" scroller', () => {
  // Regression test: when the restaurant has nothing bookable, OpenTable
  // replaces its time slots with a carousel of *other* restaurants, whose
  // cards carry genuinely clickable time-slot links. Clicking one books the
  // wrong restaurant.
  global.location.pathname = '/r/gyu-kaku-japanese-bbq-brookline-beacon-street';
  const otherVenueSlot = {
    closest: (sel) => (sel.includes('no-availability-scroller') ? otherVenueSlot : null),
  };
  assert.equal(runner.isInsideExcludedContainer(otherVenueSlot), true);
});

test('isInsideExcludedContainer flags restaurant-card time slots on a profile page but not on search results', () => {
  const cardSlot = {
    closest: (sel) => (sel.includes('restaurant-card-link') ? cardSlot : null),
  };
  global.location.pathname = '/market-table';
  assert.equal(runner.isInsideExcludedContainer(cardSlot), true);

  // The search fallback route (buildOpenTableUrl with no slug) has nothing
  // *but* restaurant cards, so the exclusion has to stay off there.
  global.location.pathname = '/search';
  assert.equal(runner.isInsideExcludedContainer(cardSlot), false);

  global.location.pathname = '/'; // leave clean for later tests
});

test('expectedCalendarDayLabel matches react-day-picker\'s day-button aria-label format', () => {
  // Real example from OpenTable's "View full availability" modal:
  // aria-label="Tuesday, September 1" for 2026-09-01 - weekday, month, day,
  // no year, parsed as a plain UTC calendar date (not local-timezone-shifted).
  assert.equal(runner.expectedCalendarDayLabel('2026-09-01'), 'Tuesday, September 1');
  assert.equal(runner.expectedCalendarDayLabel('2026-09-21'), 'Monday, September 21');
});

test('multiDayModalShowsTargetDate confirms the calendar\'s selected day matches the job\'s target date', () => {
  global.document.querySelector = (sel) =>
    sel.includes('aria-pressed="true"') ? { getAttribute: () => 'Monday, September 21' } : null;
  assert.equal(runner.multiDayModalShowsTargetDate('2026-09-21'), true);
  assert.equal(runner.multiDayModalShowsTargetDate('2026-09-22'), false);
});

test('multiDayModalShowsTargetDate returns false when no day is selected yet (calendar still loading)', () => {
  global.document.querySelector = () => null;
  assert.equal(runner.multiDayModalShowsTargetDate('2026-09-21'), false);
});

test('isInsideUnverifiedFullAvailability blocks modal time slots until the date has been verified', () => {
  // Regression test: the generic click-matching loop scans all button/a
  // elements site-wide every tick, so without this gate it would click a
  // modal time slot the instant the modal renders - before
  // multiDayModalShowsTargetDate() ever got a chance to run.
  runner.__setMultiDayModalVerifiedForTest(false);
  const slotLink = { closest: (sel) => (sel.includes('time-slots-container') ? slotLink : null) };
  assert.equal(runner.isInsideUnverifiedFullAvailability(slotLink), true);

  runner.__setMultiDayModalVerifiedForTest(true);
  assert.equal(runner.isInsideUnverifiedFullAvailability(slotLink), false);

  runner.__setMultiDayModalVerifiedForTest(false); // leave clean for later tests
});

test('isInsideUnverifiedFullAvailability leaves elements outside the modal alone regardless of verification state', () => {
  const outsideEl = { closest: () => null };
  runner.__setMultiDayModalVerifiedForTest(false);
  assert.equal(runner.isInsideUnverifiedFullAvailability(outsideEl), false);
});

test('scanAvailableTimes ignores time slots belonging to other restaurants\' cards', () => {
  // Otherwise those times land in job.seenTimes, and findNextAnchorIndex
  // treats a seen time as already checked here - silently skipping an anchor
  // the runner never actually looked at.
  const visible = { isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  global.location.pathname = '/r/some-restaurant';
  global.document.querySelectorAll = () => [
    { ...visible, textContent: '7:00 PM', closest: () => null },
    { ...visible, textContent: '10:30 PM', closest: (sel) => (sel.includes('restaurant-card-link') ? {} : null) },
    { ...visible, textContent: '10:45 PM', closest: (sel) => (sel.includes('no-availability-scroller') ? {} : null) },
    { ...visible, textContent: 'Find next available', closest: () => null },
  ];
  assert.deepEqual(runner.scanAvailableTimes(), ['7:00 PM']);
  global.location.pathname = '/';
});

test('describePageState surfaces disabled/checked flags for visible interactive elements', () => {
  global.document.querySelectorAll = () => [
    {
      tagName: 'BUTTON', textContent: 'Complete reservation', disabled: true, getAttribute: () => null,
      isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }),
    },
    {
      tagName: 'INPUT', name: 'agree', checked: false, disabled: false, getAttribute: () => null,
      isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }),
    },
  ];
  const state = runner.describePageState();
  assert.ok(state.some((s) => s.includes('button(disabled): complete reservation')));
  assert.ok(state.some((s) => s.includes('input(unchecked): agree')));
});
