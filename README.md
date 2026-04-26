# Gossaye AI Agent — Multi-Tool Agent + Lead Research Pipeline

A production-grade AI agent system built with Node.js, Express, and Google Gemini 2.5 Flash. Features a streaming chat agent with tool use and a 4-agent lead research pipeline with Google Sheets integration.

## Live Demo

- **Chat Agent:** [agent.gosanotary.tech](https://agent.gosanotary.tech)
- **Lead Pipeline:** [agent.gosanotary.tech/leads](https://agent.gosanotary.tech/leads)
- **API Docs:** [api.gosanotary.tech/docs](https://api.gosanotary.tech/docs)

---

## Features

### AI Chat Agent
- Streaming responses via Server-Sent Events (SSE)
- 3 integrated tools: Web Search, Calculator, GitHub PR Manager
- Persistent conversation memory across sessions
- RAG user profile extracted from conversation history
- Real-time token cost tracking

### Lead Research Pipeline (4-Agent System)
| Agent | Role |
|-------|------|
| 🔍 Researcher | Web search across 4 data sources |
| 📊 Scorer | Scores lead 1-10 with HOT/WARM/COLD tier |
| ✍️ Writer | Drafts personalized cold outreach email |
| 💾 Logger | Auto-logs to Google Sheets |

### Sales Dashboard
- KPI cards with animated counters
- Donut chart — lead distribution
- Score histogram
- Kanban board (HOT / WARM / COLD columns)
- CSV export

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| AI Model | Google Gemini 2.5 Flash |
| Backend | Node.js, Express |
| Frontend | React 18 |
| Monitoring | Langfuse |
| Notifications | Twilio SMS |
| Email | Nodemailer + Gmail SMTP |
| Sheets | Google Sheets API v4 |
| Deployment | Ubuntu 24.04 VPS, Nginx, PM2 |
| Security | API key auth, rate limiting, prompt injection defense |

---

## API

All endpoints require `X-API-Key` header. Full documentation at [api.gosanotary.tech/docs](https://api.gosanotary.tech/docs).

```bash
# Chat
curl -X POST https://api.gosanotary.tech/api/chat/stream \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"what is 25% of $5000?","sessionId":"demo"}'

# Lead Research
curl -X POST https://api.gosanotary.tech/api/leads/research \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"company":"Stripe"}'
```

---

## Security

- API key authentication on all endpoints
- Prompt injection detection (13 regex patterns)
- Input validation and length limits
- Rate limiting: 20 req/min chat, 10 req/min leads
- Request size limit: 10kb
- Output sanitization (redacts API keys from responses)

---

## Architecture

```
React UI (gemini-chat-ui)
    ↓ HTTPS + X-API-Key
Express API (api.gosanotary.tech:3001)
    ↓
Gemini 2.5 Flash
    ├── search_web → DuckDuckGo API
    ├── calculate  → Safe eval
    └── github_pr  → GitHub REST API
    ↓
Langfuse (monitoring + cost tracking)
```

---

## Setup

```bash
git clone https://github.com/gosadev99-bit/gemini-two-tools-agent
cd gemini-two-tools-agent
npm install
cp .env.example .env  # fill in your keys
node server.js
```

### Required Environment Variables

```
GEMINI_API_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_PUBLIC_KEY=
GOOGLE_SHEET_ID=
GMAIL_USER=
GMAIL_APP_PASSWORD=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
MY_PHONE_NUMBER=
API_KEY_MASTER=
API_KEY_CLIENT1=
API_KEY_REACT_UI=
GITHUB_TOKEN=
GITHUB_USERNAME=
GITHUB_REPO=
```

---

## Built By

**Gossaye Bireda** — Front-End React Developer transitioning to AI Agent Engineer.

- Portfolio: [gosanotary.tech/portfolio](https://gosanotary.tech/portfolio)
- GitHub: [@gosadev99-bit](https://github.com/gosadev99-bit)