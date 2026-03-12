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

  // Slot pool persisted across attempts. On a 404 (slot taken), we immediately try
  // the next untried slot from the same already-fetched pool at zero delay.
  // Only sleep + re-fetch /4/find when the pool is fully exhausted.
  let currentSlots: AvailableSlot[] | null = null;
  let resolvedPaymentId: number | null = null; // reused across attempts — never changes
  const failedSlotIds = new Set<string>();      // slots attempted this session
  let currentSlot: AvailableSlot | null = null; // visible to catch block

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`🎯 Booking attempt ${attempt}/${MAX_RETRIES} for ${reservation.restaurantName}...`);

    try {
      // ── 1. Get slots ──────────────────────────────────────────────────────
      const hasUntriedSlots = currentSlots?.some(s => !failedSlotIds.has(s.slotId)) ?? false;
      let slotsSource = '';

      if (!hasUntriedSlots) {
        // Pool exhausted (or first attempt) — fetch fresh
        const prewarmHit = attempt === 1 ? consumePrewarmedSlots(reservation.id) : null;
        const cachedPaymentId = reservation.credentials?.paymentMethodId;

        const availabilityFetch = prewarmHit
          ? Promise.resolve(prewarmHit)
          : getAvailability(reservation.restaurantId, reservation.targetDate, reservation.partySize);

        const paymentFetch = resolvedPaymentId != null
          ? Promise.resolve(resolvedPaymentId)
          : cachedPaymentId != null
            ? Promise.resolve(cachedPaymentId)
            : resyClient.getPaymentMethodId(authToken);

        const [freshSlots, paymentId] = await Promise.all([availabilityFetch, paymentFetch]);
        currentSlots = freshSlots;
        resolvedPaymentId = paymentId;
        failedSlotIds.clear(); // fresh pool — all slots eligible again

        if (prewarmHit) {
          console.log(`⚡ Used prewarm cache (${freshSlots.length} slots, skipped /4/find)`);
          slotsSource = `prewarm (${freshSlots.length})`;
        } else {
          slotsSource = `fresh (${freshSlots.length})`;
        }
        if (cachedPaymentId != null && attempt === 1) console.log(`💳 Used cached payment ID (skipped /2/user)`);
      } else {
        const remaining = currentSlots!.filter(s => !failedSlotIds.has(s.slotId)).length;
        slotsSource = `pool (${remaining} untried)`;
      }

      const slots = currentSlots!;

      // ── 2. Find best untried slot ─────────────────────────────────────────
      currentSlot = findBestSlot(
        slots,
        reservation.timeRange.start,
        reservation.timeRange.end,
        reservation.timeRange.preferredTimes,
        failedSlotIds,
      );

      logAttempt(reservation.id, {
        action: 'found_slot',
        slotDate: reservation.targetDate,
        slotTime: currentSlot?.time,
        message: `Attempt ${attempt}: found ${slots.length} slots (${slotsSource})`,
        details: {
          slotCount: slots.length,
          availableTimes: slots.map(s => s.time).slice(0, 10),
          selectedTime: currentSlot?.time ?? null,
        },
      });

      if (!currentSlot) {
        const available = [...new Set(slots.map(s => s.time))].sort().join(', ') || 'none';
        const msg = `Attempt ${attempt}: no slot in ${reservation.timeRange.start}–${reservation.timeRange.end}. Available: ${available}`;
        logAttempt(reservation.id, { action: 'error', slotDate: reservation.targetDate, message: msg });
        currentSlots = null; // force fresh fetch next attempt
        if (attempt < MAX_RETRIES) {
          console.log(`⏳ Retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await sleep(RETRY_DELAY_MS);
        }
        continue;
      }

      // Mark as attempted before booking so the catch block can see it
      failedSlotIds.add(currentSlot.slotId);

      // ── 3. Book the slot ──────────────────────────────────────────────────
      const cachedBookToken = attempt === 1 ? consumePrewarmedBookToken(reservation.id, currentSlot.slotId) : null;
      if (cachedBookToken) console.log(`⚡ Used cached book_token (skipped /3/details)`);

      logAttempt(reservation.id, {
        action: 'booking',
        slotTime: currentSlot.time,
        slotDate: currentSlot.date,
        message: `Attempt ${attempt}: booking slot at ${currentSlot.time}${cachedBookToken ? ' (cached book_token)' : ''}`,
        details: { slotId: currentSlot.slotId, partySize: reservation.partySize },
      });

      const result = await bookReservation(
        currentSlot.slotId,
        reservation.partySize,
        reservation.restaurantId,
        authToken,
        resolvedPaymentId ?? undefined,
        cachedBookToken ?? undefined,
      );

      logAttempt(reservation.id, {
        action: 'success',
        slotTime: currentSlot.time,
        slotDate: currentSlot.date,
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

      // 412 = Resy's "you already have a reservation" response.
      // The body contains the reservation_id that was successfully created.
      // Treat this as success — the booking went through on a prior attempt.
      if (httpStatus === 412 && errBody?.specs?.reservation_id) {
        const existingId = errBody.specs.reservation_id;
        const bookedTime = errBody.specs.time_slot?.slice(0, 5) || currentSlot?.time || '';
        console.log(`✅ HTTP 412 = already booked (reservation_id: ${existingId}) — treating as success`);
        logAttempt(reservation.id, {
          action: 'success',
          slotTime: bookedTime,
          slotDate: errBody.specs.day || reservation.targetDate,
          message: `Already booked (reservation_id: ${existingId}) — confirmed via 412 response`,
          details: { reservationId: existingId, bookedTime },
        });
        broadcastToFrontend({
          type: 'BOOKING_UPDATE',
          data: {
            reservationId: reservation.id,
            status: 'confirmed',
            confirmationCode: String(existingId),
          },
        });
        return { success: true, confirmationCode: String(existingId) };
      }

      // Don't retry auth errors.
      // 401/403 = standard auth failure; 419 = Resy session/CSRF expired (also fatal).
      if (httpStatus === 401 || httpStatus === 403 || httpStatus === 419) {
        const authErr = `Authentication failed (HTTP ${httpStatus}). Your Resy token has expired — please update it and re-save the reservation.`;
        broadcastToFrontend({
          type: 'BOOKING_UPDATE',
          data: { reservationId: reservation.id, status: 'failed', error: authErr },
        });
        return { success: false, error: authErr };
      }

      // 404 = slot was grabbed just before our POST. Try the next untried slot from
      // the same already-fetched pool immediately — no sleep, no refetch.
      if (httpStatus === 404 && currentSlots) {
        const remaining = currentSlots.filter(s => !failedSlotIds.has(s.slotId)).length;
        if (remaining > 0 && attempt < MAX_RETRIES) {
          console.log(`↩️ Slot at ${currentSlot?.time} taken — trying next slot immediately (${remaining} left in pool)`);
          continue;
        }
        // Pool exhausted — force a fresh /4/find next attempt
        currentSlots = null;
        failedSlotIds.clear();
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
  preferredTimes?: string[],
  excludeSlotIds?: Set<string>,
): AvailableSlot | null {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);

  const valid = slots.filter(s => {
    if (excludeSlotIds?.has(s.slotId)) return false;
    const m = timeToMinutes(s.time);
    return m >= startMin && m <= endMin;
  });

  if (valid.length === 0) return null;

  const diningRoom = valid.filter(s => s.tableType?.toLowerCase().includes('dining room'));
  const other = valid.filter(s => !s.tableType?.toLowerCase().includes('dining room'));

  // Priority:
  // 1. Dining Room + preferred time (in preference order)
  // 2. Dining Room + any time
  // 3. Other tables + preferred time (in preference order)
  // 4. Other tables + first valid

  if (preferredTimes?.length) {
    for (const t of preferredTimes) {
      const match = diningRoom.find(s => s.time === t);
      if (match) return match;
    }
  }
  if (diningRoom.length > 0) return diningRoom[0];

  if (preferredTimes?.length) {
    for (const t of preferredTimes) {
      const match = other.find(s => s.time === t);
      if (match) return match;
    }
  }
  return other[0] ?? null;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
