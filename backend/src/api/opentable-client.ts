import axios, { AxiosInstance } from 'axios';
import type { 
  Restaurant, 
  SearchResult, 
  AvailableSlot, 
  BookingResult,
  PlatformCredentials 
} from '../../../shared/src/types.js';

// OpenTable API endpoints (reverse-engineered from their web app)
const OPENTABLE_BASE_URL = 'https://www.opentable.com';

interface OpenTableVenue {
  rid: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postal?: string;
  neighborhood?: string;
  primaryCuisine?: string;
  cuisine?: string[];
}

class OpenTableClient {
  private client: AxiosInstance;
  private authToken: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: OPENTABLE_BASE_URL,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.opentable.com/',
        'Origin': 'https://www.opentable.com',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
  }

  // Authenticate with OpenTable
  async authenticate(credentials: PlatformCredentials): Promise<boolean> {
    // TODO: Implement OpenTable authentication
    // OpenTable uses OAuth or session-based auth
    console.warn('OpenTable authentication not yet implemented');
    return false;
  }

  // Search for restaurants
  async searchRestaurants(query: string, location: string): Promise<SearchResult> {
    try {
      // Try OpenTable's restaurant search endpoint
      // Note: OpenTable actively blocks automated access, so this may have limited success
      const response = await this.client.get('/api/v1/search', {
        params: {
          term: query,
          size: 10,
        },
        timeout: 5000,
      });

      const results = response.data?.results || response.data?.items || [];
      
      const restaurants: Restaurant[] = results
        .filter((item: any) => item.type !== 'geo')
        .map((venue: any) => {
          const loc = venue.location || venue.geo || {};
          return {
            id: venue.rid?.toString() || venue.id?.toString() || '',
            name: venue.name || venue.title || '',
            location: loc.city ? `${loc.city}${loc.state ? ', ' + loc.state : ''}` : loc.neighborhood || loc.locality || 'Unknown',
            address: loc.address || venue.address || '',
            cuisine: venue.primaryCuisine || venue.cuisine || 'Restaurant',
            bookingWindow: {
              daysInAdvance: 30,
              releaseTime: '00:00',
              timezone: 'America/New_York',
            },
            platform: 'opentable',
          } as Restaurant;
        })
        .filter((r: Restaurant) => r.id !== '' && r.name !== '');

      console.log(`OpenTable search returned ${restaurants.length} results for "${query}"`);
      
      return {
        restaurants,
        query,
      };
    } catch (error: any) {
      // OpenTable blocks automated requests - log but don't spam console
      if (error.response?.status === 503 || error.response?.status === 403) {
        console.warn('OpenTable blocking automated requests (expected)');
      } else {
        console.error('OpenTable search error:', error.response?.status || error.message);
      }
      
      // Return empty results on error instead of throwing
      return {
        restaurants: [],
        query,
      };
    }
  }

  // Get available time slots for a restaurant
  async getAvailability(
    venueId: string,
    date: string,
    partySize: number
  ): Promise<AvailableSlot[]> {
    // TODO: Implement OpenTable availability check
    console.warn('OpenTable availability check not yet implemented');
    return [];
  }

  // Book a reservation
  async bookReservation(
    credentials: PlatformCredentials,
    venueId: string,
    slotId: string,
    partySize: number,
    date: string,
    time: string
  ): Promise<BookingResult> {
    // TODO: Implement OpenTable booking
    console.warn('OpenTable booking not yet implemented');
    return {
      success: false,
      error: 'OpenTable booking not yet implemented',
    };
  }
}

// Export a singleton instance
const openTableClient = new OpenTableClient();

export const searchRestaurants = (query: string, location: string) => 
  openTableClient.searchRestaurants(query, location);

export const getAvailability = (venueId: string, date: string, partySize: number) =>
  openTableClient.getAvailability(venueId, date, partySize);

export const bookReservation = (
  credentials: PlatformCredentials,
  venueId: string,
  slotId: string,
  partySize: number,
  date: string,
  time: string
) => openTableClient.bookReservation(credentials, venueId, slotId, partySize, date, time);

export const authenticate = (credentials: PlatformCredentials) =>
  openTableClient.authenticate(credentials);
