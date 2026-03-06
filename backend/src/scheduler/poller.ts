import { getAvailability, bookReservation, resyClient } from '../api/resy-client.js';
import { addBookingAttempt } from '../database.js';
import { broadcastToFrontend } from '../ws.js';
import type { ReservationRequest, BookingResult, AvailableSlot } from '../../../shared/src/types.js';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500; // Keep tight — slots disappear in seconds on busy nights

// ─── Prewarm Cache ──────────────────────────────────────────────────────────
// The scheduler populates both caches ~500ms before the fire time:
//   - prewarmCache: slots from /4/find  (~400ms saved)
//   - bookTokenCache: book_token from /3/details  (~1.5s saved)
const prewarmCache = new Map<string, { slots: AvailableSlot[]; fetchedAt: number }>();
const bookTokenCache = new Map<string, { token: string; slotId: string; fetchedAt: number }>();

/** Called by the scheduler with /4/find results just before fire time. */
export function setPrewarmedSlots(reservationId: string, slots: AvailableSlot[]): void {
  prewarmCache.set(reservationId, { slots, fetchedAt: Date.now() });
}

/** Called by the scheduler with the /3/details book_token just before fire time. */
export function setPrewarmedBookToken(reservationId: string, token: string, slotId: string): void {
  bookTokenCache.set(reservationId, { token, slotId, fetchedAt: Date.now() });
}

/** Consume cached slots (one-shot, 3s TTL, must be non-empty to count as a hit). */
function consumePrewarmedSlots(reservationId: string): AvailableSlot[] | null {
  const cached = prewarmCache.get(reservationId);
  prewarmCache.delete(reservationId);
  if (!cached || cached.slots.length === 0) return null;
  if (Date.now() - cached.fetchedAt > 3000) return null;
  return cached.slots;
}

/** Consume cached book_token (one-shot, 30s TTL to stay well within Resy's expiry). */
function consumePrewarmedBookToken(reservationId: string, currentSlotId: string): string | null {
  const cached = bookTokenCache.get(reservationId);
  bookTokenCache.delete(reservationId);
  if (!cached) return null;
  if (cached.slotId !== currentSlotId) return null; // slot changed (e.g. it disappeared)
  if (Date.now() - cached.fetchedAt > 30_000) return null; // stale
  return cached.token;
}

/**
 * Attempt to book a reservation up to MAX_RETRIES times.
 * Call this once the booking window has already opened.
 */
export async function bookWithRetry(reservation: ReservationRequest): Promise<BookingResult> {
  const authToken = reservation.credentials?.authToken;

  if (!authToken) {
    const msg = 'No Resy auth token. Please re-save the reservation with a valid token.';
    logAttempt(reservation.id, { action: 'error', slotDate: reservation.targetDate, message: msg });
    return { success: false, error: msg };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`🎯 Booking attempt ${attempt}/${MAX_RETRIES} for ${reservation.restaurantName}...`);

    try {
      // Use prewarm cache on first attempt to eliminate the /4/find and /3/details round-trips.
      // Run payment fetch in parallel with availability — even if both are cache misses,
      // the two ~400ms fetches overlap instead of stacking.
      const prewarmHit = attempt === 1 ? consumePrewarmedSlots(reservation.id) : null;
      const cachedPaymentId = reservation.credentials?.paymentMethodId;

      const availabilityFetch = prewarmHit
        ? Promise.resolve(prewarmHit)
        : getAvailability(reservation.restaurantId, reservation.targetDate, reservation.partySize);

      const paymentFetch = cachedPaymentId != null
        ? Promise.resolve(cachedPaymentId)
        : resyClient.getPaymentMethodId(authToken);

      const [slots, resolvedPaymentId] = await Promise.all([availabilityFetch, paymentFetch]);

      if (prewarmHit) console.log(`⚡ Used prewarm cache (${slots.length} slots, skipped /4/find)`);
      if (cachedPaymentId != null) console.log(`💳 Used cached payment ID (skipped /2/user)`);

      const slots_log = prewarmHit ? `prewarm (${slots.length})` : `fresh (${slots.length})`;
      logAttempt(reservation.id, {
        action: 'found_slot',
        slotDate: reservation.targetDate,
        message: `Attempt ${attempt}: found ${slots.length} slots (${slots_log})`,
        details: { slotCount: slots.length, availableTimes: slots.map(s => s.time).slice(0, 10) },
      });

      // 2. Find a slot in the requested time range
      const slot = findBestSlot(
        slots,
        reservation.timeRange.start,
        reservation.timeRange.end,
        reservation.timeRange.preferredTimes
      );

      if (!slot) {
        const available = [...new Set(slots.map(s => s.time))].sort().join(', ') || 'none';
        const msg = `Attempt ${attempt}: no slot in ${reservation.timeRange.start}–${reservation.timeRange.end}. Available: ${available}`;
        logAttempt(reservation.id, { action: 'error', slotDate: reservation.targetDate, message: msg });
        if (attempt < MAX_RETRIES) {
          console.log(`⏳ Retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await sleep(RETRY_DELAY_MS);
        }
        continue;
      }

      // 3. Attempt to book — use cached book_token on first attempt to skip /3/details
      const cachedBookToken = attempt === 1 ? consumePrewarmedBookToken(reservation.id, slot.slotId) : null;
      if (cachedBookToken) console.log(`⚡ Used cached book_token (skipped /3/details)`);

      logAttempt(reservation.id, {
        action: 'booking',
        slotTime: slot.time,
        slotDate: slot.date,
        message: `Attempt ${attempt}: booking slot at ${slot.time}${cachedBookToken ? ' (cached book_token)' : ''}`,
        details: { slotId: slot.slotId, partySize: reservation.partySize },
      });

      const result = await bookReservation(
        slot.slotId,
        reservation.partySize,
        reservation.restaurantId,
        authToken,
        resolvedPaymentId ?? undefined,
        cachedBookToken ?? undefined,
      );

      logAttempt(reservation.id, {
        action: 'success',
        slotTime: slot.time,
        slotDate: slot.date,
        message: `Successfully booked on attempt ${attempt}`,
        details: { confirmationCode: result.confirmationCode },
      });

      broadcastToFrontend({
        type: 'BOOKING_UPDATE',
        data: {
          reservationId: reservation.id,
          status: 'confirmed',
          confirmationCode: result.confirmationCode,
          reservationDetails: result.reservationDetails,
        },
      });

      return { success: true, confirmationCode: result.confirmationCode };

    } catch (err: any) {
      const httpStatus = err.response?.status;
      const errBody = err.response?.data;
      const msg = httpStatus
        ? `Attempt ${attempt}: HTTP ${httpStatus} — ${JSON.stringify(errBody)}`
        : `Attempt ${attempt}: ${err.message || 'unknown error'}`;

      console.error(`❌ ${msg}`);
      logAttempt(reservation.id, {
        action: 'error',
        message: `Booking failed: ${msg}`,
        details: { httpStatus, body: errBody },
      });

      // Don't retry auth errors
      if (httpStatus === 401 || httpStatus === 403) {
        const authErr = `Authentication failed (HTTP ${httpStatus}). Your token may have expired.`;
        broadcastToFrontend({
          type: 'BOOKING_UPDATE',
          data: { reservationId: reservation.id, status: 'failed', error: authErr },
        });
        return { success: false, error: authErr };
      }

      if (attempt < MAX_RETRIES) {
        console.log(`⏳ Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const finalError = `Failed after ${MAX_RETRIES} attempts. No matching slot for ${reservation.timeRange.start}–${reservation.timeRange.end} on ${reservation.targetDate}.`;
  broadcastToFrontend({
    type: 'BOOKING_UPDATE',
    data: { reservationId: reservation.id, status: 'failed', error: finalError },
  });
  return { success: false, error: finalError };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function logAttempt(
  reservationId: string,
  opts: {
    action: 'found_slot' | 'booking' | 'success' | 'error';
    slotTime?: string;
    slotDate?: string;
    message: string;
    details?: any;
  }
) {
  addBookingAttempt(reservationId, {
    timestamp: new Date().toISOString(),
    slotTime: opts.slotTime || '',
    slotDate: opts.slotDate || '',
    action: opts.action,
    message: opts.message,
    details: opts.details,
  });
}

export function findBestSlot(
  slots: AvailableSlot[],
  startTime: string,
  endTime: string,
  preferredTimes?: string[]
): AvailableSlot | null {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);

  const valid = slots.filter(s => {
    const m = timeToMinutes(s.time);
    return m >= startMin && m <= endMin;
  });

  if (valid.length === 0) return null;

  if (preferredTimes?.length) {
    for (const t of preferredTimes) {
      const match = valid.find(s => s.time === t);
      if (match) return match;
    }
  }

  return valid[0];
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
