/**
 * Email notifications for booking results.
 *
 * Configure via environment variables:
 *   SMTP_HOST     – e.g. smtp.gmail.com
 *   SMTP_PORT     – e.g. 465 (SSL) or 587 (TLS/STARTTLS)
 *   SMTP_SECURE   – "true" for SSL (port 465), "false" for STARTTLS (port 587)
 *   SMTP_USER     – SMTP login (usually your email address)
 *   SMTP_PASS     – SMTP password / app password
 *   SMTP_FROM     – From address, e.g. "Res Bot <you@gmail.com>"
 *   SMTP_TO       – Comma-separated recipient list, e.g. "a@x.com,b@y.com"
 *
 * If any required variable is missing the module logs a warning and skips
 * sending silently so it never causes a booking failure.
 */

import nodemailer from 'nodemailer';
import type { BookingAttempt } from '../../../shared/src/types.js';

function getConfig() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
  const secure = (process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM ?? user;
  const toRaw = process.env.SMTP_TO;

  if (!host || !user || !pass || !toRaw) return null;

  const to = toRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (to.length === 0) return null;

  return { host, port, secure, user, pass, from, to };
}

function makeTransport(cfg: NonNullable<ReturnType<typeof getConfig>>) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

/**
 * Send a booking-success notification email.
 */
export async function sendSuccessEmail(opts: {
  restaurantName: string;
  targetDate: string;
  bookedTime?: string;
  confirmationCode?: string;
  partySize?: number;
}): Promise<void> {
  const cfg = getConfig();
  if (!cfg) {
    console.log('📧 Email not configured — skipping success notification.');
    return;
  }

  const { restaurantName, targetDate, bookedTime, confirmationCode, partySize } = opts;
  const subject = `✅ Booked: ${restaurantName} on ${targetDate}`;

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;color:#1a1a1a">
      <h2 style="color:#16a34a;margin-bottom:4px">Reservation Confirmed 🎉</h2>
      <p style="color:#555;margin-top:0">Your booking was secured automatically by Res Bot.</p>
      <table style="border-collapse:collapse;width:100%;margin-top:16px">
        <tr>
          <td style="padding:8px 12px;background:#f0fdf4;font-weight:600;width:40%">Restaurant</td>
          <td style="padding:8px 12px;background:#f0fdf4">${restaurantName}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600">Date</td>
          <td style="padding:8px 12px">${targetDate}</td>
        </tr>
        ${bookedTime ? `
        <tr>
          <td style="padding:8px 12px;background:#f0fdf4;font-weight:600">Time</td>
          <td style="padding:8px 12px;background:#f0fdf4">${bookedTime}</td>
        </tr>` : ''}
        ${partySize ? `
        <tr>
          <td style="padding:8px 12px;font-weight:600">Party Size</td>
          <td style="padding:8px 12px">${partySize}</td>
        </tr>` : ''}
        ${confirmationCode ? `
        <tr>
          <td style="padding:8px 12px;background:#f0fdf4;font-weight:600">Confirmation</td>
          <td style="padding:8px 12px;background:#f0fdf4;word-break:break-all;font-family:monospace;font-size:12px">${confirmationCode}</td>
        </tr>` : ''}
      </table>
      <p style="margin-top:24px;color:#888;font-size:12px">Sent by Res Bot</p>
    </div>`;

  const text = [
    `✅ Reservation Confirmed`,
    `Restaurant: ${restaurantName}`,
    `Date: ${targetDate}`,
    bookedTime ? `Time: ${bookedTime}` : '',
    partySize ? `Party: ${partySize}` : '',
    confirmationCode ? `Confirmation: ${confirmationCode}` : '',
  ].filter(Boolean).join('\n');

  try {
    const transport = makeTransport(cfg);
    await transport.sendMail({ from: cfg.from, to: cfg.to, subject, html, text });
    console.log(`📧 Success email sent to [${cfg.to.join(', ')}]`);
  } catch (err: any) {
    console.error(`📧 Failed to send success email: ${err.message}`);
  }
}

/**
 * Send a booking-failure notification email.
 */
export async function sendFailureEmail(opts: {
  restaurantName: string;
  targetDate: string;
  error?: string;
  attempts?: BookingAttempt[];
}): Promise<void> {
  const cfg = getConfig();
  if (!cfg) {
    console.log('📧 Email not configured — skipping failure notification.');
    return;
  }

  const { restaurantName, targetDate, error, attempts } = opts;
  const subject = `❌ Booking Failed: ${restaurantName} on ${targetDate}`;

  const actionLabel: Record<string, string> = {
    found_slot: 'Found slots',
    getting_book_token: 'Get token',
    booking: 'Booking',
    success: 'Success',
    error: 'Error',
  };
  const actionColor: Record<string, string> = {
    found_slot: '#2563eb',
    getting_book_token: '#7c3aed',
    booking: '#d97706',
    success: '#16a34a',
    error: '#dc2626',
  };

  const attemptsHtml = attempts?.length
    ? `
      <h3 style="margin-top:28px;margin-bottom:8px;font-size:14px;color:#374151">Booking Attempt Log</h3>
      <table style="border-collapse:collapse;width:100%;font-size:12px;font-family:monospace">
        <thead>
          <tr style="background:#f3f4f6">
            <th style="padding:6px 8px;text-align:left;font-weight:600;color:#6b7280">Time</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;color:#6b7280">Action</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;color:#6b7280">Slot</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;color:#6b7280">Message</th>
          </tr>
        </thead>
        <tbody>
          ${attempts.map((a, i) => {
            const ts = new Date(a.timestamp);
            const timeStr = ts.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
            const bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
            const color = actionColor[a.action] ?? '#374151';
            const label = actionLabel[a.action] ?? a.action;
            const slot = [a.slotTime, a.slotDate].filter(Boolean).join(' ');
            const detailsJson = a.details && Object.keys(a.details).length > 0
              ? JSON.stringify(a.details, null, 2)
              : null;
            return `<tr style="background:${bg}">
              <td style="padding:5px 8px;color:#6b7280;white-space:nowrap;vertical-align:top">${timeStr}</td>
              <td style="padding:5px 8px;vertical-align:top"><span style="color:${color};font-weight:600">${label}</span></td>
              <td style="padding:5px 8px;color:#374151;vertical-align:top">${slot}</td>
              <td style="padding:5px 8px;color:#374151;word-break:break-word;vertical-align:top">${a.message}${detailsJson ? `<br><pre style="margin:4px 0 0;padding:6px 8px;background:#f1f5f9;border-radius:4px;font-size:11px;color:#334155;white-space:pre-wrap;word-break:break-all">${detailsJson.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`
    : '';

  const attemptsTxt = attempts?.length
    ? `\nAttempt Log:\n` + attempts.map(a => {
        const ts = new Date(a.timestamp).toISOString();
        const slot = [a.slotTime, a.slotDate].filter(Boolean).join(' ');
        return `  [${ts}] ${a.action.toUpperCase()}${slot ? ` (${slot})` : ''}: ${a.message}`;
      }).join('\n')
    : '';

  const html = `
    <div style="font-family:sans-serif;max-width:700px;margin:auto;color:#1a1a1a">
      <h2 style="color:#dc2626;margin-bottom:4px">Booking Failed</h2>
      <p style="color:#555;margin-top:0">Res Bot was unable to secure a reservation.</p>
      <table style="border-collapse:collapse;width:100%;margin-top:16px">
        <tr>
          <td style="padding:8px 12px;background:#fef2f2;font-weight:600;width:40%">Restaurant</td>
          <td style="padding:8px 12px;background:#fef2f2">${restaurantName}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600">Date</td>
          <td style="padding:8px 12px">${targetDate}</td>
        </tr>
        ${error ? `
        <tr>
          <td style="padding:8px 12px;background:#fef2f2;font-weight:600">Reason</td>
          <td style="padding:8px 12px;background:#fef2f2">${error}</td>
        </tr>` : ''}
      </table>
      ${attemptsHtml}
      <p style="margin-top:24px;color:#888;font-size:12px">Sent by Res Bot</p>
    </div>`;

  const text = [
    `❌ Booking Failed`,
    `Restaurant: ${restaurantName}`,
    `Date: ${targetDate}`,
    error ? `Reason: ${error}` : '',
    attemptsTxt,
  ].filter(Boolean).join('\n');

  try {
    const transport = makeTransport(cfg);
    await transport.sendMail({ from: cfg.from, to: cfg.to, subject, html, text });
    console.log(`📧 Failure email sent to [${cfg.to.join(', ')}]`);
  } catch (err: any) {
    console.error(`📧 Failed to send failure email: ${err.message}`);
  }
}
