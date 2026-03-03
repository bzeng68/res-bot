// Shared TypeScript types for res-bot

export interface Restaurant {
  id: string;
  name: string;
  location: string;
  address?: string;
  cuisine?: string;
  bookingWindow: BookingWindow;
  platform: 'resy';
}

export interface BookingWindow {
  daysInAdvance: number;
  releaseTime: string; // "10:00" in restaurant's timezone
  timezone: string; // "America/New_York"
}

export interface ReservationRequest {
  id: string;
  restaurantId: string;
  restaurantName: string;
  targetDate: string; // ISO date
  timeRange: TimeRange;
  partySize: number;
  userEmail: string;
  credentials: PlatformCredentials;
  status: ReservationStatus;
  createdAt: string;
  scheduledPollTime?: string;
  result?: BookingResult;
  bookingAttempts?: BookingAttempt[]; // Log of all booking attempts
}

export interface TimeRange {
  start: string; // "18:00"
  end: string; // "20:30"
  preferredTimes?: string[]; // ["19:00", "19:30", "18:30"] in priority order
}

export type ReservationStatus = 
  | 'scheduled'
  | 'polling'
  | 'booked'
  | 'failed'
  | 'cancelled';

export interface PlatformCredentials {
  platform: 'resy';
  authToken: string; // Manually extracted from browser, encrypted in storage
}

export interface BookingResult {
  success: boolean;
  reservationId?: string;
  bookedTime?: string;
  confirmationCode?: string;
  error?: string;
}

export interface BookingAttempt {
  timestamp: string; // ISO timestamp
  slotTime?: string; // "12:00" (optional - not available for all actions)
  slotDate?: string; // "2026-03-31" (optional - not available for all actions)
  action: 'found_slot' | 'getting_book_token' | 'booking' | 'success' | 'error';
  message: string;
  details?: any; // Additional context
}

export interface AvailableSlot {
  time: string; // "19:00"
  date: string; // ISO date
  partySize: number;
  tableType?: string;
  slotId: string;
}

export interface SearchResult {
  restaurants: Restaurant[];
  query: string;
}

export interface JobStatus {
  id: string;
  restaurantName: string;
  targetDate: string;
  timeRange: TimeRange;
  status: ReservationStatus;
  countdown?: number; // seconds until polling starts
  createdAt: string;
}

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface WebSocketMessage {
  type: 'status_update' | 'booking_success' | 'booking_failed' | 'polling_started';
  jobId: string;
  data: any;
}
