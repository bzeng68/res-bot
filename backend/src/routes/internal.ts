import { Router } from 'express';
import { wss } from '../ws.js';

const router = Router();

// Status callback from the worker service (see worker.ts / scheduler/pipeline.ts's
// notifier). The worker has no WebSocket clients of its own, so it reports
// booking progress back here and this relays it to the dashboard — the same
// message shape the in-process scheduler already broadcasts directly.
// Gated by a shared secret rather than Cloud Run IAM, since this route lives
// on the control plane's public service alongside the UI/API.
router.post('/reservation-status', (req, res) => {
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

  const message = JSON.stringify({ type, jobId, data, timestamp: timestamp ?? new Date().toISOString() });
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) client.send(message);
  });

  res.status(200).json({ success: true });
});

export default router;
