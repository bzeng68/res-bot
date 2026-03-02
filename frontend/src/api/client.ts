import axios from 'axios';
import type { 
  SearchResult, 
  ReservationRequest,
  ApiResponse 
} from '../../../shared/src/types';

const API_BASE_URL = '/api';

const client = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Restaurant endpoints
export async function searchRestaurants(
  query: string, 
  location: string
): Promise<SearchResult> {
  const response = await client.get<ApiResponse<SearchResult>>('/restaurants/search', {
    params: { query, location },
  });
  return response.data.data!;
}

// Reservation endpoints
export async function createReservation(
  data: Partial<ReservationRequest>
): Promise<ReservationRequest> {
  const response = await client.post<ApiResponse<ReservationRequest>>('/reservations', data);
  return response.data.data!;
}

export async function getAllReservations(): Promise<ReservationRequest[]> {
  const response = await client.get<ApiResponse<ReservationRequest[]>>('/reservations');
  return response.data.data!;
}

export async function getActiveReservations(): Promise<ReservationRequest[]> {
  const response = await client.get<ApiResponse<ReservationRequest[]>>('/reservations/active');
  return response.data.data!;
}

export async function updateReservation(
  id: string,
  updates: Partial<ReservationRequest>
): Promise<ReservationRequest> {
  const response = await client.patch<ApiResponse<ReservationRequest>>(`/reservations/${id}`, updates);
  return response.data.data!;
}

export async function deleteReservation(id: string): Promise<void> {
  await client.delete(`/reservations/${id}`);
}

// Resy authentication endpoints
export async function requestResySmsCode(phoneNumber: string): Promise<void> {
  await client.post('/auth/resy/request-code', { phoneNumber });
}

export async function verifyResySmsCode(phoneNumber: string, code: string): Promise<string> {
  const response = await client.post<ApiResponse<{ authToken: string }>>('/auth/resy/verify-code', {
    phoneNumber,
    code,
  });
  return response.data.data!.authToken;
}

// WebSocket connection
export function connectWebSocket(onMessage: (data: any) => void): WebSocket {
  const ws = new WebSocket('ws://localhost:3001');
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    onMessage(data);
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  return ws;
}
