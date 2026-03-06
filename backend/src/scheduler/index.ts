import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getActiveReservations, getAllReservations, updateReservationStatus, updateReservation } from '../database.js';
import { bookWithRetry, setPrewarmedSlots, setPrewarmedBookToken, findBestSlot } from './poller.js';
import { getAvailability, getBookToken, validateToken } from '../api/resy-client.js';
import { wss } from '../ws.js';
import type { ReservationRequest } from '../../../shared/src/types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// Reservations queued to fire (reservationId -> timeoutId)
const scheduledJobs = new Map<string, NodeJS.Timeout>();

// Only schedule within this horizon to avoid huge setTimeout delays
// and survive server restarts (cron re-picks within 10 min).
const SCHEDULE_HORIZON_MS = 10 * 60 * 1000; // 10 minutes

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
    .second(1); // 1 second after the window opens
}

/** Exported for testing. Runs one scheduling pass over all active reservations. */
export function checkAndScheduleJobs() {
  const reservations = getActiveReservations();
  const now = dayjs();

  for (const reservation of reservations) {
    if (reservation.status === 'booked' || reservation.status === 'failed') continue;
    if (scheduledJobs.has(reservation.id)) continue;

    const fireAt = getFireTime(reservation);
    const msUntilFire = Math.max(0, fireAt.diff(now, 'milliseconds'));

    // If more than 10 minutes away, hold off — will be picked up in a future tick
    if (msUntilFire > SCHEDULE_HORIZON_MS) continue;

    if (msUntilFire === 0) {
      console.log(`⚡ Booking window already open for ${reservation.restaurantName} — firing now`);
    } else {
      console.log(
        `📅 Scheduling ${reservation.restaurantName} to fire at ` +
        `${fireAt.format('h:mm:ss A')} (in ${Math.round(msUntilFire / 1000)}s)`
      );
    }

    const timeoutId = setTimeout(() => fire(reservation), msUntilFire);
    scheduledJobs.set(reservation.id, timeoutId);

    // Pre-warm: fetch availability ~500ms early, then immediately pipeline /3/details
    // for the best matching slot. By fire time both the slots and book_token are cached,
    // leaving only POST /3/book on the critical path.
    const prewarmDelay = Math.max(0, msUntilFire - 500);
    setTimeout(async () => {
      try {
        const slots = await getAvailability(reservation.restaurantId, reservation.targetDate, reservation.partySize);
        setPrewarmedSlots(reservation.id, slots);

        if (slots.length === 0) return; // Window not open yet — /4/find returned empty
        console.log(`🔥 Prewarm: ${slots.length} slots for ${reservation.restaurantName}`);

        // Find the best slot and immediately fetch its book_token
        const bestSlot = findBestSlot(
          slots,
          reservation.timeRange.start,
          reservation.timeRange.end,
          reservation.timeRange.preferredTimes,
        );
        if (!bestSlot) return; // No matching slot yet

        const authToken = reservation.credentials?.authToken;
        if (!authToken) return;

        const bookToken = await getBookToken(bestSlot.slotId, reservation.partySize, reservation.restaurantId, authToken);
        setPrewarmedBookToken(reservation.id, bookToken, bestSlot.slotId);
        console.log(`⚡ Prewarm complete: book_token cached for ${reservation.restaurantName}`);
      } catch { /* non-critical, normal path will fetch */ }
    }, prewarmDelay);
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
    const windowOpenedAt = getFireTime(reservation).subtract(1, 'second');
    result.timeToBookMs = Date.now() - windowOpenedAt.valueOf();
    updateReservationStatus(reservation.id, 'booked', result);
    broadcastUpdate(reservation.id, 'booking_success', {
      restaurantName: reservation.restaurantName,
      bookedTime: result.bookedTime,
      confirmationCode: result.confirmationCode,
    });
    console.log(`✅ Booked ${reservation.restaurantName} — confirmation: ${result.confirmationCode}`);
  } else {
    updateReservationStatus(reservation.id, 'failed', result);
    broadcastUpdate(reservation.id, 'booking_failed', {
      restaurantName: reservation.restaurantName,
      error: result.error,
    });
    console.log(`❌ Failed to book ${reservation.restaurantName}: ${result.error}`);
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
