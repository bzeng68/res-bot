import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import {
  createReservation,
  getReservation,
  getAllReservations,
  getActiveReservations,
  updateReservationStatus,
  updateReservation,
  deleteReservation,
} from '../database.js';
import { stopJobForReservation } from '../scheduler/index.js';
import { resyClient } from '../api/resy-client.js';
import { wss } from '../ws.js';
import { isCloudTasksEnabled, enqueueBookingTask, cancelBookingTask } from '../utils/tasksQueue.js';
import type { ReservationRequest, ApiResponse } from '../../../shared/src/types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const router = Router();

// Get all reservations
router.get('/', async (req, res) => {
  try {
    const reservations = await getAllReservations();
    res.json({ success: true, data: reservations } as ApiResponse<ReservationRequest[]>);
  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch reservations' 
    } as ApiResponse<never>);
  }
});

// Get active reservations
router.get('/active', async (req, res) => {
  try {
    const reservations = await getActiveReservations();
    res.json({ success: true, data: reservations } as ApiResponse<ReservationRequest[]>);
  } catch (error) {
    console.error('Error fetching active reservations:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch active reservations' 
    } as ApiResponse<never>);
  }
});

// Get single reservation
router.get('/:id', async (req, res) => {
  try {
    const reservation = await getReservation(req.params.id);
    if (!reservation) {
      res.status(404).json({ 
        success: false, 
        error: 'Reservation not found' 
      } as ApiResponse<never>);
      return;
    }
    res.json({ success: true, data: reservation } as ApiResponse<ReservationRequest>);
  } catch (error) {
    console.error('Error fetching reservation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch reservation' 
    } as ApiResponse<never>);
  }
});

// Create new reservation
router.post('/', async (req, res) => {
  try {
    const reservationData = req.body;
    
    // Calculate scheduled poll time based on booking window.
    // Use dayjs.tz(date, tz) — NOT dayjs(date).tz(tz) — to parse the date as
    // midnight in the restaurant's timezone rather than converting from UTC.
    const now = dayjs();
    
    let scheduledPollTime: string;
    
    if (reservationData.bookingWindow) {
      const { daysInAdvance, releaseTime, timezone: tz } = reservationData.bookingWindow;
      const [hours, minutes] = releaseTime.split(':').map(Number);
      
      const bookingOpensAt = dayjs.tz(reservationData.targetDate, tz)
        .subtract(daysInAdvance, 'days')
        .hour(hours)
        .minute(minutes)
        .second(0)
        .millisecond(0); // exact window-open time — matches getFireTime()
      
      if (now.isAfter(bookingOpensAt)) {
        scheduledPollTime = now.toISOString();
        console.log(`⚡ Booking window already open - scheduling for immediate polling`);
      } else {
        scheduledPollTime = bookingOpensAt.toISOString();
        console.log(`⏰ Booking window opens ${bookingOpensAt.format('MMM D, YYYY [at] h:mm A')} - scheduling polling for that time`);
      }
    } else {
      // No booking window info — fall back to booking date minus 30 days
      const bookingWindowOpens = dayjs(reservationData.targetDate).subtract(30, 'days');
      scheduledPollTime = now.isAfter(bookingWindowOpens)
        ? now.toISOString()
        : bookingWindowOpens.toISOString();
    }
    
    const reservation: ReservationRequest = {
      id: uuidv4(),
      restaurantId: reservationData.restaurantId,
      restaurantName: reservationData.restaurantName,
      targetDate: reservationData.targetDate,
      timeRange: reservationData.timeRange,
      partySize: reservationData.partySize,
      userEmail: reservationData.userEmail,
      credentials: reservationData.credentials,
      bookingWindow: reservationData.bookingWindow,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      scheduledPollTime,
    };
    
    await createReservation(reservation);

    if (isCloudTasksEnabled()) {
      try {
        const callbackUrl = `${req.protocol}://${req.get('host')}/internal/reservation-status`;
        const taskName = await enqueueBookingTask(reservation, callbackUrl);
        await updateReservation(reservation.id, { cloudTaskName: taskName });
        reservation.cloudTaskName = taskName;
      } catch (error) {
        console.error('Failed to enqueue booking task:', error);
        // Don't leave a reservation that nothing will ever fire — the local
        // in-process scheduler is disabled whenever Cloud Tasks mode is on.
        await deleteReservation(reservation.id);
        res.status(500).json({
          success: false,
          error: 'Failed to schedule booking task'
        } as ApiResponse<never>);
        return;
      }
    }

    res.status(201).json({
      success: true,
      data: reservation
    } as ApiResponse<ReservationRequest>);

    // Fire-and-forget: cache the payment method ID so booking day skips the /2/user fetch.
    // This runs after the response is sent so it doesn't add latency to reservation creation.
    const authToken = reservation.credentials?.authToken;
    if (authToken) {
      resyClient.getPaymentMethodId(authToken)
        .then(async id => {
          if (id != null) {
            await updateReservation(reservation.id, {
              credentials: { ...reservation.credentials, paymentMethodId: id },
            });
            console.log(`💳 Cached payment method ID ${id} for ${reservation.restaurantName}`);
          }
        })
        .catch(() => { /* non-critical */ });
    }
  } catch (error) {
    console.error('Error creating reservation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create reservation' 
    } as ApiResponse<never>);
  }
});

// Update reservation (for retrying with different time range)
router.patch('/:id', async (req, res) => {
  try {
    const reservation = await getReservation(req.params.id);
    if (!reservation) {
      res.status(404).json({ 
        success: false, 
        error: 'Reservation not found' 
      } as ApiResponse<never>);
      return;
    }
    
    const updates = req.body;

    // If updating time range, reset status to scheduled
    if (updates.timeRange) {
      // Only a reservation coming FROM a terminal state has no live task
      // covering it — one still 'scheduled'/'polling' already has a pending
      // Cloud Task (or in-process timer) that a timeRange-only edit doesn't
      // invalidate, since it doesn't change the fire time. Enqueuing another
      // one in that case would risk firing the same reservation twice.
      const wasTerminal = reservation.status === 'failed' || reservation.status === 'booked' || reservation.status === 'cancelled';

      updates.status = 'scheduled';
      updates.result = undefined;

      // Recalculate scheduled poll time if needed
      const targetDate = dayjs(reservation.targetDate);
      const now = dayjs();
      const hoursUntilReservation = targetDate.diff(now, 'hours');

      if (hoursUntilReservation <= 12) {
        updates.scheduledPollTime = now.toISOString();
      }

      if (isCloudTasksEnabled() && wasTerminal) {
        try {
          const callbackUrl = `${req.protocol}://${req.get('host')}/internal/reservation-status`;
          const taskName = await enqueueBookingTask({ ...reservation, ...updates }, callbackUrl);
          updates.cloudTaskName = taskName;
        } catch (error) {
          console.error('Failed to enqueue retry booking task:', error);
          res.status(500).json({
            success: false,
            error: 'Failed to schedule retry'
          } as ApiResponse<never>);
          return;
        }
      }
    }

    const updatedReservation = await updateReservation(req.params.id, updates);
    
    res.json({ 
      success: true, 
      data: updatedReservation 
    } as ApiResponse<ReservationRequest>);
  } catch (error) {
    console.error('Error updating reservation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update reservation' 
    } as ApiResponse<never>);
  }
});

// Cancel/delete reservation
router.delete('/:id', async (req, res) => {
  try {
    const reservation = await getReservation(req.params.id);
    if (!reservation) {
      res.status(404).json({
        success: false,
        error: 'Reservation not found'
      } as ApiResponse<never>);
      return;
    }

    // Stop any active polling job for this reservation (in-process scheduler mode)
    stopJobForReservation(req.params.id);

    // Cancel its Cloud Task if one was scheduled (Cloud Tasks mode)
    if (reservation.cloudTaskName) {
      await cancelBookingTask(reservation.cloudTaskName).catch(err =>
        console.error(`Failed to cancel Cloud Task for ${req.params.id}:`, err)
      );
    }

    console.log(`🗑️ Stopped polling job and deleted reservation for ${reservation.restaurantName}`);

    // Delete the reservation from database
    await deleteReservation(req.params.id);
    
    // Broadcast to connected clients that reservation was deleted
    // This ensures the frontend UI updates immediately
    const message = JSON.stringify({
      type: 'reservation_deleted',
      jobId: req.params.id,
      data: {
        reservationId: req.params.id,
        restaurantName: reservation.restaurantName,
      },
      timestamp: new Date().toISOString(),
    });
    
    wss.clients.forEach((client: any) => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    });
    
    res.json({ 
      success: true, 
      data: { message: 'Reservation cancelled' } 
    } as ApiResponse<{ message: string }>);
  } catch (error) {
    console.error('Error deleting reservation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete reservation' 
    } as ApiResponse<never>);
  }
});

export default router;
