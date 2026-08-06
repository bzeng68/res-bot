import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { initDatabase, getReservation } from './database.js';
import { runBookingPipeline } from './scheduler/pipeline.js';
import type { PipelineNotifier } from './scheduler/pipeline.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

initDatabase();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Cloud Tasks target. The control plane enqueues one task per reservation,
 * scheduled ~15 minutes before its booking window opens, with the
 * reservation id and the control plane's own callback URL in the body
 * (derived by the control plane from its inbound request host — see
 * routes/reservations.ts — rather than baked in at deploy time, since
 * control-plane and worker can't reference each other's Cloud Run URL
 * without a Terraform dependency cycle).
 *
 * This container runs exactly one booking pipeline to completion — the
 * in-process prewarm/fallback timers wait out the lead time, fire the
 * booking, and report the result — then the HTTP response lets Cloud Tasks
 * mark the task done.
 *
 * Access is gated by Cloud Run IAM (only the control plane's service account
 * may invoke this service — see infra/cloud_run.tf), not application-level
 * auth.
 */
app.post('/run', async (req, res) => {
  const { reservationId, callbackUrl } = req.body ?? {};

  if (!reservationId) {
    res.status(400).json({ success: false, error: 'reservationId is required' });
    return;
  }

  const reservation = await getReservation(reservationId);
  if (!reservation) {
    console.warn(`⚠️ Worker invoked for unknown reservation ${reservationId} — skipping`);
    res.status(200).json({ success: true, skipped: true });
    return;
  }

  // Idempotency across duplicate/retried Cloud Tasks deliveries: once a
  // pipeline starts firing it moves the reservation to 'polling', so a
  // redelivered task for a reservation no longer 'scheduled' is a no-op.
  if (reservation.status !== 'scheduled') {
    console.log(`⏭️ Reservation ${reservationId} is already '${reservation.status}' — skipping duplicate delivery`);
    res.status(200).json({ success: true, skipped: true });
    return;
  }

  const notify: PipelineNotifier = callbackUrl
    ? (type, data) => {
        axios.post(
          callbackUrl,
          { type, jobId: reservationId, data, timestamp: new Date().toISOString() },
          { headers: process.env.INTERNAL_CALLBACK_TOKEN ? { 'x-internal-token': process.env.INTERNAL_CALLBACK_TOKEN } : undefined },
        ).catch(err => console.error('Failed to notify control plane:', err.message));
      }
    : () => {};

  console.log(`🚀 Worker picked up reservation ${reservationId} (${reservation.restaurantName})`);

  const { promise } = runBookingPipeline(reservation, notify);
  await promise;

  res.status(200).json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🧑‍🍳 Worker listening on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
