import { describe, it, beforeEach, afterEach } from 'mocha';
import { assert } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ReservationRequest for a given booking window. */
function makeReservation(overrides?: Record<string, any>): any {
  return {
    id: 'res-1',
    restaurantId: 'venue-123',
    restaurantName: 'Test Restaurant',
    targetDate: '2026-04-04', // 30 days after 2026-03-05
    timeRange: { start: '19:00', end: '21:00' },
    partySize: 2,
    userEmail: 'test@test.com',
    credentials: { platform: 'resy', authToken: 'tok' },
    status: 'scheduled',
    createdAt: '2026-03-05T10:00:00Z',
    bookingWindow: {
      daysInAdvance: 30,
      releaseTime: '00:00', // midnight UTC — simplifies date arithmetic
      timezone: 'UTC',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scheduler', () => {
  // Pin "now" to a fixed point so all time arithmetic is deterministic.
  // now = 2026-03-05T10:00:00Z
  // targetDate '2026-04-04' + 30-day window at 00:00 UTC → fireTime = 2026-03-05T00:00:01Z (10 hours ago)
  const NOW = new Date('2026-03-05T10:00:00Z');

  let clock: sinon.SinonFakeTimers;
  let fakeGetActiveReservations: sinon.SinonStub;
  let fakeUpdateReservationStatus: sinon.SinonStub;
  let fakeBookWithRetry: sinon.SinonStub;
  let scheduler: any;

  beforeEach(async () => {
    // Freeze time so dayjs() returns a predictable "now"
    clock = sinon.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'Date'] });

    fakeGetActiveReservations = sinon.stub();
    fakeUpdateReservationStatus = sinon.stub().resolves();
    fakeBookWithRetry = sinon.stub().resolves({ success: true, confirmationCode: 'CONF-123' });

    // Load the scheduler with all external dependencies mocked out so the
    // test process never connects to a database or starts a WebSocket server.
    // First arg is relative to this test file (tests/ → src/scheduler/index.ts).
    // These are passed as esmock's third ("global") argument, not the second,
    // because index.ts no longer imports database/ws/poller/resy-client
    // directly — it delegates the actual fire logic to scheduler/pipeline.ts,
    // which imports them instead. Global mocks apply anywhere in the import
    // tree regardless of which file does the importing; the second-argument
    // form only intercepts imports made directly by the target module itself.
    scheduler = await esmock('../src/scheduler/index.ts', {}, {
      '../src/database.js': {
        getActiveReservations: fakeGetActiveReservations,
        getAllReservations: sinon.stub().returns([]),
        getReservation: sinon.stub().resolves(null),
        updateReservationStatus: fakeUpdateReservationStatus,
        updateReservation: sinon.stub(),
      },
      '../src/ws.js': {
        wss: { clients: new Set() },
        broadcastToFrontend: sinon.stub(),
      },
      '../src/scheduler/poller.js': {
        bookWithRetry: fakeBookWithRetry,
        setPrewarmedSlots: sinon.stub(),
        setPrewarmedBookToken: sinon.stub(),
        findBestSlot: sinon.stub().returns(null), // prewarm bails out on null
      },
      '../src/api/resy-client.js': {
        getAvailability: sinon.stub().resolves([]),
        getBookToken: sinon.stub().resolves('tok-prewarm'),
        validateToken: sinon.stub().resolves(true),
      },
      'node-cron': {
        default: { schedule: sinon.stub() }, // prevent real cron from starting
      },
    });
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
    esmock.purge(scheduler);
  });

  // -------------------------------------------------------------------------
  // getFireTime — pure computation, no side effects
  // -------------------------------------------------------------------------

  describe('getFireTime', () => {
    it('returns a time in the past when the booking window has already opened', () => {
      // targetDate 2026-04-04, 30-day window at 00:00 UTC
      // → fireAt = 2026-03-05T00:00:01Z, which is 10 hours before "now"
      const reservation = makeReservation();
      const fireAt = scheduler.getFireTime(reservation);

      assert.isTrue(
        fireAt.isBefore(dayjs(NOW)),
        `expected fireAt (${fireAt.toISOString()}) to be before now (${NOW.toISOString()})`
      );
    });

    it('returns a time in the future when the booking window has not yet opened', () => {
      // releaseTime '11:00' UTC → fireAt = 2026-03-05T11:00:01Z, which is 1 hour after "now"
      const reservation = makeReservation({
        bookingWindow: { daysInAdvance: 30, releaseTime: '11:00', timezone: 'UTC' },
      });
      const fireAt = scheduler.getFireTime(reservation);

      assert.isTrue(
        fireAt.isAfter(dayjs(NOW)),
        `expected fireAt (${fireAt.toISOString()}) to be after now (${NOW.toISOString()})`
      );
    });

    it('computes the correct delay in milliseconds', () => {
      // releaseTime '10:05' UTC → window opens at 2026-03-05T10:05:00.000Z → 300 000 ms from now
      const reservation = makeReservation({
        bookingWindow: { daysInAdvance: 30, releaseTime: '10:05', timezone: 'UTC' },
      });
      const fireAt = scheduler.getFireTime(reservation);
      const msUntilFire = fireAt.diff(dayjs(NOW), 'milliseconds');

      assert.closeTo(msUntilFire, 5 * 60 * 1000, 500, 'delay should be ~5 minutes exactly');
    });
  });

  // -------------------------------------------------------------------------
  // checkAndScheduleJobs — scheduling behaviour
  // -------------------------------------------------------------------------

  describe('checkAndScheduleJobs', () => {
    it('schedules an immediate booking when the window has already opened', async () => {
      // Window opened 10 hours ago → msUntilFire = 0 → setTimeout(fn, 0)
      fakeGetActiveReservations.returns([makeReservation()]);

      await scheduler.checkAndScheduleJobs();

      assert.equal(clock.countTimers(), 2, 'should have two pending timers (prewarm + fallback)');
      // tickAsync (rather than tick + a single microtask flush) because fire()
      // now awaits multiple async database calls before reaching bookWithRetry.
      await clock.tickAsync(0);

      assert.isTrue(fakeBookWithRetry.calledOnce, 'bookWithRetry should be called immediately');
      assert.isTrue(
        fakeUpdateReservationStatus.calledWith('res-1', 'polling'),
        'status should be set to polling'
      );
    });

    it('schedules a booking at the correct future time and does not fire early', async () => {
      // releaseTime '10:05' UTC → fires in ~5 minutes
      fakeGetActiveReservations.returns([
        makeReservation({
          bookingWindow: { daysInAdvance: 30, releaseTime: '10:05', timezone: 'UTC' },
        }),
      ]);

      await scheduler.checkAndScheduleJobs();

      assert.equal(clock.countTimers(), 2, 'should have two pending timers (prewarm + fallback)');
      await clock.tickAsync(4 * 60 * 1000);
      assert.isFalse(fakeBookWithRetry.called, 'should not book before the window opens');

      // 2 more minutes — window is now open, timer should fire
      await clock.tickAsync(2 * 60 * 1000);
      assert.isTrue(fakeBookWithRetry.calledOnce, 'should book once the window opens');
    });

    it('does not schedule a booking when the window is beyond the 10-minute horizon', async () => {
      // releaseTime '11:00' UTC → fires in 1 hour, well beyond the 10-min scheduling horizon
      fakeGetActiveReservations.returns([
        makeReservation({
          bookingWindow: { daysInAdvance: 30, releaseTime: '11:00', timezone: 'UTC' },
        }),
      ]);

      await scheduler.checkAndScheduleJobs();

      assert.equal(clock.countTimers(), 0, 'should not schedule anything beyond the horizon');
    });

    it('does not double-schedule a reservation that is already queued', async () => {
      fakeGetActiveReservations.returns([makeReservation()]);

      await scheduler.checkAndScheduleJobs();
      await scheduler.checkAndScheduleJobs(); // second call should be a no-op

      assert.equal(clock.countTimers(), 2, 'should still have exactly two timers (prewarm + fallback)');
    });

    it('skips reservations that are already booked or failed', async () => {
      fakeGetActiveReservations.returns([
        makeReservation({ status: 'booked' }),
        makeReservation({ id: 'res-2', status: 'failed' }),
      ]);

      await scheduler.checkAndScheduleJobs();

      assert.equal(clock.countTimers(), 0, 'should not schedule completed reservations');
    });
  });
});
