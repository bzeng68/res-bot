import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getActiveReservations, getAllReservations, getReservation, updateReservationStatus, updateReservation } from '../database.js';
import { bookWithRetry, setPrewarmedSlots, setPrewarmedBookToken, findBestSlot } from './poller.js';
import { getAvailability, getBookToken, validateToken } from '../api/resy-client.js';
import { wss } from '../ws.js';
import { sendSuccessEmail, sendFailureEmail } from '../utils/mailer.js';
import type { ReservationRequest } from '../../../shared/src/types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// Reservations queued to fire (reservationId -> timeoutId)
const scheduledJobs = new Map<string, NodeJS.Timeout>();

// Module-level guard: ensures only one fire() runs per reservation at a time,
// regardless of how many closures call fireSafe() (prewarm + fallback + cron re-entry).
const firingJobs = new Set<string>();

// Only schedule within this horizon to avoid huge setTimeout delays
// and survive server restarts (cron re-picks within 10 min).
const SCHEDULE_HORIZON_MS = 10 * 60 * 1000; // 10 minutes

// How many ms after the booking window opens to start the prewarm fetch.
// 500ms gives Resy's server time to process the release before we query slots.
const PREWARM_AFTER_WINDOW_MS = 500;

// If the prewarm errors or returns no slots, this fallback fires the booking
// directly (fresh fetches on the critical path).
// Pipeline: prewarm starts T+500ms, /4/find ~800ms, /3/details ~1500ms → done ~T+2800ms.
// 3500ms gives ~700ms of headroom for the prewarm to beat the fallback.
const FALLBACK_FIRE_MS = 3500;

export function startScheduler() {
  cron.schedule('*/10 * * * * *', checkAndScheduleJobs);
  // Validate auth tokens for all upcoming reservations: once at startup, then daily at 9 AM
  validateAllTokens();
  cron.schedule('0 9 * * *', validateAllTokens);
  console.log('⏰ Scheduler is running (checking every 10 seconds)');
}

/** Exported for testing. Computes the exact moment at which a booking attempt should fire. */
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

/** Exported for testing. Runs one scheduling pass over all active reservations. */
export function checkAndScheduleJobs() {
  const reservations = getActiveReservations();
  const now = dayjs();

  for (const reservation of reservations) {
    if (reservation.status === 'booked' || reservation.status === 'failed') continue;
    if (scheduledJobs.has(reservation.id)) continue;
    if (firingJobs.has(reservation.id)) continue; // already firing — don't double-schedule

    const windowOpensAt = getFireTime(reservation);
    const msUntilWindowOpens = Math.max(0, windowOpensAt.diff(now, 'milliseconds'));

    // If more than 10 minutes away, hold off — will be picked up in a future tick
    if (msUntilWindowOpens > SCHEDULE_HORIZON_MS) continue;

    if (msUntilWindowOpens === 0) {
      console.log(`⚡ Booking window already open for ${reservation.restaurantName} — firing now`);
    } else {
      console.log(
        `📅 Scheduling ${reservation.restaurantName} — window opens at ` +
        `${windowOpensAt.format('h:mm:ss.SSS A')} (in ${(msUntilWindowOpens / 1000).toFixed(3)}s)`
      );
    }

    // Strategy: instead of a fixed fire delay that races against the prewarm,
    // let the prewarm trigger fire() directly once slots + book_token are cached.
    // A fallback timer fires if the prewarm errors or returns no slots.
    // firedAlready prevents double-fire (e.g. with sinon fake timers in tests,
    // or if prewarm completes just as the fallback fires in prod).
    let firedAlready = false;
    let fallbackId: NodeJS.Timeout | undefined;

    function fireSafe() {
      if (firedAlready) return;
      firedAlready = true;
      // Module-level guard catches any race between concurrent cron ticks or
      // simultaneous prewarm+fallback fires (e.g. both setTimeout(0)).
      if (firingJobs.has(reservation.id)) return;
      firingJobs.add(reservation.id);
      scheduledJobs.delete(reservation.id);
      fire(reservation).finally(() => firingJobs.delete(reservation.id));
    }

    // Prewarm: fetches /4/find PREWARM_AFTER_WINDOW_MS after window opens (so slots
    // are guaranteed to exist), then immediately pipelines /3/details for the best
    // slot's book_token. Once both are cached, fires the booking immediately.
    // When the window is already open, collapse both delays to 0 so the fallback
    // fires immediately (prewarm will get [] from the stub in tests, or real slots
    // in production where the window is already open).
    const prewarmDelay = msUntilWindowOpens === 0 ? 0 : msUntilWindowOpens + PREWARM_AFTER_WINDOW_MS;
    setTimeout(async () => {
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

        clearTimeout(fallbackId);
        fireSafe();
      } catch { /* prewarm failed — fallback timer will handle it */ }
    }, prewarmDelay);

    // Fallback: fires if prewarm fails, errors, or returns no slots
    fallbackId = setTimeout(() => {
      console.log(`⏰ Fallback fire for ${reservation.restaurantName} (prewarm did not complete in time)`);
      fireSafe();
    }, msUntilWindowOpens === 0 ? 0 : msUntilWindowOpens + FALLBACK_FIRE_MS);
    scheduledJobs.set(reservation.id, fallbackId);
  }
}

async function fire(reservation: ReservationRequest) {
  scheduledJobs.delete(reservation.id);
  updateReservationStatus(reservation.id, 'polling');
  broadcastUpdate(reservation.id, 'booking_started', {
    restaurantName: reservation.restaurantName,
    targetDate: reservation.targetDate,
  });

  console.log(`🚀 Firing booking for ${reservation.restaurantName} (${reservation.targetDate})`);

  const result = await bookWithRetry(reservation);

  if (result.success) {
    result.timeToBookMs = Date.now() - getFireTime(reservation).valueOf();
    updateReservationStatus(reservation.id, 'booked', result);
    broadcastUpdate(reservation.id, 'booking_success', {
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
    updateReservationStatus(reservation.id, 'failed', result);
    broadcastUpdate(reservation.id, 'booking_failed', {
      restaurantName: reservation.restaurantName,
      error: result.error,
    });
    console.log(`❌ Failed to book ${reservation.restaurantName}: ${result.error}`);
    const failed = getReservation(reservation.id);
    sendFailureEmail({
      restaurantName: reservation.restaurantName,
      targetDate: reservation.targetDate,
      error: result.error,
      attempts: failed?.bookingAttempts,
    }).catch(() => {/* already logged inside */});
  }
}

function broadcastUpdate(jobId: string, type: string, data: any) {
  const message = JSON.stringify({ type, jobId, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) client.send(message);
  });
}

export function stopJobForReservation(reservationId: string) {
  const timeoutId = scheduledJobs.get(reservationId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    scheduledJobs.delete(reservationId);
    console.log(`⏹️ Cancelled scheduled booking for reservation ${reservationId}`);
  }
}

/** Check auth tokens for all upcoming (scheduled) reservations and update tokenStatus. */
async function validateAllTokens() {
  const all = getAllReservations();
  const upcoming = all.filter(r => r.status === 'scheduled');
  if (upcoming.length === 0) return;

  console.log(`🔑 Validating auth tokens for ${upcoming.length} upcoming reservation(s)...`);

  for (const reservation of upcoming) {
    const authToken = reservation.credentials?.authToken;
    if (!authToken) continue;

    const valid = await validateToken(authToken);
    const newStatus = valid ? 'valid' : 'invalid';

    if (reservation.tokenStatus !== newStatus) {
      updateReservation(reservation.id, { tokenStatus: newStatus });
      broadcastUpdate(reservation.id, 'token_status', { tokenStatus: newStatus });
      console.log(`🔑 ${reservation.restaurantName}: token ${newStatus}`);
    }
  }
}
