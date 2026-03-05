import { WebSocketServer } from 'ws';
import type { Server } from 'http';

export let wss: WebSocketServer;
const frontendClients = new Set<any>();

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server });
  wss.on('connection', (ws: any) => {
    console.log('📡 WebSocket client connected');
    frontendClients.add(ws);
    ws.on('close', () => {
      frontendClients.delete(ws);
    });
  });
}

export function broadcastToFrontend(message: any): void {
  const data = JSON.stringify(message);
  frontendClients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}
