import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { initDatabase } from './database.js';
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

wss.on('connection', (ws: any) => {
  console.log('📡 WebSocket client connected');
  
  ws.on('close', () => {
    console.log('📡 WebSocket client disconnected');
  });
});

// Export WebSocket server for use in other modules
export { wss };

// Start the job scheduler
startScheduler();
console.log('⏰ Job scheduler started');
