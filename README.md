 # 🤖 Gemini Two-Tools Agent

A conversational AI agent built with Google Gemini that intelligently 
decides which tool to use based on your question.
 Live demo: https://api.gosanotary.tech

## 🚀 Features

- 🧮 **Calculator tool** — handles any math or number problems
- 🔍 **Web Search tool** — looks up facts, people, and current info
- 🧠 **Memory** — remembers your conversation history
- 💬 **Telegram interface** — chat with the agent on your phone

## 🛠️ Tech Stack

- Node.js
- Google Gemini API (gemini-2.0-flash)
- node-telegram-bot-api
- DuckDuckGo Instant Answer API
- dotenv

## ⚙️ Setup

### 1. Clone the repo
git clone https://github.com/gosadev99-bit/gemini-two-tools-agent.git


### 2. Install dependencies
npm install

### 3. Create your .env file
cp .env.example .env

Fill in your keys:
GEMINI_API_KEY=your_gemini_api_key

TELEGRAM_BOT_TOKEN=your_telegram_bot_token

### 4. Run the agent (terminal only)
node index.js

### 5. Run the Telegram bot
node bot.js

## 🧠 How It Works
```
User message
     ↓
Gemini reads the question
     ↓
Gemini decides: calculator or search?
     ↓
Tool runs locally on your machine
     ↓
Result sent back to Gemini
     ↓
Final answer delivered
```

## 💡 Example Conversations

**Math:**
> You: What is 18% tip on $120?
> Bot: An 18% tip on $120 is $21.60.

**Search:**
> You: Who founded Google?
> Bot: Larry Page and Sergey Brin founded Google.

**Memory:**
> You: Add that tip to $200, what is the total?
> Bot: The total is $221.60.

## Deployment

Deploy to VPS (Ubuntu + PM2 + Nginx)
## 👨‍💻 Author

Gossaye Bireda — Front End Developer learning AI Agent Engineering
