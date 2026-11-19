# Eazychat — Real-Time Messaging Application

A full-stack, WhatsApp-style real-time messaging web application built with **Node.js**, **Express**, and **Socket.io**.

## Features
- **User Accounts & Auth:** Registration and sign-in with bcrypt-hashed passwords and JWT sessions.
- **Real-Time 1-on-1 & Group Messaging:** Instant message delivery powered by Socket.io WebSockets.
- **Live Presence & Typing Indicators:** Online green dots, last-seen timestamps, and real-time `typing...` indicators.
- **Delivery & Read Receipts:** Single gray check (sent), double gray check (delivered), and double blue check (read).
- **Rich Messaging:** Reply-to quotes, emoji picker, emoji reactions, image uploads (up to 5 MB), and message deletion.
- **Responsive UI & Dark Mode:** Works cleanly on desktop and mobile screens with a built-in light/dark theme toggle.

## Run Locally

### 1. Prerequisites
Install [Node.js 18+](https://nodejs.org/).

### 2. Install & Start
```bash
cd eazychat-fullstack
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000` in your browser.

### 3. Test Real-Time Messaging
1. Open `http://localhost:3000` in one browser window and create Account A.
2. Open `http://localhost:3000` in an incognito/private window and create Account B.
3. Click the **+** button in either window, select the other user, and start chatting in real time!

## Deploy Live (Free Tier)

### Option A: Render (Includes `render.yaml`)
1. Push this folder to a GitHub repository.
2. Go to [Render](https://render.com) → **New** → **Blueprint** (or **Web Service**) and connect your repo.
3. Render automatically runs `npm install` and `npm start`, generates `JWT_SECRET`, and gives you a live HTTPS URL.

### Option B: Railway
1. Push this folder to GitHub.
2. Go to [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Add a `JWT_SECRET` environment variable in Railway's Variables tab and generate a public domain.

> **Note for Production Persistence:** This starter stores data in `data/eazychat-db.json` and uploaded photos in `uploads/` so it works out of the box with zero external setup. For large-scale production deployments on ephemeral hosts, attach a persistent disk volume or swap `server/db.js` to PostgreSQL/MongoDB and store uploads in S3/Cloudinary.
