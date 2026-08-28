import type { ReservationRequest } from '../../../shared/src/types.js';

// How far ahead of a job's scheduledPollTime the runner is allowed to see it.
// The Tampermonkey runner uses this window to precisely setTimeout-wait out
// the remainder itself, instead of only discovering a due job at its next
// poll tick (which could add up to a full poll interval of extra lag on top
// of the intended fire time).
export const OPENTABLE_JOB_LOOKAHEAD_MS = 10_000;

export function isOpenTableJobDue(reservation: ReservationRequest, now: number = Date.now()): boolean {
  if (reservation.platform !== 'opentable') return false;
  if (reservation.status !== 'scheduled' && reservation.status !== 'polling') return false;
  if (!reservation.scheduledPollTime) return true;

  const fireAt = Date.parse(reservation.scheduledPollTime);
  return now >= fireAt - OPENTABLE_JOB_LOOKAHEAD_MS;
}
