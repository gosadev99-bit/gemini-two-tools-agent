require('dotenv').config();
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ── VALIDATE ENV VARS ON STARTUP ──────────────────────────────────────────
const REQUIRED_ENV = ['GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GITHUB_USERNAME', 'GITHUB_REPO'];
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
});

// ── SETUP ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MEMORY_FILE = './memory.json';

// ── PERSISTENT MEMORY ──────────────────────────────────────────────────────
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = fs.readFileSync(MEMORY_FILE, 'utf8');
      const parsed = JSON.parse(data);
      console.log(`🧠 Memory loaded — ${Object.keys(parsed).length} chat(s) restored`);
      return parsed;
    }
  } catch (err) {
    console.error('⚠️ Could not load memory, starting fresh:', err.message);
  }
  return {};
}

function saveMemory(histories) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(histories, null, 2));
  } catch (err) {
    console.error('⚠️ Could not save memory:', err.message);
  }
}

const chatHistories = loadMemory();

// ── MESSAGE QUEUE ──────────────────────────────────────────────────────────
// Prevents chaos when multiple messages arrive at once
const processingUsers = new Set();
const messageQueues = {};

async function queueMessage(chatId, userMessage) {
  // Add to queue
  if (!messageQueues[chatId]) messageQueues[chatId] = [];
  messageQueues[chatId].push(userMessage);

  // If already processing this user, just queue it
  if (processingUsers.has(chatId)) {
    console.log(`📥 Queued message for ${chatId}: "${userMessage.slice(0, 30)}..."`);
    return;
  }

  // Process queue one message at a time
  processingUsers.add(chatId);
  while (messageQueues[chatId].length > 0) {
    const nextMessage = messageQueues[chatId].shift();
    try {
      bot.sendChatAction(chatId, 'typing');
      const answer = await runAgent(chatId, nextMessage);
      bot.sendMessage(chatId, answer);
    } catch (err) {
      console.error(`Queue error for ${chatId}:`, err.message);
      if (err.response?.status === 429) {
        bot.sendMessage(chatId, "⏳ Too busy right now. Please try again in a minute.");
      } else {
        bot.sendMessage(chatId, "❌ Something went wrong. Try again in a moment.");
      }
    }
  }
  processingUsers.delete(chatId);
}

// ── TOOL DEFINITIONS ───────────────────────────────────────────────────────
const tools = [{
  functionDeclarations: [
    {
      name: "search_web",
      description: "Search the web for real-world facts, current events, people, places, or anything that needs a live lookup.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "The search query to look up" }
        },
        required: ["query"]
      }
    },
    {
      name: "calculate",
      description: "Evaluate a math expression. Use for any arithmetic, percentages, or numeric calculations.",
      parameters: {
        type: "OBJECT",
        properties: {
          expression: { type: "STRING", description: "A valid math expression e.g. '250 * 0.18'" }
        },
        required: ["expression"]
      }
    },
    {
      name: "github_pr",
      description: `Manage GitHub Pull Requests. Use when user wants to:
      - create a pull request (needs: title, head branch, base branch)
      - list open pull requests
      - review/summarize a pull request (needs: PR number)`,
      parameters: {
        type: "OBJECT",
        properties: {
          action: { type: "STRING", description: "One of: 'create', 'list', 'review'" },
          title: { type: "STRING", description: "PR title (required for create)" },
          head: { type: "STRING", description: "Source branch (required for create)" },
          base: { type: "STRING", description: "Target branch, usually 'main' (required for create)" },
          body: { type: "STRING", description: "PR description (optional)" },
          pr_number: { type: "NUMBER", description: "PR number (required for review)" }
        },
        required: ["action"]
      }
    }
  ]
}];

// ── TOOL IMPLEMENTATIONS ───────────────────────────────────────────────────
async function search_web({ query }) {
  console.log(`🔍 search_web → "${query}"`);
  try {
    const res = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 }
    });
    const data = res.data;
    const answer =
      data.AbstractText ||
      data.Answer ||
      data.RelatedTopics?.[0]?.Text ||
      `No direct answer found for: "${query}"`;
    return { result: answer };
  } catch (err) {
    return { result: `Search failed: ${err.message}` };
  }
}

function calculate({ expression }) {
  console.log(`🧮 calculate → "${expression}"`);

  // Security: block dangerous keywords
  const banned = ['process', 'require', 'import', 'eval', 'Function', '__dirname'];
  if (banned.some(word => expression.includes(word))) {
    return { result: 'Invalid expression: contains unsafe code.' };
  }

  try {
    const result = Function('"use strict"; return (' + expression + ')')();
    if (typeof result !== 'number') {
      return { result: 'Expression did not return a number.' };
    }
    return { result: result.toString() };
  } catch (err) {
    return { result: `Calculation error: ${err.message}` };
  }
}

async function github_pr({ action, title, head, base, body, pr_number }) {
  const BASE_URL = `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}`;
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  console.log(`🐙 github_pr → action: "${action}"`);

  try {
    if (action === 'create') {
      if (!title || !head || !base) {
        return { result: "Missing fields: title, head branch, and base branch are required." };
      }
      const res = await axios.post(`${BASE_URL}/pulls`, {
        title, head, base,
        body: body || `PR created by Gossaye's AI Agent 🤖`
      }, { headers });
      return {
        result: `✅ PR created!\n\n` +
                `📌 Title: ${res.data.title}\n` +
                `🔀 Branch: ${head} → ${base}\n` +
                `🔗 Link: ${res.data.html_url}\n` +
                `#️⃣ PR Number: #${res.data.number}`
      };
    }

    if (action === 'list') {
      const res = await axios.get(`${BASE_URL}/pulls?state=open`, { headers });
      if (res.data.length === 0) {
        return { result: "📭 No open pull requests found." };
      }
      const prList = res.data.map(pr =>
        `#${pr.number} — ${pr.title}\n` +
        `   🔀 ${pr.head.ref} → ${pr.base.ref}\n` +
        `   👤 ${pr.user.login}\n` +
        `   🔗 ${pr.html_url}`
      ).join('\n\n');
      return { result: `📋 Open PRs (${res.data.length}):\n\n${prList}` };
    }

    if (action === 'review') {
      if (!pr_number) return { result: "Please provide a PR number to review." };
      const prRes = await axios.get(`${BASE_URL}/pulls/${pr_number}`, { headers });
      const pr = prRes.data;
      const filesRes = await axios.get(`${BASE_URL}/pulls/${pr_number}/files`, { headers });
      const files = filesRes.data;
      const fileList = files.map(f => `• ${f.filename} (+${f.additions} -${f.deletions})`).join('\n');
      return {
        result: `🔍 PR Review — #${pr_number}\n\n` +
                `📌 Title: ${pr.title}\n` +
                `👤 Author: ${pr.user.login}\n` +
                `🔀 ${pr.head.ref} → ${pr.base.ref}\n` +
                `📊 +${pr.additions} / -${pr.deletions} lines\n` +
                `📁 Files (${files.length}):\n${fileList}\n\n` +
                `📝 ${pr.body || 'No description'}\n` +
                `🔗 ${pr.html_url}`
      };
    }

    return { result: `Unknown action: ${action}. Use create, list, or review.` };

  } catch (err) {
    if (err.response?.status === 401) return { result: "❌ GitHub token invalid or expired." };
    if (err.response?.status === 404) return { result: "❌ Repo or branch not found." };
    if (err.response?.status === 422) return { result: `❌ Cannot create PR: ${err.response.data.message}` };
    return { result: `❌ GitHub error: ${err.message}` };
  }
}

const toolHandlers = { search_web, calculate, github_pr };

// ── AGENT LOOP ─────────────────────────────────────────────────────────────
async function runAgent(chatId, userMessage, retryCount = 0) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 20;

  if (!chatHistories[chatId]) chatHistories[chatId] = [];
  const history = chatHistories[chatId];

  console.log(`\n💬 [Chat ${chatId}] User: ${userMessage}`);

  // Keep typing indicator alive during long operations
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      tools,
      systemInstruction: `You are a helpful AI assistant with three tools:
1. search_web — facts, people, news, general knowledge
2. calculate — any math or number problems
3. github_pr — GitHub Pull Request actions (create, list, review)

RULES:
- Always use the right tool. Never guess.
- For GitHub/PR requests → github_pr
- For math → calculate
- For facts → search_web
- Default base branch is 'main' if not specified.
- Be concise and friendly.
- For financial estimates: ALWAYS calculate using best available data. Never refuse.
- Tax calculations: use these 2025 brackets (close enough for estimates):
  10% on $0-$11,925 | 12% on $11,926-$48,475 | 22% on $48,476-$103,350
  Standard deduction: $15,000 single, $22,500 head of household
  Child Tax Credit: $2,000 per child
  ALWAYS attempt the calculation. State assumptions. Never refuse.`
    });

    const chat = model.startChat({ history });
    let response = await chat.sendMessage(userMessage);
    let candidate = response.response.candidates[0];
    let content = candidate.content;

    while (content.parts.some(p => p.functionCall)) {
      const toolCallPart = content.parts.find(p => p.functionCall);
      const { name, args } = toolCallPart.functionCall;
      console.log(`🤖 Gemini chose: "${name}" with ${JSON.stringify(args)}`);
      const toolResult = await toolHandlers[name](args);
      response = await chat.sendMessage([{ functionResponse: { name, response: toolResult } }]);
      candidate = response.response.candidates[0];
      content = candidate.content;
    }

    const finalAnswer = response.response.text();

    // Save to memory — deduplicated and trimmed
    history.push({ role: "user", parts: [{ text: userMessage }] });
    history.push({ role: "model", parts: [{ text: finalAnswer }] });

    const seen = new Set();
    chatHistories[chatId] = history.filter(msg => {
      const key = msg.role + msg.parts[0]?.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (chatHistories[chatId].length > 20) {
      chatHistories[chatId] = chatHistories[chatId].slice(-20);
    }

    saveMemory(chatHistories);
    console.log(`✅ Answer: ${finalAnswer}`);
    clearInterval(typingInterval);
    return finalAnswer;

  } catch (err) {
    clearInterval(typingInterval);

    // Auto-retry on rate limit
    if (err.response?.status === 429 && retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY * (retryCount + 1);
      console.log(`⏳ Rate limited. Retrying in ${delay}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      bot.sendMessage(chatId, `⏳ Give me ${delay} seconds, I'll try again...`);
      await new Promise(r => setTimeout(r, delay * 1000));
      return runAgent(chatId, userMessage, retryCount + 1);
    }

    console.error(`❌ runAgent error: ${err.message}`);
    throw err;
  }
}
// ── TELEGRAM COMMANDS ──────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "there";
  bot.sendMessage(msg.chat.id,
    `👋 Hey ${name}! I'm your AI Agent.\n\n` +
    `I have three tools:\n` +
    `🧮 *Calculator* — any math problem\n` +
    `🔍 *Web Search* — facts and general knowledge\n` +
    `🐙 *GitHub PR* — create, list, review pull requests\n\n` +
    `I remember our conversation across restarts!\n\n` +
    `Try: _"Create a PR from feature-x to main"_`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/clear/, (msg) => {
  chatHistories[msg.chat.id] = [];
  saveMemory(chatHistories);
  bot.sendMessage(msg.chat.id, "🧹 Memory cleared! Fresh start.");
});

bot.onText(/\/memory/, (msg) => {
  const chatId = msg.chat.id;
  const history = chatHistories[chatId];
  if (!history || history.length === 0) {
    bot.sendMessage(chatId, "🧠 No memory yet — start chatting!");
    return;
  }
  const count = Math.floor(history.length / 2);
  const last = history[history.length - 2]?.parts[0]?.text || "nothing";
  bot.sendMessage(chatId,
    `🧠 *Memory Status*\n\n` +
    `💬 Exchanges remembered: *${count}*\n` +
    `🕐 Last question: _"${last.slice(0, 60)}..."_\n\n` +
    `Use /clear to wipe memory.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*Commands:*\n` +
    `/start — Welcome message\n` +
    `/clear — Clear chat memory\n` +
    `/memory — Show memory status\n` +
    `/help — Show this message\n\n` +
    `*Just type any question!*`,
    { parse_mode: "Markdown" }
  );
});

// ── MESSAGE HANDLER ────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) {
    bot.sendMessage(msg.chat.id, "Please send a text message!");
    return;
  }

  // Input length guard
  if (msg.text.length > 500) {
    bot.sendMessage(msg.chat.id, "⚠️ Message too long! Please keep it under 500 characters.");
    return;
  }

  const chatId = msg.chat.id;
 await queueMessage(chatId, msg.text);
});

// ── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  saveMemory(chatHistories);
  console.log('💾 Memory saved!');
  console.log('👋 Bot stopped. Goodbye!');
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveMemory(chatHistories);
  process.exit(0);
});

// Catch any unhandled errors so bot never crashes silently
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled error:', err.message);
});
// ── START ──────────────────────────────────────────────────────────────────
console.log("🤖 Bot is running! Open Telegram and message your bot.");
console.log("📌 Press Ctrl+C to stop.\n");
 