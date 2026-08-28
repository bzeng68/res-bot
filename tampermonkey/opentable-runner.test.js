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
