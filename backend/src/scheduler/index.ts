import cron from 'node-cron';
import dayjs from 'dayjs';
import { getActiveReservations, updateReservationStatus } from '../database.js';
import { pollForReservation } from './poller.js';
import { wss } from '../index.js';
import type { ReservationRequest } from '../../../shared/src/types.js';

interface ActiveJob {
  pollInterval: NodeJS.Timeout;
  timeoutId: NodeJS.Timeout;
}

const activeJobs = new Map<string, ActiveJob>();

export function startScheduler() {
  // Check for jobs to start every 10 seconds
  cron.schedule('*/10 * * * * *', () => {
    checkAndStartJobs();
  });
  
  console.log('⏰ Scheduler is running (checking every 10 seconds)');
}

async function checkAndStartJobs() {
  const activeReservations = getActiveReservations();
  const now = dayjs();
  
  for (const reservation of activeReservations) {
    // Check for orphaned polling jobs (stuck in polling status but no active job)
    if (reservation.status === 'polling' && !activeJobs.has(reservation.id)) {
      const scheduledTime = dayjs(reservation.scheduledPollTime);
      const minutesSinceScheduled = now.diff(scheduledTime, 'minutes');
      
      if (minutesSinceScheduled > 10) {
        // Been stuck for more than 10 minutes - mark as failed
        console.log(`❌ Orphaned polling job detected for ${reservation.restaurantName} - marking as failed`);
        updateReservationStatus(reservation.id, 'failed', {
          success: false,
          error: `Polling was interrupted unexpectedly (server restart or crash). Please delete this reservation and create a new one to try again.`,
        });
        broadcastUpdate(reservation.id, 'booking_failed', {
          restaurantName: reservation.restaurantName,
          error: 'Polling interrupted - please try again',
        });
      } else {
        // Recently started - restart the polling
        console.log(`🔄 Restarting orphaned polling job for ${reservation.restaurantName}`);
        startPollingJob(reservation);
      }
      continue;
    }
    
    // Skip if already polling
    if (activeJobs.has(reservation.id)) {
      continue;
    }
    
    // Check if it's time to start polling
    if (reservation.scheduledPollTime) {
      const scheduledTime = dayjs(reservation.scheduledPollTime);
      const secondsUntilStart = scheduledTime.diff(now, 'seconds');
      
      // Start polling if:
      // 1. We're within 60 seconds of scheduled time
      // 2. OR the scheduled time is already in the past (book immediately)
      if (secondsUntilStart <= 60) {
        if (secondsUntilStart < 0) {
          console.log(`⚡ Scheduled time is in the past - starting immediate polling for ${reservation.restaurantName}`);
        } else {
          console.log(`🚀 Starting polling job for ${reservation.restaurantName}`);
        }
        startPollingJob(reservation);
      }
    }
  }
}

function startPollingJob(reservation: ReservationRequest) {
  // Clear any existing interval and timeout for this job first
  if (activeJobs.has(reservation.id)) {
    console.log(`🔄 Clearing existing polling job for ${reservation.restaurantName}`);
    const existingJob = activeJobs.get(reservation.id)!;
    clearInterval(existingJob.pollInterval);
    clearTimeout(existingJob.timeoutId);
    activeJobs.delete(reservation.id);
  }
  
  // Mark as polling
  updateReservationStatus(reservation.id, 'polling');
  
  // Broadcast status update via WebSocket
  broadcastUpdate(reservation.id, 'polling_started', {
    restaurantName: reservation.restaurantName,
    targetDate: reservation.targetDate,
  });
  
  console.log(`🚀 Starting polling for ${reservation.restaurantName} (will timeout in 5 minutes)`);
  
  // Start the polling process
  const pollInterval = setInterval(async () => {
    try {
      const result = await pollForReservation(reservation);
      
      if (result.success) {
        // Success! Stop polling
        const job = activeJobs.get(reservation.id);
        if (job) {
          clearInterval(job.pollInterval);
          clearTimeout(job.timeoutId);
          activeJobs.delete(reservation.id);
        }
        
        updateReservationStatus(reservation.id, 'booked', result);
        
        broadcastUpdate(reservation.id, 'booking_success', {
          restaurantName: reservation.restaurantName,
          bookedTime: result.bookedTime,
          confirmationCode: result.confirmationCode,
        });
        
        console.log(`✅ Successfully booked ${reservation.restaurantName} for ${reservation.targetDate}`);
      } else if (result.error?.includes('captcha') || result.error?.toLowerCase().includes('captcha')) {
        // Captcha detected - need manual intervention
        const job = activeJobs.get(reservation.id);
        if (job) {
          clearInterval(job.pollInterval);
          clearTimeout(job.timeoutId);
          activeJobs.delete(reservation.id);
        }
        
        const captchaMsg = 'Captcha detected by Resy. Automated booking blocked. You will need to book manually through the Resy website or app.';
        
        updateReservationStatus(reservation.id, 'failed', {
          success: false,
          error: captchaMsg,
        });
        
        broadcastUpdate(reservation.id, 'booking_failed', {
          restaurantName: reservation.restaurantName,
          error: captchaMsg,
        });
        
        console.log(`❌ Captcha detected for ${reservation.restaurantName}`);
      } else if (result.error?.startsWith('FULLY_BOOKED:')) {
        // Restaurant is completely booked - stop polling immediately
        const job = activeJobs.get(reservation.id);
        if (job) {
          clearInterval(job.pollInterval);
          clearTimeout(job.timeoutId);
          activeJobs.delete(reservation.id);
        }
        
        // Remove the prefix for display
        const errorMsg = result.error.replace('FULLY_BOOKED: ', '');
        
        updateReservationStatus(reservation.id, 'failed', {
          success: false,
          error: errorMsg,
        });
        
        broadcastUpdate(reservation.id, 'booking_failed', {
          restaurantName: reservation.restaurantName,
          error: errorMsg,
        });
        
        console.log(`❌ ${reservation.restaurantName} is fully booked - stopping polling`);
      } else if (result.error?.includes('Authentication failed') || result.error?.includes('auth token may have expired')) {
        // Auth token expired - stop polling immediately
        const job = activeJobs.get(reservation.id);
        if (job) {
          clearInterval(job.pollInterval);
          clearTimeout(job.timeoutId);
          activeJobs.delete(reservation.id);
        }
        
        updateReservationStatus(reservation.id, 'failed', result);
        
        broadcastUpdate(reservation.id, 'booking_failed', {
          restaurantName: reservation.restaurantName,
          error: result.error,
        });
        
        console.log(`❌ Authentication failed for ${reservation.restaurantName} - stopping polling`);
      }
    } catch (error) {
      console.error(`Error polling for ${reservation.restaurantName}:`, error);
    }
  }, 3000); // Poll every 3 seconds to avoid bot detection
  
  // Set a timeout to stop polling after 5 minutes
  const timeoutId = setTimeout(() => {
    const job = activeJobs.get(reservation.id);
    if (job) {
      clearInterval(job.pollInterval);
      activeJobs.delete(reservation.id);
      
      const currentReservation = getActiveReservations().find(r => r.id === reservation.id);
      if (currentReservation && currentReservation.status === 'polling') {
        const errorMsg = `Polling timeout after 5 minutes. No matching availability found for ${reservation.timeRange.start}-${reservation.timeRange.end} on ${reservation.targetDate}. Try adjusting your time range or date.`;
        
        updateReservationStatus(currentReservation.id, 'failed', {
          success: false,
          error: errorMsg,
        });
        
        broadcastUpdate(currentReservation.id, 'booking_failed', {
          restaurantName: currentReservation.restaurantName,
          error: errorMsg,
        });
      }
      
      console.log(`⏱️ Polling timeout for ${reservation.restaurantName}`);
    }
  }, 5 * 60 * 1000); // 5 minutes
  
  // Store both the interval and timeout
  activeJobs.set(reservation.id, { pollInterval, timeoutId });
}

function broadcastUpdate(jobId: string, type: string, data: any) {
  const message = JSON.stringify({
    type,
    jobId,
    data,
    timestamp: new Date().toISOString(),
  });
  
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

export function stopJobForReservation(reservationId: string) {
  const job = activeJobs.get(reservationId);
  if (job) {
    clearInterval(job.pollInterval);
    clearTimeout(job.timeoutId);
    activeJobs.delete(reservationId);
    console.log(`⏹️ Stopped polling job for reservation ${reservationId}`);
  }
}
