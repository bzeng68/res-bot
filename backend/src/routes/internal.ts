import { Router } from 'express';
import { wss } from '../ws.js';
import { addBookingAttempt, updateReservationStatus } from '../database.js';

const router = Router();

// Status callback from the worker service (see worker.ts / scheduler/pipeline.ts's
// notifier). The worker has no WebSocket clients of its own, so it reports
// booking progress back here and this relays it to the dashboard — the same
// message shape the in-process scheduler already broadcasts directly.
// Gated by a shared secret rather than Cloud Run IAM, since this route lives
// on the control plane's public service alongside the UI/API.
router.post('/reservation-status', async (req, res) => {
  const expected = process.env.INTERNAL_CALLBACK_TOKEN;
  if (expected && req.get('x-internal-token') !== expected) {
    res.status(403).json({ success: false, error: 'forbidden' });
    return;
  }

  const { type, jobId, data, timestamp } = req.body ?? {};
  if (!type || !jobId) {
    res.status(400).json({ success: false, error: 'type and jobId are required' });
    return;
  }

  await persistReservationUpdate(type, jobId, data).catch((err) => {
    console.error(`Failed to persist reservation callback for ${jobId}:`, err);
  });

  const message = JSON.stringify({ type, jobId, data, timestamp: timestamp ?? new Date().toISOString() });
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) client.send(message);
  });

  res.status(200).json({ success: true });
});

async function persistReservationUpdate(type: string, jobId: string, data: any) {
  if (type === 'booking_started') {
    await updateReservationStatus(jobId, 'polling');
    await logAttempt(jobId, 'booking', `Booking started for ${data?.restaurantName ?? 'reservation'}`, data);
    return;
  }

  if (type === 'booking_success') {
    await updateReservationStatus(jobId, 'booked', {
      success: true,
      bookedTime: data?.bookedTime,
      confirmationCode: data?.confirmationCode,
    });
    await logAttempt(jobId, 'success', `Booking confirmed${data?.bookedTime ? ` at ${data.bookedTime}` : ''}`, data);
    return;
  }

  if (type === 'booking_failed') {
    await updateReservationStatus(jobId, 'failed', {
      success: false,
      error: data?.error ?? 'Booking failed',
    });
    await logAttempt(jobId, 'error', data?.error ?? 'Booking failed', data);
    return;
  }

  if (type !== 'opentable_runner_status') return;

  const status = data?.status;
  if (!status) return;

  if (status === 'runner_started') {
    await updateReservationStatus(jobId, 'polling');
    await logAttempt(jobId, 'booking', 'OpenTable runner started', data);
    return;
  }

  if (status === 'slots_found') {
    const slotCount = data?.slotCount ?? 0;
    const near = data?.anchorTime ? ` near ${data.anchorTime}` : '';
    await logAttempt(jobId, 'found_slot', `Found ${slotCount} time slot${slotCount === 1 ? '' : 's'} available${near}`, data);
    return;
  }

  if (status === 'slot_selected') {
    await updateReservationStatus(jobId, 'polling');
    await logAttempt(jobId, 'found_slot', data?.summary ?? `Selected ${data?.selectedTime ?? 'preferred slot'}`, data);
    return;
  }

  if (status === 'anchor_exhausted') {
    await logAttempt(
      jobId,
      'booking',
      `No preferred time near ${data?.triedAnchor ?? 'anchor'}; trying next anchor ${data?.nextAnchor ?? '(none)'}`,
      data,
    );
    return;
  }

  if (status === 'stage_advanced') {
    await logAttempt(jobId, 'booking', `Selected ${data?.choice ?? 'next step'} on ${data?.path ?? 'booking page'}`, data);
    return;
  }

  if (status === 'stage_blocked') {
    const reason = data?.reason ?? 'a required field may need to be filled in manually';
    await logAttempt(jobId, 'error', `Can't submit "${data?.choice ?? 'button'}" on ${data?.path ?? 'booking page'} - ${reason}`, data);
    return;
  }

  if (status === 'stage_stuck') {
    await logAttempt(jobId, 'error', `Stuck on ${data?.path ?? 'booking page'}: no expected button found`, data);
    return;
  }

  if (status === 'booking_submitted') {
    await updateReservationStatus(jobId, 'polling', {
      success: false,
      error: 'OpenTable booking submitted; awaiting confirmation.',
    });
    await logAttempt(jobId, 'booking', 'Submitted booking action on OpenTable', data);
    return;
  }

  if (status === 'booking_success') {
    await updateReservationStatus(jobId, 'booked', {
      success: true,
      bookedTime: data?.selectedTime,
      confirmationCode: data?.confirmationCode,
    });
    await logAttempt(jobId, 'success', 'OpenTable booking confirmed', data);
    return;
  }

  if (status === 'booking_failed') {
    await updateReservationStatus(jobId, 'failed', {
      success: false,
      error: data?.error ?? 'OpenTable runner failed',
    });
    await logAttempt(jobId, 'error', data?.error ?? 'OpenTable runner failed', data);
    return;
  }

  // Catch-all so a future/unhandled runner status still shows up in the
  // reservation's log history instead of being silently dropped.
  await logAttempt(jobId, 'booking', data?.message ?? `OpenTable runner status: ${status}`, data);
}

async function logAttempt(
  jobId: string,
  action: 'found_slot' | 'booking' | 'success' | 'error',
  message: string,
  details?: any,
) {
  await addBookingAttempt(jobId, {
    timestamp: new Date().toISOString(),
    action,
    message,
    details,
  });
}

export default router;
