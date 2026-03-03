# Resy-Bot 🍽️

Automated reservation bot for Resy that monitors and books restaurant reservations the moment they become available.

**⚙️ Requires Chrome Extension:** This bot uses a Chrome extension to make bookings. The extension runs in your browser using your real Resy session to bypass bot detection. See [Quick Start](#quick-start) for installation.

## ⚠️ Disclaimer

This tool is for **personal educational use only**. Using automated bots violates the Terms of Service of Resy. Use at your own risk.

## Features

- 🔍 Restaurant search and research
- 📅 Calendar-based date selection
- ⏰ Flexible time range selection
- 🤖 Automated booking engine with intelligent polling
- 📊 Real-time dashboard with countdown timers
- 🔔 Success/failure notifications
- 🔐 **AES-256 encrypted password storage**

## Quick Start

**Prerequisites:** This bot requires a Chrome extension to make bookings. The extension uses your real browser session to bypass Resy's bot detection (Imperva). Without it, bookings will fail.

### 1. Install Dependencies & Configure

```bash
npm install
```

Create `backend/.env`:
```env
PORT=3001
DATA_DIR=./data
ENCRYPTION_KEY=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
```

### 2. Install Chrome Extension (Required)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **"Developer mode"** (toggle in top-right corner)
3. Click **"Load unpacked"**
4. Navigate to and select the `extension/` folder from this project
5. Verify "Resy Booking Bot" appears in your extensions list

### 3. Log Into Resy & Get Auth Token

1. Open [resy.com](https://resy.com) and log in
2. **Keep a resy.com tab open** - The extension needs this to make bookings from your session
3. Open DevTools (F12 or Cmd+Option+I) → **Network** tab
4. Search for any restaurant on Resy
5. In DevTools, find a request to `api.resy.com`
6. Click request → **Headers** → Find `x-resy-auth-token`
7. Copy the token value (starts with `eyJ...`)

**Note:** The extension will automatically use your open resy.com tab (or create one in background) to make booking requests from your real Resy session.

### 4. Start & Test

```bash
npm run dev  # Backend: localhost:3001, Frontend: localhost:5173
```

**Verify Setup:**
1. Click extension icon in Chrome → Should show ✅ "Connected to backend"
2. Open `http://localhost:5173`
3. Create a test booking:
   - Search: "Gufo Boston"
   - Date: 1-2 weeks out
   - Time: 12:00 PM - 2:00 PM
   - Party: 2
   - Paste auth token
   - Click "Schedule Booking"

**Monitor:**
- Dashboard shows real-time polling status
- Extension console: `chrome://extensions/` → "service worker"
- Backend logs: Terminal output

## How It Works

The bot uses a Chrome extension with a **content script** to make bookings. The content script runs directly on resy.com pages and uses your real browser session, completely bypassing Imperva's bot detection.

**Booking Flow:**
1. You schedule a reservation through the web UI
2. Backend wakes up 30s before booking window opens
3. Backend polls Resy API every 3s for availability
4. When a matching slot is found → Backend sends booking request to extension via WebSocket
5. Extension finds your open resy.com tab (or creates one)
6. Content script on resy.com makes the booking API call using your authenticated session
7. Result sent back through extension → Backend → Dashboard

**Why This Works:**
- Content script runs in resy.com context (not extension context)
- Uses your real browser cookies and session automatically
- Requests are indistinguishable from manual user actions
- Completely bypasses Imperva - no 500 errors, no CAPTCHA

**🔒 Security Note:** The extension makes authenticated API calls using your Resy session. Never share the extension, auth token, or install untrusted extensions.

## Architecture

**Core Components:**
- **Extension** (Chrome): Handles all booking API calls using your browser session - **REQUIRED**
- **Backend** (Node.js): REST API, WebSocket server, job scheduler, polling engine
- **Frontend** (React): User interface for scheduling and monitoring reservations
- **Shared** (TypeScript): Type definitions used across all components

**Tech Stack:**
- Frontend: React + TypeScript + Tailwind CSS + Vite
- Backend: Node.js + Express + WebSocket + node-cron
- Extension: Chrome Manifest v3 service worker
- Database: JSON file storage with AES-256 encryption
- API: Resy public API (reverse-engineered)

## Project Structure

```
resy-bot/
├── frontend/         # React UI
├── backend/          # Express API + scheduler + WebSocket
├── extension/        # Chrome Extension for booking
├── shared/           # Shared TypeScript types
└── package.json      # Workspace root
```

## Troubleshooting

### ⚠️ Extension Issues (Critical - Bookings Won't Work)

**Extension shows "Disconnected"**
- Backend not running: `npm run dev`
- Port conflict: `lsof -ti :3001 | xargs kill -9`
- Reload extension: `chrome://extensions/` → Click reload icon
- Check logs: `chrome://extensions/` → Click "service worker"

**Extension doesn't appear after installation**
- Verify you selected `extension/` folder (not parent or subfolder)
- Enable "Developer mode" in `chrome://extensions/`
- Check for errors: Look for red "Errors" button

**Extension connected but bookings fail**
- Not logged into Resy: Open [resy.com](https://resy.com) and log in
- No resy.com tab open: Keep at least one resy.com tab open (extension will use it)
- Session expired: Log out and back in on resy.com
- Auth token expired: Get fresh token from Network tab
- Payment method missing: Add payment method to your Resy account
- Check extension console: `chrome://extensions/` → "service worker" for error details
- Check content script console: Open resy.com tab → F12 → Console

### Other Issues

**Bookings fail with 401/403 errors**
- Get fresh auth token from Network tab (Step 3 in Quick Start)
- Ensure you're logged into resy.com in Chrome
- Update token in bot and reschedule booking

**No slots found but restaurant shows availability**
- Time range too narrow: Broaden your time window
- Party size mismatch: Check available party sizes on Resy
- Date is incorrect: Verify not in the past
- Manually verify on Resy first

**Backend doesn't start / port already in use**
- Kill process: `lsof -ti :3001 | xargs kill -9`
- Change port: Edit `backend/.env` → `PORT=3002`

## License

MIT - For educational purposes only
