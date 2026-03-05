import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase } from './database.js';
import { initWebSocket } from './ws.js';
import reservationRoutes from './routes/reservations.js';
import restaurantRoutes from './routes/restaurants.js';
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
initWebSocket(server);

// Export WebSocket server and helpers for use in other modules
export { wss, broadcastToFrontend } from './ws.js';

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
