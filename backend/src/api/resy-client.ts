import axios, { AxiosInstance } from 'axios';
import type { 
  Restaurant, 
  SearchResult, 
  AvailableSlot, 
  BookingResult,
  PlatformCredentials 
} from '../../../shared/src/types.js';
import { addBookingAttempt } from '../database.js';

// Resy API endpoints (reverse-engineered)
const RESY_BASE_URL = 'https://api.resy.com';
const RESY_API_KEY = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5'; // Public API key from Resy web app

interface ResyAuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
  };
}

interface ResyVenue {
  id: {
    resy: number;
  };
  name: string;
  location: {
    name: string;
    address_1: string;
    address_2?: string;
    city: string;
    state: string;
    postal_code: string;
  };
  type: string;
  booking_config?: {
    booking_window: number; // days in advance
    booking_time?: string; // time when bookings open
  };
}

interface ResyAvailability {
  results: {
    venues: Array<{
      slots: Array<{
        config: {
          id: string;
          type: string;
          token: string;
        };
        date: {
          start: string;
          end: string;
        };
        party_size: number;
      }>;
    }>;
  };
}

class ResyClient {
  private client: AxiosInstance;
  private authToken: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: RESY_BASE_URL,
      headers: {
        'Authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
  }

  // Request SMS verification code for phone number
  async requestSmsCode(phoneNumber: string): Promise<void> {
    try {
      console.log(`Requesting SMS code for phone: ${phoneNumber}`);
      const response = await this.client.post('/3/auth/password', {
        phone: phoneNumber,
      });
      console.log('SMS code request response:', response.data);
    } catch (error: any) {
      console.error('Failed to request SMS code:');
      console.error('Status:', error.response?.status);
      console.error('Data:', JSON.stringify(error.response?.data, null, 2));
      console.error('Message:', error.message);
      throw new Error('Failed to request SMS verification code');
    }
  }

  // Verify SMS code and get auth token
  async verifySmsCode(phoneNumber: string, code: string): Promise<string> {
    try {
      console.log(`Verifying SMS code for phone: ${phoneNumber}`);
      const response = await this.client.post<ResyAuthResponse>('/3/auth/password', {
        phone: phoneNumber,
        code: code,
      });

      this.authToken = response.data.token;
      console.log('Successfully authenticated, token received');
      return this.authToken;
    } catch (error: any) {
      console.error('SMS verification failed:');
      console.error('Status:', error.response?.status);
      console.error('Data:', JSON.stringify(error.response?.data, null, 2));
      console.error('Message:', error.message);
      throw new Error('Failed to verify SMS code');
    }
  }

  // Authenticate using stored auth token or phone/password (legacy)
  async authenticate(credentials: PlatformCredentials): Promise<string> {
    try {
      // If we have a stored auth token, use it
      if (credentials.authToken) {
        this.authToken = credentials.authToken;
        return this.authToken;
      }

      // Legacy email/password auth (if still supported)
      if (credentials.email && credentials.password) {
        const response = await this.client.post<ResyAuthResponse>('/3/auth/password', {
          email: credentials.email,
          password: credentials.password,
        });
        this.authToken = response.data.token;
        return this.authToken;
      }

      throw new Error('No valid authentication credentials provided');
    } catch (error: any) {
      console.error('Resy authentication failed:', error.response?.data || error.message);
      throw new Error('Failed to authenticate with Resy');
    }
  }

  // Search for restaurants
  async searchRestaurants(query: string, location: string): Promise<SearchResult> {
    try {
      // Resy API requires lat/long. For now, use hardcoded Philadelphia coords
      // TODO: Implement geocoding service
      const response = await this.client.post('/3/venuesearch/search', {
        query,
        geo: {
          latitude: 39.9526,  // Philadelphia
          longitude: -75.1652
        },
        per_page: 10,
      });

      // The actual API response structure is: { search: { hits: [...] } }
      const venues = response.data.search?.hits || [];
      
      const restaurants: Restaurant[] = venues.map((venue: any) => ({
        id: venue.id.resy.toString(),
        name: venue.name,
        location: venue.locality || venue.region || 'Unknown',
        address: venue.neighborhood 
          ? `${venue.neighborhood}, ${venue.locality}, ${venue.region}` 
          : `${venue.locality}, ${venue.region}`,
        cuisine: Array.isArray(venue.cuisine) && venue.cuisine.length > 0 
          ? venue.cuisine[0] 
          : (venue.type || 'Restaurant'),
        bookingWindow: {
          daysInAdvance: 30, // Default, not provided in search results
          releaseTime: '09:00', // Default, not provided in search results
          timezone: 'America/New_York', // Default, should be determined by location
        },
        platform: 'resy',
      }));

      return {
        restaurants,
        query,
      };
    } catch (error: any) {
      console.error('Restaurant search failed:');
      console.error('Status:', error.response?.status);
      console.error('Data:', JSON.stringify(error.response?.data, null, 2));
      console.error('Message:', error.message);
      throw new Error('Failed to search restaurants');
    }
  }

  // Get available time slots for a restaurant
  async getAvailability(
    venueId: string,
    date: string, // YYYY-MM-DD
    partySize: number
  ): Promise<AvailableSlot[]> {
    try {
      const response = await this.client.get<ResyAvailability>('/4/find', {
        params: {
          lat: 0,
          long: 0,
          day: date,
          party_size: partySize,
          venue_id: venueId,
        },
      });

      const slots = response.data.results?.venues?.[0]?.slots || [];
      
      return slots.map(slot => {
        const startTime = new Date(slot.date.start);
        const timeString = startTime.toTimeString().slice(0, 5); // "HH:MM"
        
        return {
          time: timeString,
          date,
          partySize: slot.party_size,
          slotId: slot.config.token,
        };
      });
    } catch (error: any) {
      if (error.response?.status === 404) {
        return []; // No availability
      }
      console.error('Availability check failed:', error.response?.data || error.message);
      throw new Error('Failed to check availability');
    }
  }

  // Book a reservation
  async bookReservation(
    configToken: string,
    credentials: PlatformCredentials,
    reservationId?: string
  ): Promise<BookingResult> {
    try {
      // Ensure we're authenticated
      if (!this.authToken) {
        await this.authenticate(credentials);
      }

      // Step 1: Get booking details to obtain the book_token
      console.log('Getting booking details for config token...');
      
      // Log that we're getting the book token
      if (reservationId) {
        addBookingAttempt(reservationId, {
          timestamp: new Date().toISOString(),
          action: 'getting_book_token',
          message: 'Getting book token from /3/details endpoint',
          details: { configToken }
        });
      }
      
      const detailsResponse = await this.client.get('/3/details', {
        params: {
          config_id: configToken,
          day: configToken.split('/')[5], // Extract date from token
          party_size: configToken.split('/')[7], // Extract party size
        },
        headers: {
          'x-resy-auth-token': this.authToken,
        },
      });

      const bookToken = detailsResponse.data.book_token?.value;
      if (!bookToken) {
        throw new Error('No book_token received from details endpoint');
      }

      console.log('Got book token, attempting to book...');

      // Step 2: Book with the book_token
      const response = await this.client.post(
        '/3/book',
        {
          book_token: bookToken,
          payment_method_id: null, // For free bookings
        },
        {
          headers: {
            'x-resy-auth-token': this.authToken,
          },
        }
      );

      return {
        success: true,
        reservationId: response.data.reservation_id,
        bookedTime: response.data.time_slot,
        confirmationCode: response.data.resy_token,
      };
    } catch (error: any) {
      console.error('Booking failed:', error.response?.data || error.message);
      console.error('Full error details:', JSON.stringify({
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        headers: error.response?.headers,
      }, null, 2));
      
      return {
        success: false,
        error: error.response?.data?.message || error.response?.data?.error || 'Failed to book reservation',
      };
    }
  }

  // Validate credentials
  async validateCredentials(credentials: PlatformCredentials): Promise<boolean> {
    try {
      await this.authenticate(credentials);
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Export singleton instance
export const resyClient = new ResyClient();

// Export convenience functions
export async function searchRestaurants(query: string, location: string) {
  return resyClient.searchRestaurants(query, location);
}

export async function getAvailability(venueId: string, date: string, partySize: number) {
  return resyClient.getAvailability(venueId, date, partySize);
}

export async function bookReservation(slotToken: string, credentials: PlatformCredentials) {
  return resyClient.bookReservation(slotToken, credentials);
}

export async function validateCredentials(credentials: PlatformCredentials) {
  return resyClient.validateCredentials(credentials);
}

export async function requestSmsCode(phoneNumber: string) {
  return resyClient.requestSmsCode(phoneNumber);
}

export async function verifySmsCode(phoneNumber: string, code: string) {
  return resyClient.verifySmsCode(phoneNumber, code);
}
