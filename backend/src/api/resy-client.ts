import axios, { AxiosInstance } from 'axios';
import type { 
  Restaurant, 
  SearchResult, 
  AvailableSlot, 
  PlatformCredentials 
} from '../../../shared/src/types.js';

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

  constructor() {
    this.client = axios.create({
      baseURL: RESY_BASE_URL,
      headers: {
        'Authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
  }

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
