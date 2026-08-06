import { Firestore, FieldValue } from '@google-cloud/firestore';
import { ReservationRequest, ReservationStatus, BookingAttempt } from '../../shared/src/types.js';
import { encryptPassword, decryptPassword, isEncrypted } from './utils/crypto.js';

const COLLECTION = 'reservations';

let firestore: Firestore;

// Initialize the Firestore client. Respects GOOGLE_APPLICATION_CREDENTIALS /
// the Cloud Run runtime service account for auth, and FIRESTORE_EMULATOR_HOST
// for local dev against the emulator — no code branching needed either way.
export function initDatabase() {
  firestore = new Firestore({
    projectId: process.env.GCP_PROJECT_ID,
  });
}

function col() {
  return firestore.collection(COLLECTION);
}

// Reservation operations
export async function createReservation(reservation: ReservationRequest): Promise<void> {
  const encrypted = {
    ...reservation,
    credentials: {
      ...reservation.credentials,
      authToken: encryptPassword(reservation.credentials.authToken),
    },
  };

  // Optional fields (e.g. bookingWindow) may be explicitly `undefined` on the
  // object literal rather than omitted — Firestore rejects literal undefined
  // outright, at any nesting depth, so strip it recursively.
  await col().doc(reservation.id).set(deepStripUndefined(encrypted));
}

export async function getReservation(id: string): Promise<ReservationRequest | null> {
  const snap = await col().doc(id).get();
  if (!snap.exists) return null;

  return decryptReservationCredentials(snap.data() as ReservationRequest);
}

export async function getAllReservations(): Promise<ReservationRequest[]> {
  const snap = await col().orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => decryptReservationCredentials(d.data() as ReservationRequest));
}

export async function getActiveReservations(): Promise<ReservationRequest[]> {
  const snap = await col().where('status', 'in', ['scheduled', 'polling']).get();

  return snap.docs
    .map(d => decryptReservationCredentials(d.data() as ReservationRequest))
    .sort((a, b) => {
      if (!a.scheduledPollTime) return 1;
      if (!b.scheduledPollTime) return -1;
      return new Date(a.scheduledPollTime).getTime() - new Date(b.scheduledPollTime).getTime();
    });
}

export async function updateReservationStatus(
  id: string,
  status: ReservationStatus,
  result?: any
): Promise<void> {
  const ref = col().doc(id);

  await firestore.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const current = snap.data() as ReservationRequest;

    // Never overwrite a successful booking with a failure — can happen if two
    // concurrent fire() calls race (one succeeds, the other retries and fails).
    if (current.status === 'booked' && status === 'failed') {
      console.warn(`⚠️ Ignoring status downgrade: ${id} is already 'booked', refusing to set 'failed'`);
      return;
    }

    const updates: Record<string, unknown> = { status };
    if (result) updates.result = deepStripUndefined(result);
    tx.update(ref, updates);
  });
}

export async function updateReservation(
  id: string,
  updates: Partial<ReservationRequest>
): Promise<ReservationRequest | null> {
  const ref = col().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const current = snap.data() as ReservationRequest;
  const merged: Record<string, unknown> = { ...updates };

  // If credentials are being updated, encrypt them
  if (updates.credentials) {
    merged.credentials = {
      platform: 'resy',
      authToken: updates.credentials.authToken ? encryptPassword(updates.credentials.authToken) : current.credentials.authToken,
      ...(updates.credentials.paymentMethodId != null && { paymentMethodId: updates.credentials.paymentMethodId }),
    };
  }

  await ref.update(sanitizeForFirestore(merged));

  const updatedSnap = await ref.get();
  return decryptReservationCredentials(updatedSnap.data() as ReservationRequest);
}

export async function deleteReservation(id: string): Promise<void> {
  await col().doc(id).delete();
}

export async function addBookingAttempt(id: string, attempt: BookingAttempt): Promise<void> {
  const ref = col().doc(id);

  await firestore.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const current = snap.data() as ReservationRequest;
    // Keep only last 50 attempts to avoid bloat. attempt.details is
    // arbitrary caller-provided data (e.g. { httpStatus, body } where
    // httpStatus is undefined for non-HTTP errors) — strip undefined
    // recursively or Firestore rejects the whole write.
    const attempts = [...(current.bookingAttempts ?? []), attempt].slice(-50);
    tx.update(ref, { bookingAttempts: deepStripUndefined(attempts) });
  });
}

// A caller passing `undefined` for a TOP-LEVEL field (e.g. to reset `result`
// on retry) means "clear this field" — translate that into FieldValue.delete(),
// which is only valid for update()/merge-set(), not plain .set(). Nested
// undefined (e.g. inside `credentials` or `bookingAttempts[].details`) has no
// such special meaning and no delete-sentinel equivalent — Firestore just
// rejects it outright — so strip it recursively instead.
function sanitizeForFirestore(updates: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    out[key] = value === undefined ? FieldValue.delete() : deepStripUndefined(value);
  }
  return out;
}

function deepStripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(deepStripUndefined) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[key] = deepStripUndefined(v);
    }
    return out as T;
  }
  return value;
}

// Helper function to decrypt credentials when reading
function decryptReservationCredentials(reservation: ReservationRequest): ReservationRequest {
  try {
    const decryptedCredentials: ReservationRequest['credentials'] = {
      platform: 'resy',
      authToken: '',
    };

    // Decrypt authToken if present and encrypted
    if (reservation.credentials.authToken && isEncrypted(reservation.credentials.authToken)) {
      decryptedCredentials.authToken = decryptPassword(reservation.credentials.authToken);
    } else {
      decryptedCredentials.authToken = reservation.credentials.authToken;
    }

    // Preserve cached payment method ID (not encrypted, just a number)
    if (reservation.credentials.paymentMethodId != null) {
      decryptedCredentials.paymentMethodId = reservation.credentials.paymentMethodId;
    }

    return {
      ...reservation,
      credentials: decryptedCredentials,
    };
  } catch (error) {
    console.error('Failed to decrypt credentials for reservation:', reservation.id);
    return reservation;
  }
}
