import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { initDatabase, addBookingAttempt } from './database.js';
import reservationRoutes from './routes/reservations.js';
import restaurantRoutes from './routes/restaurants.js';
import authRoutes from './routes/auth.js';
import { startScheduler } from './scheduler/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/reservations', reservationRoutes);
app.use('/api/restaurants', restaurantRoutes);
app.use('/api/auth', authRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize database
initDatabase();
console.log('✅ Database initialized');

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
});

// WebSocket for real-time updates
const wss = new WebSocketServer({ server });

// Track connected clients
let extensionClient: any = null;
const frontendClients: Set<any> = new Set();

wss.on('connection', (ws: any) => {
  console.log('📡 WebSocket client connected');
  
  // Initially assume it's a frontend client
  frontendClients.add(ws);
  
  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('📨 Received message:', message.type);
      
      switch (message.type) {
        case 'EXTENSION_CONNECTED':
          // This is the Chrome extension
          frontendClients.delete(ws);
          extensionClient = ws;
          console.log('✅ Chrome Extension connected');
          break;
          
        case 'BOOKING_SUCCESS':
          // Forward booking success to frontend clients
          console.log('🎉 Booking succeeded:', message.data);
          
          // Log to database
          addBookingAttempt(message.data.reservationId, {
            timestamp: new Date().toISOString(),
            slotTime: '', // Time info in reservationDetails
            slotDate: '',
            action: 'success',
            message: 'Successfully booked reservation via Chrome Extension',
            details: {
              confirmationCode: message.data.confirmationCode,
              reservationDetails: message.data.reservationDetails,
            },
          });
          
          broadcastToFrontend({
            type: 'BOOKING_UPDATE',
            data: {
              reservationId: message.data.reservationId,
              status: 'confirmed',
              ...message.data,
            },
          });
          break;
          
        case 'BOOKING_FAILED':
          // Forward booking failure to frontend clients
          console.log('❌ Booking failed:', message.data);
          
          // Log to database
          addBookingAttempt(message.data.reservationId, {
            timestamp: new Date().toISOString(),
            slotTime: '',
            slotDate: '',
            action: 'error',
            message: `Booking failed via Chrome Extension: ${message.data.error}`,
            details: { error: message.data.error },
          });
          
          broadcastToFrontend({
            type: 'BOOKING_UPDATE',
            data: {
              reservationId: message.data.reservationId,
              status: 'failed',
              ...message.data,
            },
          });
          break;
          
        case 'PONG':
          // Extension is alive
          break;
          
        default:
          console.log('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Failed to handle WebSocket message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('📡 WebSocket client disconnected');
    
    // Clean up references
    if (ws === extensionClient) {
      extensionClient = null;
      console.log('❌ Chrome Extension disconnected');
    } else {
      frontendClients.delete(ws);
    }
  });
});

// Helper functions for WebSocket communication
function broadcastToFrontend(message: any) {
  const data = JSON.stringify(message);
  frontendClients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  });
}

function sendToExtension(message: any) {
  if (extensionClient && extensionClient.readyState === 1) {
    extensionClient.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// Export WebSocket server and helpers for use in other modules
export { wss, sendToExtension, broadcastToFrontend };

// Start the job scheduler
startScheduler();
console.log('⏰ Job scheduler started');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  process.exit(0);
});
