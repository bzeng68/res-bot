import { describe, it, before, after } from 'mocha';
import { assert } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { AvailableSlot, ReservationRequest } from '../../shared/src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlot(time: string, slotId?: string, tableType?: string): AvailableSlot {
  return {
    time,
    date: '2026-04-04',
    partySize: 2,
    tableType,
    slotId: slotId ?? `slot-${time}`,
  };
}

function makeReservation(overrides?: Record<string, any>): ReservationRequest {
  return {
    id: 'res-1',
    restaurantId: '64593',
    restaurantName: 'Torrisi',
    targetDate: '2026-04-10',
    timeRange: { start: '17:30', end: '22:00', preferredTimes: ['18:00', '19:00'] },
    partySize: 2,
    userEmail: 'user@resy.com',
    credentials: { platform: 'resy', authToken: 'valid-token' },
    status: 'scheduled',
    createdAt: '2026-03-11T02:06:11.675Z',
    bookingWindow: { daysInAdvance: 30, releaseTime: '10:00', timezone: 'America/New_York' },
    ...overrides,
  } as ReservationRequest;
}

function makeAxiosError(status: number, body: object = {}) {
  const err: any = new Error(`HTTP ${status}`);
  err.response = { status, data: body };
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('poller', () => {
  let poller: any;
  let findBestSlot: (slots: AvailableSlot[], start: string, end: string, preferred?: string[], excludeSlotIds?: Set<string>) => AvailableSlot | null;

  before(async () => {
    // Load only the bits we need; stub out all I/O-touching dependencies.
    poller = await esmock('../src/scheduler/poller.ts', {
      '../src/api/resy-client.js': {
        getAvailability: sinon.stub().resolves([]),
        bookReservation: sinon.stub().resolves({ confirmationCode: 'X', reservationDetails: {} }),
        resyClient: { getPaymentMethodId: sinon.stub().resolves(null) },
      },
      '../src/database.js': { addBookingAttempt: sinon.stub() },
      '../src/ws.js': { broadcastToFrontend: sinon.stub() },
    });
    findBestSlot = poller.findBestSlot;
  });

  after(() => { esmock.purge(poller); });

  describe('findBestSlot', () => {
    it('returns null when no slots are available', () => {
      assert.isNull(findBestSlot([], '18:00', '21:00'));
    });

    it('returns null when no slots fall within the time range', () => {
      const slots = [makeSlot('17:00'), makeSlot('21:30')];
      assert.isNull(findBestSlot(slots, '18:00', '21:00'));
    });

    it('returns the first valid slot when no preferred times are given', () => {
      const slots = [makeSlot('18:00'), makeSlot('19:00'), makeSlot('20:00')];
      const result = findBestSlot(slots, '18:00', '21:00');
      assert.equal(result?.time, '18:00');
    });

    it('prefers an earlier preferred time over the first available slot', () => {
      const slots = [makeSlot('18:00'), makeSlot('19:00'), makeSlot('20:00')];
      // '19:00' is preferred even though '18:00' comes first in the list
      const result = findBestSlot(slots, '18:00', '21:00', ['19:00']);
      assert.equal(result?.time, '19:00');
    });

    it('respects preferred time priority order — picks the first match', () => {
      const slots = [makeSlot('18:00'), makeSlot('19:00'), makeSlot('20:00')];
      // Both '20:00' and '19:00' are available; '20:00' is listed first in preferences
      const result = findBestSlot(slots, '18:00', '21:00', ['20:00', '19:00']);
      assert.equal(result?.time, '20:00', 'should pick the highest-priority preferred time');
    });

    it('falls back to first valid slot when none of the preferred times are available', () => {
      const slots = [makeSlot('18:00'), makeSlot('19:30')];
      const result = findBestSlot(slots, '18:00', '21:00', ['20:00', '21:00']);
      assert.equal(result?.time, '18:00', 'should fall back to first valid slot');
    });

    it('treats the time range boundaries as inclusive', () => {
      const slots = [makeSlot('18:00'), makeSlot('21:00')];
      const result = findBestSlot(slots, '18:00', '21:00');
      assert.equal(result?.time, '18:00');

      const result2 = findBestSlot([makeSlot('21:00')], '18:00', '21:00');
      assert.equal(result2?.time, '21:00', 'end boundary should be inclusive');
    });

    it('ignores preferred times that fall outside the time range', () => {
      const slots = [makeSlot('18:00'), makeSlot('19:00')];
      // '17:00' is preferred but outside the range — should fall through to first valid
      const result = findBestSlot(slots, '18:00', '21:00', ['17:00', '19:00']);
      assert.equal(result?.time, '19:00', 'should skip out-of-range preferred time and pick next match');
    });

    it('skips slots in the excludeSlotIds set', () => {
      const slots = [makeSlot('18:00', 'slot-A'), makeSlot('19:00', 'slot-B'), makeSlot('20:00', 'slot-C')];
      const exclude = new Set(['slot-A']);
      const result = findBestSlot(slots, '18:00', '21:00', undefined, exclude);
      assert.equal(result?.time, '19:00', 'should skip excluded slot and return next valid');
    });

    it('returns null when all valid slots are excluded', () => {
      const slots = [makeSlot('18:00', 'slot-A'), makeSlot('19:00', 'slot-B')];
      const exclude = new Set(['slot-A', 'slot-B']);
      assert.isNull(findBestSlot(slots, '18:00', '21:00', undefined, exclude));
    });

    it('prefers Dining Room over a preferred time at a non-dining-room table', () => {
      const slots = [
        makeSlot('18:00', 'slot-A', 'Bar'),       // preferred time, but Bar
        makeSlot('19:00', 'slot-B', 'Dining Room'), // not preferred, but Dining Room
      ];
      const result = findBestSlot(slots, '18:00', '21:00', ['18:00']);
      assert.equal(result?.slotId, 'slot-B', 'Dining Room at 19:00 should beat Bar at preferred 18:00');
    });

    it('picks preferred time within Dining Room when available', () => {
      const slots = [
        makeSlot('18:00', 'slot-A', 'Dining Room'),
        makeSlot('19:00', 'slot-B', 'Dining Room'),
        makeSlot('19:00', 'slot-C', 'Bar'),
      ];
      const result = findBestSlot(slots, '18:00', '21:00', ['19:00']);
      assert.equal(result?.slotId, 'slot-B', 'should pick Dining Room at 19:00 (preferred)');
    });

    it('falls back to preferred time at other table when no Dining Room exists', () => {
      const slots = [
        makeSlot('18:00', 'slot-A', 'Bar'),
        makeSlot('19:00', 'slot-B', 'Bar'),
      ];
      const result = findBestSlot(slots, '18:00', '21:00', ['19:00']);
      assert.equal(result?.slotId, 'slot-B', 'should pick preferred time at Bar when no Dining Room');
    });

    it('falls back to first valid non-dining-room slot when nothing preferred exists', () => {
      const slots = [
        makeSlot('18:00', 'slot-A', 'Bar'),
        makeSlot('19:00', 'slot-B', 'Patio'),
      ];
      const result = findBestSlot(slots, '18:00', '21:00');
      assert.equal(result?.slotId, 'slot-A');
    });
  });

  // -------------------------------------------------------------------------
  // bookWithRetry — retry and bail-out behaviour
  // -------------------------------------------------------------------------

  describe('bookWithRetry', () => {
    let pollerWithBookStub: any;
    let bookReservationStub: sinon.SinonStub;
    let getAvailabilityStub: sinon.SinonStub;
    let getPaymentMethodIdStub: sinon.SinonStub;
    let bookWithRetry: (r: ReservationRequest) => Promise<any>;

    before(async () => {
      bookReservationStub = sinon.stub();
      getAvailabilityStub = sinon.stub();
      getPaymentMethodIdStub = sinon.stub().resolves(42);

      pollerWithBookStub = await esmock('../src/scheduler/poller.ts', {
        '../src/api/resy-client.js': {
          getAvailability: getAvailabilityStub,
          bookReservation: bookReservationStub,
          resyClient: { getPaymentMethodId: getPaymentMethodIdStub },
        },
        '../src/database.js': { addBookingAttempt: sinon.stub() },
        '../src/ws.js': { broadcastToFrontend: sinon.stub() },
      });
      bookWithRetry = pollerWithBookStub.bookWithRetry;
    });

    after(() => { esmock.purge(pollerWithBookStub); });

    beforeEach(() => {
      bookReservationStub.reset();
      getAvailabilityStub.reset();
      getPaymentMethodIdStub.reset();
      getPaymentMethodIdStub.resolves(42);
    });

    it('returns failure immediately on HTTP 419 without retrying', async () => {
      getAvailabilityStub.resolves([makeSlot('22:00', 'slot-22')]);
      bookReservationStub.rejects(makeAxiosError(419, { status: 419, message: 'Unauthorized' }));

      const result = await bookWithRetry(makeReservation());

      assert.isFalse(result.success);
      assert.include(result.error, '419');
      assert.equal(bookReservationStub.callCount, 1, 'should NOT retry after 419');
    });

    it('returns failure immediately on HTTP 401 without retrying', async () => {
      getAvailabilityStub.resolves([makeSlot('18:00', 'slot-18')]);
      bookReservationStub.rejects(makeAxiosError(401));

      const result = await bookWithRetry(makeReservation());

      assert.isFalse(result.success);
      assert.equal(bookReservationStub.callCount, 1, 'should NOT retry after 401');
    });

    it('returns failure immediately on HTTP 403 without retrying', async () => {
      getAvailabilityStub.resolves([makeSlot('18:00', 'slot-18')]);
      bookReservationStub.rejects(makeAxiosError(403));

      const result = await bookWithRetry(makeReservation());

      assert.isFalse(result.success);
      assert.equal(bookReservationStub.callCount, 1, 'should NOT retry after 403');
    });

    it('retries on HTTP 404 (slot taken) and picks next slot from pool', async () => {
      getAvailabilityStub.resolves([
        makeSlot('18:00', 'slot-18'),
        makeSlot('19:00', 'slot-19'),
      ]);
      bookReservationStub
        .onFirstCall().rejects(makeAxiosError(404))
        .onSecondCall().resolves({ confirmationCode: 'CONF-OK', reservationDetails: {} });

      const result = await bookWithRetry(makeReservation());

      assert.isTrue(result.success);
      assert.equal(result.confirmationCode, 'CONF-OK');
      assert.equal(bookReservationStub.callCount, 2, 'should retry once after 404');
    });

    it('returns failure immediately when no auth token is present', async () => {
      const result = await bookWithRetry(makeReservation({ credentials: { platform: 'resy' } }));

      assert.isFalse(result.success);
      assert.include(result.error, 'No Resy auth token');
      assert.equal(bookReservationStub.callCount, 0);
    });
  });
});
