# 🤖 Gossaye AI Agent — Backend API

> Production-grade AI agent backend with tool use, multi-agent orchestration, Telegram bot, GitHub PR management, persistent memory, streaming responses, and Google Sheets integration.

**Live API:** https://api.gosanotary.tech  
**Frontend:** https://agent.gosanotary.tech  
**Telegram Bot:** @gossaye_ai_bot

---

## 🚀 What This Does

A Node.js + Express backend that powers a full-stack AI agent system:

- **3-Tool Agent** — Calculator, Web Search, GitHub PR management
- **Streaming Responses** — Word-by-word SSE streaming like ChatGPT
- **Persistent Memory** — Conversation history survives server restarts
- **Lead Research Pipeline** — 4-agent B2B sales automation system
- **Google Sheets Logger** — Auto-logs every researched lead
- **Email Sender** — Nodemailer outreach email delivery
- **SMS Notifications** — Twilio SMS for notary bookings
- **Telegram Bot** — 24/7 bot with memory, tools, and GitHub PR management

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js v22 |
| Framework | Express.js |
| AI | Google Gemini 2.5 Flash API |
| Bot | Telegram Bot API (node-telegram-bot-api) |
| Sheets | Google Sheets API v4 |
| Email | Nodemailer + Gmail SMTP |
| SMS | Twilio |
| Process Manager | PM2 |
| Deployment | Ubuntu 24.04 VPS + Nginx |

---

## 📡 API Endpoints

### Chat
```
POST /api/chat              — Standard chat with tool use
POST /api/chat/stream       — Streaming chat (SSE word-by-word)
DELETE /api/chat/:sessionId — Clear chat history
```

### Profile (RAG Memory)
```
GET  /api/profile           — Get user profile
POST /api/profile           — Update user profile
```

### Lead Research Pipeline
```
POST /api/leads/research    — Run 4-agent lead research pipeline
POST /api/leads/log-sheet   — Log lead to Google Sheets
POST /api/leads/send-email  — Send outreach email via Gmail
```

### Notifications
```
POST /api/notify/sms        — Send SMS via Twilio
GET  /health                — Health check
```

---

## 🤖 Agent Tools

### Tool 1 — Calculator
Evaluates any math expression safely using Function constructor with banned keyword protection.

```js
calculate({ expression: "0.25 * 800" }) // → "200"
```

### Tool 2 — Web Search
Searches DuckDuckGo Instant Answer API (free, no API key needed).

```js
search_web({ query: "Stripe company overview" }) // → summary text
```

### Tool 3 — GitHub PR
Manages Pull Requests on GitHub repositories.

```js
github_pr({ action: "list" })           // → open PRs
github_pr({ action: "create", ... })    // → new PR
github_pr({ action: "review", pr_number: 1 }) // → PR details
```

---

## 📊 Lead Research Pipeline

4 agents run in sequence on every research request:

```
Input: Company name
    ↓
Agent 1: Researcher  → DuckDuckGo searches (overview, news, tech, funding)
    ↓
Agent 2: Scorer      → Lead quality score 1-10, HOT/WARM/COLD tier
    ↓
Agent 3: Writer      → Personalized cold outreach email
    ↓
Agent 4: Logger      → Auto-saves to Google Sheets
    ↓
Output: Full report (research + score + email)
```

---

## ⚡ Streaming Architecture

```
React UI → POST /api/chat/stream
              ↓
         Server-Sent Events (SSE)
              ↓
         { type: "tool",  tool: "calculate" }     ← tool status
         { type: "chunk", text: "The answer" }    ← word by word
         { type: "done",  usage: {...}, cost: "$0.000021" } ← complete
```

---

## 🏃 Running Locally

### Prerequisites
- Node.js v18+
- Gemini API key from https://aistudio.google.com

### Setup
```bash
git clone https://github.com/gosadev99-bit/gemini-two-tools-agent
cd gemini-two-tools-agent
npm install
```

### Environment Variables
Create `.env`:
```
GEMINI_API_KEY=your_gemini_key
TELEGRAM_BOT_TOKEN=your_telegram_token
GITHUB_TOKEN=your_github_token
GITHUB_USERNAME=your_github_username
GITHUB_REPO=your_repo_name
GOOGLE_SHEET_ID=your_sheet_id
GMAIL_USER=your_gmail
GMAIL_APP_PASSWORD=your_app_password
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=your_twilio_number
MY_PHONE_NUMBER=your_phone
```

### Run
```bash
# API server
node server.js

# Telegram bot (separate terminal)
node bot.js

# Both with PM2
pm2 start server.js --name gossaye-api
pm2 start bot.js --name gossaye-bot
```

---

## 🚀 Production Deployment

Deployed on Hostinger VPS (Ubuntu 24.04):

```
/var/www/gemini-two-tools-agent/
├── server.js          ← Express API (port 3001)
├── bot.js             ← Telegram bot
├── memory.json        ← Persistent conversation memory
├── userProfile.json   ← RAG user profile
└── google-credentials.json  ← Google Sheets auth (not in git)
```

Nginx proxies `api.gosanotary.tech` → `localhost:3001`  
PM2 keeps both processes running 24/7 with auto-restart.

---

## 📈 Features Built

- ✅ Multi-turn conversation with sliding window (last 20 messages)
- ✅ Tool use — Gemini decides which tool to call
- ✅ Streaming SSE with 30ms word delay
- ✅ Cost tracking (input/output tokens + USD estimate)
- ✅ Entity extraction for RAG user profile
- ✅ Auto-retry on 429/503 rate limit errors
- ✅ Message queue for concurrent Telegram messages
- ✅ Graceful shutdown saves memory on SIGINT/SIGTERM
- ✅ Google Sheets auto-logging for lead pipeline
- ✅ Gmail SMTP email delivery
- ✅ Twilio SMS notifications

---

## 👤 Author

**Gossaye Bireda** — AI Agent Engineer  
gosa.dev99@gmail.com  
https://agent.gosanotary.tech  
https://github.com/gosadev99-bit