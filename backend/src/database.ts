import fs from 'fs';
import path from 'path';
import { ReservationRequest, ReservationStatus, BookingAttempt, PlatformCredentials } from '../../shared/src/types.js';
import { encryptPassword, decryptPassword, isEncrypted } from './utils/crypto.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const RESERVATIONS_FILE = path.join(DATA_DIR, 'reservations.json');

interface DataStore {
  reservations: ReservationRequest[];
}

let store: DataStore = { reservations: [] };

// Initialize database
export function initDatabase() {
  // Create data directory if it doesn't exist
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Load existing data if file exists
  if (fs.existsSync(RESERVATIONS_FILE)) {
    try {
      const data = fs.readFileSync(RESERVATIONS_FILE, 'utf-8');
      store = JSON.parse(data);
    } catch (error) {
      console.error('Error loading data:', error);
      store = { reservations: [] };
    }
  }

  // Save initial empty store if file doesn't exist
  if (!fs.existsSync(RESERVATIONS_FILE)) {
    saveStore();
  }
}

function saveStore() {
  fs.writeFileSync(RESERVATIONS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

// Reservation operations
export function createReservation(reservation: ReservationRequest): void {
  // Encrypt sensitive credentials before storing
  const encryptedReservation = {
    ...reservation,
    credentials: {
      ...reservation.credentials,
      authToken: encryptPassword(reservation.credentials.authToken),
    },
  };
  
  store.reservations.push(encryptedReservation);
  saveStore();
}

export function getReservation(id: string): ReservationRequest | null {
  const reservation = store.reservations.find(r => r.id === id);
  if (!reservation) return null;
  
  // Decrypt password when retrieving
  return decryptReservationCredentials(reservation);
}

export function getAllReservations(): ReservationRequest[] {
  return [...store.reservations]
    .map(decryptReservationCredentials)
    .sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}

export function getActiveReservations(): ReservationRequest[] {
  return store.reservations
    .filter(r => r.status === 'scheduled' || r.status === 'polling')
    .map(decryptReservationCredentials)
    .sort((a, b) => {
      if (!a.scheduledPollTime) return 1;
      if (!b.scheduledPollTime) return -1;
      return new Date(a.scheduledPollTime).getTime() - new Date(b.scheduledPollTime).getTime();
    });
}

export function updateReservationStatus(
  id: string, 
  status: ReservationStatus, 
  result?: any
): void {
  const reservation = store.reservations.find(r => r.id === id);
  if (reservation) {
    reservation.status = status;
    if (result) {
      reservation.result = result;
    }
    saveStore();
  }
}

export function updateReservation(
  id: string,
  updates: Partial<ReservationRequest>
): ReservationRequest | null {
  const reservation = store.reservations.find(r => r.id === id);
  if (!reservation) return null;
  
  // Merge updates, encrypting credentials if they're being updated
  Object.assign(reservation, updates);
  
  // If credentials are being updated, encrypt them
  if (updates.credentials) {
    reservation.credentials = {
      platform: 'resy',
      authToken: updates.credentials.authToken ? encryptPassword(updates.credentials.authToken) : reservation.credentials.authToken,
    };
  }
  
  saveStore();
  return decryptReservationCredentials(reservation);
}

export function deleteReservation(id: string): void {
  store.reservations = store.reservations.filter(r => r.id !== id);
  saveStore();
}

export function addBookingAttempt(
  id: string,
  attempt: BookingAttempt
): void {
  const reservation = store.reservations.find(r => r.id === id);
  if (reservation) {
    if (!reservation.bookingAttempts) {
      reservation.bookingAttempts = [];
    }
    reservation.bookingAttempts.push(attempt);
    
    // Keep only last 50 attempts to avoid bloat
    if (reservation.bookingAttempts.length > 50) {
      reservation.bookingAttempts = reservation.bookingAttempts.slice(-50);
    }
    
    saveStore();
  }
}

// Helper function to decrypt credentials when reading
function decryptReservationCredentials(reservation: ReservationRequest): ReservationRequest {
  try {
    const decryptedCredentials: PlatformCredentials = {
      platform: 'resy',
      authToken: '',
    };
    
    // Decrypt authToken if present and encrypted
    if (reservation.credentials.authToken && isEncrypted(reservation.credentials.authToken)) {
      decryptedCredentials.authToken = decryptPassword(reservation.credentials.authToken);
    } else {
      decryptedCredentials.authToken = reservation.credentials.authToken;
    }
    
    return {
      ...reservation,
      credentials: decryptedCredentials,
    };
  } catch (error) {
    console.error('Failed to decrypt credentials for reservation:', reservation.id);
    return reservation;
  }
}
