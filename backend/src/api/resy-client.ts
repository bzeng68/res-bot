import axios, { AxiosInstance } from 'axios';
import type { 
  Restaurant, 
  SearchResult, 
  AvailableSlot,
} from '../../../shared/src/types.js';

// Resy API endpoints (reverse-engineered)
const RESY_BASE_URL = 'https://api.resy.com';
const RESY_API_KEY = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5'; // Public API key from Resy web app

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
          daysInAdvance: 30, // Default - most restaurants use 30 days
          releaseTime: '00:00', // Default to midnight - most common release time
          timezone: 'America/New_York', // Default to ET, should be determined by location
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
      const response = await this.client.get<any>('/4/find', {
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

  // Fetch the user's Resy payment method ID using their auth token
  async getPaymentMethodId(authToken: string): Promise<number | null> {
    const baseHeaders = {
      'Authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
      'X-Resy-Auth-Token': authToken,
      'X-Resy-Universal-Auth': authToken,
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin': 'https://resy.com',
      'Referer': 'https://resy.com/',
    };

    try {
      const res = await axios.get(`${RESY_BASE_URL}/2/user`, { headers: baseHeaders });
      const paymentMethods = res.data?.payment_methods;
      if (paymentMethods && paymentMethods.length > 0) {
        const id = paymentMethods[0]?.id;
        console.log(`💳 Found payment method ID: ${id}`);
        return id;
      }
    } catch (err: any) {
      console.warn('Could not fetch payment method from /2/user:', err.response?.data || err.message);
    }

    // Fallback: try /3/user
    try {
      const res = await axios.get(`${RESY_BASE_URL}/3/user`, { headers: baseHeaders });
      const pm = res.data?.payment_method_id || res.data?.payment_methods?.[0]?.id;
      if (pm) {
        console.log(`💳 Found payment method ID (fallback): ${pm}`);
        return pm;
      }
    } catch (err: any) {
      console.warn('Could not fetch payment method from /3/user:', err.response?.data || err.message);
    }

    return null;
  }

  // Fetch the book_token for a specific slot. Extracted so the prewarm step can
  // call it independently and cache the result, eliminating /3/details from the
  // hot booking path (~1.5s saved).
  async getBookToken(
    slotToken: string,
    partySize: number,
    venueId: string,
    authToken: string,
    headers?: Record<string, string>,
  ): Promise<string> {
    const commonHeaders = headers ?? {
      'Authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
      'X-Resy-Auth-Token': authToken,
      'X-Resy-Universal-Auth': authToken,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Host': 'api.resy.com',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };

    const dateMatch = slotToken.match(/(\d{4}-\d{2}-\d{2})/);
    const day = dateMatch ? dateMatch[1] : '';
    if (!day) throw new Error(`Could not extract date from slot token: ${slotToken}`);

    const detailsUrl = `${RESY_BASE_URL}/3/details?day=${encodeURIComponent(day)}&party_size=${partySize}&x-resy-auth-token=${encodeURIComponent(authToken)}&venue_id=${encodeURIComponent(venueId)}&config_id=${encodeURIComponent(slotToken)}`;
    console.log(`📋 GET /3/details for venue ${venueId} on ${day} party ${partySize}...`);

    const detailsRes = await axios.get(detailsUrl, { headers: commonHeaders });
    const bookToken = detailsRes.data?.book_token?.value;

    if (!bookToken) {
      console.error('Details response:', JSON.stringify(detailsRes.data));
      throw new Error('No book_token returned from /3/details');
    }
    console.log('✓ Got book token');
    return bookToken;
  }

  // Book a reservation. Mirrors the working open-source resybot approach:
  //  1. GET /3/details (NOT POST) with venue_id + auth token in query string
  //  2. POST /3/book with struct_payment_method + source_id
  // No cookies required — the JWT auth token is sufficient.
  //
  // Pass `cachedPaymentMethodId` to skip the /2/user fetch (~400ms saved).
  // Pass `cachedBookToken` to skip the /3/details fetch (~1.5s saved).
  async bookReservation(
    slotToken: string,
    partySize: number,
    venueId: string,
    authToken: string,
    cachedPaymentMethodId?: number,
    cachedBookToken?: string,
  ): Promise<{ confirmationCode: string; reservationDetails: any }> {
    const commonHeaders = {
      'Authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
      'X-Resy-Auth-Token': authToken,
      'X-Resy-Universal-Auth': authToken,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Host': 'api.resy.com',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };

    // Step 1: book_token — use cached value if available (skips /3/details, ~1.5s saved)
    let bookToken: string;
    if (cachedBookToken) {
      bookToken = cachedBookToken;
      console.log('⚡ Using cached book_token (skipped /3/details)');
    } else {
      bookToken = await this.getBookToken(slotToken, partySize, venueId, authToken, commonHeaders);
    }

    // Step 2: Payment method ID — use cached value if available (avoids a ~400ms round-trip)
    let paymentMethodId: number | null;
    if (cachedPaymentMethodId != null) {
      paymentMethodId = cachedPaymentMethodId;
      console.log(`💳 Using cached payment method ID: ${paymentMethodId}`);
    } else {
      paymentMethodId = await this.getPaymentMethodId(authToken);
      if (!paymentMethodId) {
        console.warn('⚠️ Could not retrieve payment method ID — booking may fail without it');
      }
    }

    // Step 3: POST /3/book with struct_payment_method + source_id
    const bookHeaders = {
      ...commonHeaders,
      'X-Origin': 'https://widgets.resy.com',
      'Referer': 'https://widgets.resy.com/',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'empty',
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const bookPayload: Record<string, string> = {
      book_token: bookToken,
      source_id: 'resy.com-venue-details',
    };
    if (paymentMethodId) {
      bookPayload.struct_payment_method = JSON.stringify({ id: paymentMethodId });
    }

    console.log(`📝 POST /3/book (payment method: ${paymentMethodId ?? 'none'})...`);
    const bookRes = await axios.post(
      `${RESY_BASE_URL}/3/book`,
      new URLSearchParams(bookPayload).toString(),
      { headers: bookHeaders },
    );

    const confirmationCode = bookRes.data?.resy_token || bookRes.data?.reservation_id || '';
    console.log('🎉 Booked! Confirmation:', confirmationCode);

    return { confirmationCode, reservationDetails: bookRes.data };
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

export async function getBookToken(slotToken: string, partySize: number, venueId: string, authToken: string) {
  return resyClient.getBookToken(slotToken, partySize, venueId, authToken);
}

export async function bookReservation(slotToken: string, partySize: number, venueId: string, authToken: string, paymentMethodId?: number, bookToken?: string) {
  return resyClient.bookReservation(slotToken, partySize, venueId, authToken, paymentMethodId, bookToken);
}
