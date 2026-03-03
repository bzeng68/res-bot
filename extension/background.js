// Resy Booking Bot - Background Service Worker
// Connects to backend via WebSocket and delegates booking to content script

const BACKEND_WS_URL = 'ws://localhost:3001';

let ws = null;
let reconnectTimer = null;
let isConnected = false;

// Initialize WebSocket connection
function connectToBackend() {
  console.log('🔌 Connecting to backend...');
  
  try {
    ws = new WebSocket(BACKEND_WS_URL);
    
    ws.onopen = () => {
      console.log('✅ Connected to backend');
      isConnected = true;
      
      // Send registration message
      sendMessage({
        type: 'EXTENSION_CONNECTED',
        timestamp: new Date().toISOString(),
      });
      
      // Clear reconnect timer
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleBackendMessage(message);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };
    
    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
    };
    
    ws.onclose = () => {
      console.log('❌ Disconnected from backend');
      isConnected = false;
      
      // Attempt to reconnect after 5 seconds
      reconnectTimer = setTimeout(connectToBackend, 5000);
    };
  } catch (error) {
    console.error('Failed to create WebSocket:', error);
    reconnectTimer = setTimeout(connectToBackend, 5000);
  }
}

// Send message to backend
function sendMessage(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  } else {
    console.error('Cannot send message - WebSocket not connected');
  }
}

// Handle messages from backend
async function handleBackendMessage(message) {
  console.log('📨 Received message:', message.type);
  
  switch (message.type) {
    case 'BOOK_RESERVATION':
      await handleBookingRequest(message.data);
      break;
      
    case 'PING':
      sendMessage({ type: 'PONG', timestamp: new Date().toISOString() });
      break;
      
    default:
      console.log('Unknown message type:', message.type);
  }
}

// Handle booking request from backend
async function handleBookingRequest(data) {
  const { slotToken, reservationId, partySize } = data;
  
  console.log(`🎯 Attempting to book reservation ${reservationId}...`);
  
  try {
    // Find or create a resy.com tab to execute booking from
    const resyTab = await findOrCreateResyTab();
    
    if (!resyTab) {
      throw new Error('Could not open resy.com tab. Please open resy.com manually.');
    }
    
    console.log(`📋 Using tab ${resyTab.id} for booking`);
    
    // Send booking request to content script running on resy.com
    const response = await chrome.tabs.sendMessage(resyTab.id, {
      type: 'MAKE_BOOKING',
      data: {
        slotToken,
        partySize: partySize || 2,
      },
    });
    
    if (!response.success) {
      throw new Error(response.error);
    }
    
    console.log('🎉 Booking successful!');
    
    // Send success to backend
    sendMessage({
      type: 'BOOKING_SUCCESS',
      data: {
        reservationId,
        confirmationCode: response.data.confirmationCode,
        reservationDetails: response.data.reservationDetails,
      },
    });
    
  } catch (error) {
    console.error('❌ Booking failed:', error);
    
    // Send failure to backend
    sendMessage({
      type: 'BOOKING_FAILED',
      data: {
        reservationId,
        error: error.message,
      },
    });
  }
}

// Find existing resy.com tab or create a new one
async function findOrCreateResyTab() {
  try {
    // Look for existing resy.com tabs
    const tabs = await chrome.tabs.query({ url: 'https://resy.com/*' });
    
    if (tabs.length > 0) {
      // Use the first resy.com tab found
      return tabs[0];
    }
    
    // No resy.com tab found, create one in background
    console.log('📂 No resy.com tab found, creating one...');
    const newTab = await chrome.tabs.create({
      url: 'https://resy.com',
      active: false, // Don't switch to it
    });
    
    // Wait for tab to load
    await new Promise(resolve => {
      const listener = (tabId, changeInfo) => {
        if (tabId === newTab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    
    return newTab;
  } catch (error) {
    console.error('Failed to find/create resy.com tab:', error);
    return null;
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_STATUS') {
    sendResponse({ connected: isConnected });
  }
  return true; // Keep message channel open for async response
});

// Initialize when extension loads
console.log('🚀 Resy Booking Bot extension loaded');
connectToBackend();

// Keep service worker alive with periodic ping
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log('⏰ Keep-alive ping');
    
    // Reconnect if disconnected
    if (!isConnected) {
      connectToBackend();
    }
  }
});
