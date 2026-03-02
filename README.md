# Res-Bot 🍽️

Automated reservation bot for Resy and OpenTable that monitors and books restaurant reservations the moment they become available.

## ⚠️ Disclaimer

This tool is for **personal educational use only**. Using automated bots violates the Terms of Service of both Resy and OpenTable. Use at your own risk.

## Features

- 🔍 Restaurant search and research
- 📅 Calendar-based date selection
- ⏰ Flexible time range selection
- 🤖 Automated booking engine with intelligent polling
- 📊 Real-time dashboard with countdown timers
- 🔔 Success/failure notifications
- 🔐 **AES-256 encrypted password storage**

## Quick Start

```bash
# Install dependencies
npm install

# Start both frontend and backend
npm run dev
```

Backend runs on `http://localhost:3001`  
Frontend runs on `http://localhost:5173`

## How It Works

1. **Search** for a restaurant by name and location
2. **Select** your preferred date and time range
3. **Schedule** the booking attempt
4. The bot **wakes up** 30s before the reservation window opens
5. **Polls** for availability every 1-2 seconds
6. **Books instantly** when a matching slot appears

## Architecture

- **Frontend**: React + TypeScript + Tailwind CSS
- **Backend**: Node.js + Express + SQLite
- **Scheduler**: node-cron for timed job execution
- **APIs**: Resy (primary), OpenTable (planned)

## Configuration

Create a `.env` file in the `backend/` directory:

```env
PORT=3001
DATA_DIR=./data
NODE_ENV=development

# Encryption key for passwords (REQUIRED)
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=your_secure_random_key_here
```

**Important:** Generate a secure encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

See [ENCRYPTION.md](ENCRYPTION.md) for details on password security.

## Project Structure

```
res-bot/
├── frontend/         # React UI
├── backend/          # Express API + scheduler
├── shared/           # Shared TypeScript types
└── package.json      # Workspace root
```

## License

MIT - For educational purposes only
