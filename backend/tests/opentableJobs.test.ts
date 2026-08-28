import { describe, it } from 'mocha';
import { assert } from 'chai';
import { isOpenTableJobDue, OPENTABLE_JOB_LOOKAHEAD_MS } from '../src/utils/opentableJobs.js';

function makeReservation(overrides?: Record<string, any>): any {
  return {
    id: 'res-1',
    restaurantId: 'gyu-kaku',
    restaurantName: 'Gyu-Kaku',
    platform: 'opentable',
    targetDate: '2026-09-02',
    timeRange: { start: '17:00', end: '21:00' },
    partySize: 2,
    userEmail: 'test@test.com',
    status: 'scheduled',
    createdAt: '2026-08-25T00:00:00Z',
    scheduledPollTime: '2026-08-25T12:00:00.000Z',
    ...overrides,
  };
}

describe('isOpenTableJobDue', () => {
  const fireAt = Date.parse('2026-08-25T12:00:00.000Z');

  it('excludes non-opentable reservations regardless of timing', () => {
    const reservation = makeReservation({ platform: 'resy' });
    assert.isFalse(isOpenTableJobDue(reservation, fireAt));
  });

  it('excludes reservations not in a pollable status', () => {
    for (const status of ['booked', 'failed', 'cancelled']) {
      assert.isFalse(isOpenTableJobDue(makeReservation({ status }), fireAt), `status=${status}`);
    }
  });

  it('excludes a job scheduled further out than the lookahead window', () => {
    const now = fireAt - OPENTABLE_JOB_LOOKAHEAD_MS - 1;
    assert.isFalse(isOpenTableJobDue(makeReservation(), now));
  });

  it('includes a job right at the edge of the lookahead window', () => {
    const now = fireAt - OPENTABLE_JOB_LOOKAHEAD_MS;
    assert.isTrue(isOpenTableJobDue(makeReservation(), now));
  });

  it('includes a job that is already due', () => {
    assert.isTrue(isOpenTableJobDue(makeReservation(), fireAt));
    assert.isTrue(isOpenTableJobDue(makeReservation(), fireAt + 60_000));
  });

  it('includes a job already in polling status within the window', () => {
    const reservation = makeReservation({ status: 'polling' });
    assert.isTrue(isOpenTableJobDue(reservation, fireAt));
  });

  it('treats a missing scheduledPollTime as immediately due', () => {
    const reservation = makeReservation({ scheduledPollTime: undefined });
    assert.isTrue(isOpenTableJobDue(reservation, fireAt - OPENTABLE_JOB_LOOKAHEAD_MS - 1_000_000));
  });
});
