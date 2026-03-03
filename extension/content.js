// Content script injected into resy.com pages
// Makes API calls from resy.com context to use real session/cookies

const RESY_API_BASE = 'https://api.resy.com';
const RESY_API_KEY = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5';

console.log('🍽️ Resy Bot content script loaded');

// Listen for booking requests from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MAKE_BOOKING') {
    handleBooking(message.data)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

// Extract auth token from current session
function getAuthToken() {
  // Try to get from localStorage first
  const token = localStorage.getItem('resy_auth_token') || 
                localStorage.getItem('auth_token') ||
                sessionStorage.getItem('resy_auth_token');
  
  if (token) {
    console.log('✓ Found auth token in storage');
    return token;
  }
  
  // If not in storage, cookies will be used automatically
  console.log('⚠️ No auth token in storage, relying on cookies');
  return null;
}

async function handleBooking(data) {
  const { slotToken, partySize } = data;
  
  console.log('🎯 Making booking request from resy.com context...');
  
  // Get fresh auth token from current session
  const authToken = getAuthToken();
  
  const headers = {
    'Authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  
  // Add auth token header if available
  if (authToken) {
    headers['X-Resy-Auth-Token'] = authToken;
    headers['X-Resy-Universal-Auth'] = authToken;
  }
  
  // Step 1: Get booking details
  const detailsResponse = await fetch(`${RESY_API_BASE}/3/details`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ 
      config_id: slotToken, 
      day: '', 
      party_size: partySize 
    }),
    credentials: 'include', // This is the key - uses browser cookies
  });
  
  if (!detailsResponse.ok) {
    const errorText = await detailsResponse.text();
    throw new Error(`Details request failed: ${detailsResponse.status} - ${errorText}`);
  }
  
  const detailsData = await detailsResponse.json();
  const bookToken = detailsData.book_token?.value;
  
  if (!bookToken) {
    throw new Error('No book token returned from details endpoint');
  }
  
  console.log('✓ Got book token');
  
  // Step 2: Book the reservation
  const bookResponse = await fetch(`${RESY_API_BASE}/3/book`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ book_token: bookToken }),
    credentials: 'include',
  });
  
  if (!bookResponse.ok) {
    const errorData = await bookResponse.json().catch(() => ({}));
    throw new Error(`Booking failed: ${bookResponse.status} - ${errorData.message || 'Unknown error'}`);
  }
  
  const bookData = await bookResponse.json();
  
  console.log('🎉 Booking successful!');
  
  return {
    confirmationCode: bookData.resy_token || bookData.reservation_id,
    reservationDetails: bookData,
  };
}
