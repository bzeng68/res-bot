/**
 * The per-reservation "wait for the booking window, prewarm, fire, report
 * the result" pipeline. This is intentionally decoupled from *how* a
 * reservation gets to this point — the in-process cron scheduler
 * (scheduler/index.ts) calls it directly for every active reservation on
 * each tick; the standalone worker service (worker.ts) calls it once, for
 * exactly one reservation, after being woken by a Cloud Tasks dispatch ~15
 * minutes before the window opens.
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getReservation, updateReservationStatus } from '../database.js';
import { bookWithRetry, setPrewarmedSlots, setPrewarmedBookToken, findBestSlot } from './poller.js';
import { getAvailability, getBookToken } from '../api/resy-client.js';
import { wss } from '../ws.js';
import { sendSuccessEmail, sendFailureEmail } from '../utils/mailer.js';
import type { ReservationRequest } from '../../../shared/src/types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// Module-level guard: ensures only one fire() runs per reservation at a time,
// regardless of how many callers race to invoke the pipeline for it
// (prewarm + fallback both firing, or overlapping cron ticks in-process).
// Note this only protects a single process — the worker relies on the
// Firestore `status` field (checked by its caller before invoking the
// pipeline) for cross-process/cross-invocation idempotency.
const firingJobs = new Set<string>();

export function isFiring(reservationId: string): boolean {
  return firingJobs.has(reservationId);
}

// How many ms after the booking window opens to start the prewarm fetch.
// 500ms gives Resy's server time to process the release before we query slots.
const PREWARM_AFTER_WINDOW_MS = 500;

// If the prewarm errors or returns no slots, this fallback fires the booking
// directly (fresh fetches on the critical path).
// Pipeline: prewarm starts T+500ms, /4/find ~800ms, /3/details ~1500ms → done ~T+2800ms.
// 3500ms gives ~700ms of headroom for the prewarm to beat the fallback.
const FALLBACK_FIRE_MS = 3500;

/** Computes the exact moment at which a booking attempt should fire. */
export function getFireTime(reservation: ReservationRequest): dayjs.Dayjs {
  if (!reservation.bookingWindow) return dayjs(); // open now

  const { daysInAdvance, releaseTime, timezone: tz } = reservation.bookingWindow;
  const [hours, minutes] = releaseTime.split(':').map(Number);

  return dayjs.tz(reservation.targetDate, tz)
    .subtract(daysInAdvance, 'days')
    .hour(hours)
    .minute(minutes)
    .second(0)
    .millisecond(0); // exact moment the booking window opens
}

/** Broadcasts a status update. Defaults to the control plane's own WS clients
 *  (wss is undefined in the worker process, where callers should pass their
 *  own notifier that posts back to the control plane instead). */
export type PipelineNotifier = (type: string, data: Record<string, unknown>) => void;

function defaultNotifier(jobId: string): PipelineNotifier {
  return (type, data) => {
    if (!wss) return; // no local WS clients in this process (e.g. the worker)
    const message = JSON.stringify({ type, jobId, data, timestamp: new Date().toISOString() });
    wss.clients.forEach((client: any) => {
      if (client.readyState === 1) client.send(message);
    });
  };
}

/**
 * Sets up the prewarm + fallback timers for one reservation and resolves
 * once the booking attempt (success or failure) has fully completed.
 * Returns a `cancel()` to tear down both timers early (e.g. on reservation
 * deletion) before they've fired.
 */
export function runBookingPipeline(
  reservation: ReservationRequest,
  notify: PipelineNotifier = defaultNotifier(reservation.id),
): { promise: Promise<void>; cancel: () => void } {
  const now = dayjs();
  const windowOpensAt = getFireTime(reservation);
  const msUntilWindowOpens = Math.max(0, windowOpensAt.diff(now, 'milliseconds'));

  if (msUntilWindowOpens === 0) {
    console.log(`⚡ Booking window already open for ${reservation.restaurantName} — firing now`);
  } else {
    console.log(
      `📅 Scheduling ${reservation.restaurantName} — window opens at ` +
      `${windowOpensAt.format('h:mm:ss.SSS A')} (in ${(msUntilWindowOpens / 1000).toFixed(3)}s)`
    );
  }

  let firedAlready = false;
  let prewarmId: NodeJS.Timeout;
  let fallbackId: NodeJS.Timeout;
  let resolvePromise: () => void;
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });

  // Strategy: instead of a fixed fire delay that races against the prewarm,
  // let the prewarm trigger fire() directly once slots + book_token are cached.
  // A fallback timer fires if the prewarm errors or returns no slots.
  // firedAlready prevents double-fire (e.g. with sinon fake timers in tests,
  // or if prewarm completes just as the fallback fires in prod).
  function fireSafe() {
    if (firedAlready) return;
    firedAlready = true;
    clearTimeout(prewarmId);
    clearTimeout(fallbackId);
    // Module-level guard catches any race between concurrent cron ticks or
    // simultaneous prewarm+fallback fires (e.g. both setTimeout(0)).
    if (firingJobs.has(reservation.id)) { resolvePromise(); return; }
    firingJobs.add(reservation.id);
    fire(reservation, notify).finally(() => {
      firingJobs.delete(reservation.id);
      resolvePromise();
    });
  }

  // Prewarm: fetches /4/find PREWARM_AFTER_WINDOW_MS after window opens (so slots
  // are guaranteed to exist), then immediately pipelines /3/details for the best
  // slot's book_token. Once both are cached, fires the booking immediately.
  // When the window is already open, collapse both delays to 0 so the fallback
  // fires immediately (prewarm will get [] from the stub in tests, or real slots
  // in production where the window is already open).
  const prewarmDelay = msUntilWindowOpens === 0 ? 0 : msUntilWindowOpens + PREWARM_AFTER_WINDOW_MS;
  prewarmId = setTimeout(async () => {
    try {
      const slots = await getAvailability(reservation.restaurantId, reservation.targetDate, reservation.partySize);
      setPrewarmedSlots(reservation.id, slots);

      if (slots.length === 0) return; // window not open yet — fallback handles it
      console.log(`🔥 Prewarm: ${slots.length} slots for ${reservation.restaurantName}`);

      const bestSlot = findBestSlot(
        slots,
        reservation.timeRange.start,
        reservation.timeRange.end,
        reservation.timeRange.preferredTimes,
      );
      if (!bestSlot) return; // no match in range — fallback fires

      const authToken = reservation.credentials?.authToken;
      if (!authToken) return;

      const bookToken = await getBookToken(bestSlot.slotId, reservation.partySize, reservation.restaurantId, authToken);
      setPrewarmedBookToken(reservation.id, bookToken, bestSlot.slotId);
      console.log(`⚡ Prewarm complete — firing immediately for ${reservation.restaurantName}`);

      fireSafe();
    } catch { /* prewarm failed — fallback timer will handle it */ }
  }, prewarmDelay);

  // Fallback: fires if prewarm fails, errors, or returns no slots
  fallbackId = setTimeout(() => {
    console.log(`⏰ Fallback fire for ${reservation.restaurantName} (prewarm did not complete in time)`);
    fireSafe();
  }, msUntilWindowOpens === 0 ? 0 : msUntilWindowOpens + FALLBACK_FIRE_MS);

  return {
    promise,
    cancel: () => {
      clearTimeout(prewarmId);
      clearTimeout(fallbackId);
    },
  };
}

async function fire(reservation: ReservationRequest, notify: PipelineNotifier) {
  // Fire-and-forget: bookWithRetry operates on the in-memory `reservation`
  // object, not Firestore's copy, so nothing downstream needs this write to
  // have landed first. Awaiting it would put a Firestore round-trip directly
  // in the timing-critical path, right where every millisecond matters.
  updateReservationStatus(reservation.id, 'polling')
    .catch(err => console.error('Failed to set status to polling:', err));
  notify('booking_started', {
    restaurantName: reservation.restaurantName,
    targetDate: reservation.targetDate,
  });

  console.log(`🚀 Firing booking for ${reservation.restaurantName} (${reservation.targetDate})`);

  const result = await bookWithRetry(reservation);

  if (result.success) {
    result.timeToBookMs = Date.now() - getFireTime(reservation).valueOf();
    await updateReservationStatus(reservation.id, 'booked', result);
    notify('booking_success', {
      restaurantName: reservation.restaurantName,
      bookedTime: result.bookedTime,
      confirmationCode: result.confirmationCode,
    });
    console.log(`✅ Booked ${reservation.restaurantName} — confirmation: ${result.confirmationCode}`);
    sendSuccessEmail({
      restaurantName: reservation.restaurantName,
      targetDate: reservation.targetDate,
      bookedTime: result.bookedTime,
      confirmationCode: result.confirmationCode,
      partySize: reservation.partySize,
    }).catch(() => {/* already logged inside */});
  } else {
    await updateReservationStatus(reservation.id, 'failed', result);
    notify('booking_failed', {
      restaurantName: reservation.restaurantName,
      error: result.error,
    });
    console.log(`❌ Failed to book ${reservation.restaurantName}: ${result.error}`);
    const failed = await getReservation(reservation.id);
    sendFailureEmail({
      restaurantName: reservation.restaurantName,
      targetDate: reservation.targetDate,
      error: result.error,
      attempts: failed?.bookingAttempts,
    }).catch(() => {/* already logged inside */});
  }
}
