import { describe, it } from 'mocha';
import { assert } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { AvailableSlot } from '../../../shared/src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlot(time: string, slotId?: string): AvailableSlot {
  return {
    time,
    date: '2026-04-04',
    partySize: 2,
    slotId: slotId ?? `slot-${time}`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('poller', () => {
  let poller: any;
  let findBestSlot: (slots: AvailableSlot[], start: string, end: string, preferred?: string[], excludeSlotIds?: Set<string>) => AvailableSlot | null;

  before(async () => {
    // Load only the bits we need; stub out all I/O-touching dependencies.
    poller = await esmock('../scheduler/poller.ts', {
      '../api/resy-client.js': {
        getAvailability: sinon.stub().resolves([]),
        bookReservation: sinon.stub().resolves({ confirmationCode: 'X', reservationDetails: {} }),
        resyClient: { getPaymentMethodId: sinon.stub().resolves(null) },
      },
      '../database.js': { addBookingAttempt: sinon.stub() },
      '../ws.js': { broadcastToFrontend: sinon.stub() },
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
  });
});
