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
import type { ReservationRequest, ApiResponse } from '../../../shared/src/types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const router = Router();

// Get all reservations
router.get('/', (req, res) => {
  try {
    const reservations = getAllReservations();
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
router.get('/active', (req, res) => {
  try {
    const reservations = getActiveReservations();
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
router.get('/:id', (req, res) => {
  try {
    const reservation = getReservation(req.params.id);
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
router.post('/', (req, res) => {
  try {
    const reservationData = req.body;
    
    // Calculate scheduled poll time
    const targetDate = dayjs(reservationData.targetDate);
    const now = dayjs();
    
    let scheduledPollTime: string;
    
    // Check if target date is today or very soon
    const hoursUntilReservation = targetDate.diff(now, 'hours');
    
    if (hoursUntilReservation <= 12) {
      // If reservation is within 12 hours (or in the past), start polling immediately
      scheduledPollTime = now.toISOString();
      console.log(`⚡ Reservation is within 12 hours - scheduling for immediate polling`);
    } else {
      // Otherwise, calculate based on booking window (30 days before target date)
      const bookingWindowOpens = targetDate.subtract(reservationData.bookingWindow?.daysInAdvance || 30, 'days');
      scheduledPollTime = bookingWindowOpens.subtract(30, 'seconds').toISOString();
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
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      scheduledPollTime,
    };
    
    createReservation(reservation);
    
    res.status(201).json({ 
      success: true, 
      data: reservation 
    } as ApiResponse<ReservationRequest>);
  } catch (error) {
    console.error('Error creating reservation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create reservation' 
    } as ApiResponse<never>);
  }
});

// Update reservation (for retrying with different time range)
router.patch('/:id', (req, res) => {
  try {
    const reservation = getReservation(req.params.id);
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
      updates.status = 'scheduled';
      updates.result = undefined;
      
      // Recalculate scheduled poll time if needed
      const targetDate = dayjs(reservation.targetDate);
      const now = dayjs();
      const hoursUntilReservation = targetDate.diff(now, 'hours');
      
      if (hoursUntilReservation <= 12) {
        updates.scheduledPollTime = now.toISOString();
      }
    }
    
    const updatedReservation = updateReservation(req.params.id, updates);
    
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
router.delete('/:id', (req, res) => {
  try {
    const reservation = getReservation(req.params.id);
    if (!reservation) {
      res.status(404).json({ 
        success: false, 
        error: 'Reservation not found' 
      } as ApiResponse<never>);
      return;
    }
    
    deleteReservation(req.params.id);
    
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
