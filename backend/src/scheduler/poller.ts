import dayjs from 'dayjs';
import { getAvailability } from '../api/resy-client.js';
import { addBookingAttempt } from '../database.js';
import { sendToExtension } from '../index.js';
import type { ReservationRequest, BookingResult, AvailableSlot } from '../../../shared/src/types.js';

/**
 * Poll for available reservation slots and attempt to book
 */
export async function pollForReservation(
  reservation: ReservationRequest
): Promise<BookingResult> {
  try {
    console.log(`🔍 Polling for availability at ${reservation.restaurantName}...`);
    
    // Get available slots
    const availableSlots = await getAvailability(
      reservation.restaurantId,
      reservation.targetDate,
      reservation.partySize
    );
    
    console.log(`📊 Found ${availableSlots.length} available slots`);
    
    // Log this polling attempt
    addBookingAttempt(reservation.id, {
      timestamp: new Date().toISOString(),
      slotTime: '',
      slotDate: reservation.targetDate,
      action: 'found_slot',
      message: `Found ${availableSlots.length} available slots`,
      details: { 
        slotCount: availableSlots.length,
        availableTimes: availableSlots.map(s => s.time).slice(0, 10) 
      }
    });
    
    if (availableSlots.length === 0) {
      // Restaurant is completely booked out - fail immediately
      const errorMsg = `Restaurant is fully booked on ${reservation.targetDate}. No availability for party of ${reservation.partySize}.`;
      console.log(`❌ ${errorMsg}`);
      return {
        success: false,
        error: `FULLY_BOOKED: ${errorMsg}`,
      };
    }
    
    // Find a matching slot within the user's time range
    const matchingSlot = findBestSlot(
      availableSlots,
      reservation.timeRange.start,
      reservation.timeRange.end,
      reservation.timeRange.preferredTimes
    );
    
    if (!matchingSlot) {
      // Get available time ranges for better error message
      const allTimes = availableSlots.map(slot => slot.time).sort();
      const uniqueTimes = [...new Set(allTimes)]; // Remove duplicates
      
      const showCount = Math.min(10, uniqueTimes.length);
      const timeList = uniqueTimes.slice(0, showCount).join(', ');
      const remaining = uniqueTimes.length - showCount;
      
      const errorMsg = remaining > 0
        ? `No slots match your ${reservation.timeRange.start}-${reservation.timeRange.end} time range. Available times: ${timeList}... (+${remaining} more)`
        : `No slots match your ${reservation.timeRange.start}-${reservation.timeRange.end} time range. Available times: ${timeList}`;
      
      console.log(`⏰ ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
    
    // Attempt to book!
    console.log(`🎯 Found matching slot at ${matchingSlot.time} - attempting to book...`);
    
    // Log that we found a matching slot
    addBookingAttempt(reservation.id, {
      timestamp: new Date().toISOString(),
      slotTime: matchingSlot.time,
      slotDate: matchingSlot.date,
      action: 'booking',
      message: `Attempting to book slot at ${matchingSlot.time}`,
      details: { 
        slotId: matchingSlot.slotId,
        partySize: matchingSlot.partySize 
      }
    });
    
    // Send booking request to Chrome Extension
    const sent = sendToExtension({
      type: 'BOOK_RESERVATION',
      data: {
        slotToken: matchingSlot.slotId,
        reservationId: reservation.id,
        partySize: matchingSlot.partySize,
      },
    });
    
    if (!sent) {
      // Extension not connected
      const errorMsg = 'Chrome Extension is not connected. Please make sure the extension is installed and running.';
      console.error(`❌ ${errorMsg}`);
      
      addBookingAttempt(reservation.id, {
        timestamp: new Date().toISOString(),
        slotTime: matchingSlot.time,
        slotDate: matchingSlot.date,
        action: 'error',
        message: errorMsg,
        details: { error: 'Extension not connected' }
      });
      
      return {
        success: false,
        error: errorMsg,
      };
    }
    
    // Booking request sent to extension - result will come via WebSocket
    console.log('📤 Booking request sent to extension, waiting for response...');
    
    // Return pending status - actual result will be broadcast via WebSocket
    const result: BookingResult = {
      success: false,
      error: 'Booking request sent to Chrome Extension - waiting for response'
    };
    
    // Log the result
    if (result.success) {
      addBookingAttempt(reservation.id, {
        timestamp: new Date().toISOString(),
        slotTime: matchingSlot.time,
        slotDate: matchingSlot.date,
        action: 'success',
        message: `Successfully booked reservation!`,
        details: { 
          confirmationCode: result.confirmationCode,
          reservationId: result.reservationId 
        }
      });
    } else {
      addBookingAttempt(reservation.id, {
        timestamp: new Date().toISOString(),
        slotTime: matchingSlot.time,
        slotDate: matchingSlot.date,
        action: 'error',
        message: `Booking failed: ${result.error}`,
        details: { error: result.error }
      });
    }
    
    return result;
  } catch (error: any) {
    console.error('Polling error:', error);
    
    // Provide more informative error messages
    let errorMsg = 'Unknown error occurred';
    
    if (error.response?.status === 401 || error.response?.status === 403) {
      errorMsg = 'Authentication failed. Your Resy auth token may have expired. Please get a new token from the Network tab.';
    } else if (error.response?.status === 429) {
      errorMsg = 'Rate limited by Resy. Too many requests. Please wait a few minutes and try again.';
    } else if (error.response?.status >= 500) {
      errorMsg = 'Resy server error. Their servers may be down. Please try again later.';
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      errorMsg = 'Network error. Please check your internet connection.';
    } else if (error.message) {
      errorMsg = error.message;
    }
    
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Find the best available slot based on user preferences
 */
function findBestSlot(
  slots: AvailableSlot[],
  startTime: string,
  endTime: string,
  preferredTimes?: string[]
): AvailableSlot | null {
  // Convert time strings to minutes for easier comparison
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  
  // Filter slots within the time range
  const validSlots = slots.filter(slot => {
    const slotMinutes = timeToMinutes(slot.time);
    return slotMinutes >= startMinutes && slotMinutes <= endMinutes;
  });
  
  if (validSlots.length === 0) {
    return null;
  }
  
  // If preferred times are specified, try those first
  if (preferredTimes && preferredTimes.length > 0) {
    for (const preferredTime of preferredTimes) {
      const match = validSlots.find(slot => slot.time === preferredTime);
      if (match) {
        return match;
      }
    }
  }
  
  // Otherwise, return the first available slot in the range
  return validSlots[0];
}

/**
 * Convert "HH:MM" time string to minutes since midnight
 */
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}
