import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getActiveReservations, getAllReservations, updateReservation } from '../database.js';
import { validateToken } from '../api/resy-client.js';
import { wss } from '../ws.js';
import { runBookingPipeline, isFiring, getFireTime } from './pipeline.js';
import { isCloudTasksEnabled } from '../utils/tasksQueue.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export { getFireTime };

// Reservations queued to fire (reservationId -> cancel function for its timers)
const scheduledJobs = new Map<string, () => void>();

// Only schedule within this horizon to avoid huge setTimeout delays
// and survive server restarts (cron re-picks within 10 min).
const SCHEDULE_HORIZON_MS = 10 * 60 * 1000; // 10 minutes

export function startScheduler() {
  // In Cloud Tasks mode, the worker service fires bookings — this process
  // only needs to keep validating tokens, not also race the worker to fire.
  if (!isCloudTasksEnabled()) {
    cron.schedule('*/10 * * * * *', checkAndScheduleJobs);
    console.log('⏰ Scheduler is running (checking every 10 seconds)');
  } else {
    console.log('⏰ Cloud Tasks mode enabled — booking firing is delegated to the worker service');
  }

  // Validate auth tokens for all upcoming reservations: once at startup, then daily at 9 AM
  validateAllTokens();
  cron.schedule('0 9 * * *', validateAllTokens);
}

/** Exported for testing. Runs one scheduling pass over all active reservations. */
export async function checkAndScheduleJobs() {
  const reservations = await getActiveReservations();
  const now = dayjs();

  for (const reservation of reservations) {
    if (reservation.status === 'booked' || reservation.status === 'failed') continue;
    if (scheduledJobs.has(reservation.id)) continue;
    if (isFiring(reservation.id)) continue; // already firing — don't double-schedule

    const windowOpensAt = getFireTime(reservation);
    const msUntilWindowOpens = Math.max(0, windowOpensAt.diff(now, 'milliseconds'));

    // If more than 10 minutes away, hold off — will be picked up in a future tick
    if (msUntilWindowOpens > SCHEDULE_HORIZON_MS) continue;

    const { promise, cancel } = runBookingPipeline(reservation);
    scheduledJobs.set(reservation.id, cancel);
    promise.finally(() => scheduledJobs.delete(reservation.id));
  }
}

export function stopJobForReservation(reservationId: string) {
  const cancel = scheduledJobs.get(reservationId);
  if (cancel) {
    cancel();
    scheduledJobs.delete(reservationId);
    console.log(`⏹️ Cancelled scheduled booking for reservation ${reservationId}`);
  }
}

/** Check auth tokens for all upcoming (scheduled) reservations and update tokenStatus. */
async function validateAllTokens() {
  const all = await getAllReservations();
  const upcoming = all.filter(r => r.status === 'scheduled');
  if (upcoming.length === 0) return;

  console.log(`🔑 Validating auth tokens for ${upcoming.length} upcoming reservation(s)...`);

  for (const reservation of upcoming) {
    const authToken = reservation.credentials?.authToken;
    if (!authToken) continue;

    const valid = await validateToken(authToken);
    const newStatus = valid ? 'valid' : 'invalid';

    if (reservation.tokenStatus !== newStatus) {
      await updateReservation(reservation.id, { tokenStatus: newStatus });
      broadcastUpdate(reservation.id, 'token_status', { tokenStatus: newStatus });
      console.log(`🔑 ${reservation.restaurantName}: token ${newStatus}`);
    }
  }
}

function broadcastUpdate(jobId: string, type: string, data: any) {
  const message = JSON.stringify({ type, jobId, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) client.send(message);
  });
}
