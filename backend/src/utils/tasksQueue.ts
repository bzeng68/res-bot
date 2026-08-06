/**
 * Wraps Cloud Tasks so the control plane can wake the worker service at an
 * arbitrary future timestamp per reservation (Cloud Scheduler can't do this —
 * it's cron/recurring only). Enabled by setting TASKS_QUEUE_ID; when unset,
 * the app falls back to the in-process cron scheduler (scheduler/index.ts)
 * for local dev.
 */
import { CloudTasksClient } from '@google-cloud/tasks';
import { getFireTime } from '../scheduler/pipeline.js';
import type { ReservationRequest } from '../../../shared/src/types.js';

// Wake the worker this far before the booking window opens.
const LEAD_TIME_MS = 15 * 60 * 1000;

let client: CloudTasksClient | undefined;

function getClient(): CloudTasksClient {
  if (!client) client = new CloudTasksClient();
  return client;
}

function queuePath(): string {
  return getClient().queuePath(
    process.env.GCP_PROJECT_ID!,
    process.env.GCP_REGION!,
    process.env.TASKS_QUEUE_ID!,
  );
}

export function isCloudTasksEnabled(): boolean {
  return Boolean(process.env.TASKS_QUEUE_ID);
}

/** Enqueues a one-time Cloud Task that wakes the worker ~15min before the booking window opens. */
export async function enqueueBookingTask(reservation: ReservationRequest, callbackUrl: string): Promise<string> {
  const fireAtMs = getFireTime(reservation).valueOf();
  const scheduleAtMs = Math.max(Date.now(), fireAtMs - LEAD_TIME_MS);

  const [task] = await getClient().createTask({
    parent: queuePath(),
    task: {
      httpRequest: {
        httpMethod: 'POST',
        url: `${process.env.WORKER_URL}/run`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ reservationId: reservation.id, callbackUrl })).toString('base64'),
        oidcToken: { serviceAccountEmail: process.env.CONTROL_PLANE_SERVICE_ACCOUNT_EMAIL! },
      },
      scheduleTime: { seconds: Math.floor(scheduleAtMs / 1000) },
      // The worker waits out the remaining lead time in-process (up to
      // ~15min) before firing — give the dispatch a deadline that covers
      // that plus retry margin (Cloud Tasks default is 10min, max is 30min).
      dispatchDeadline: { seconds: 20 * 60 },
    },
  });

  return task.name!;
}

/** Cancels a not-yet-fired task, e.g. when a reservation is deleted before its window opens. */
export async function cancelBookingTask(taskName: string): Promise<void> {
  try {
    await getClient().deleteTask({ name: taskName });
  } catch (err: any) {
    if (err.code !== 5 /* NOT_FOUND — already dispatched or expired */) throw err;
  }
}
