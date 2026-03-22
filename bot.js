 require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ── SETUP ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── MEMORY: stores chat history per user ───────────────────────────────────
// Key = Telegram chat ID, Value = array of messages
  const fs = require('fs');
const MEMORY_FILE = './memory.json';

// ── PERSISTENT MEMORY FUNCTIONS ───────────────────────────────────────────

// Load memory from file when bot starts
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

// Save memory to file after every message
function saveMemory(histories) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(histories, null, 2));
  } catch (err) {
    console.error('⚠️ Could not save memory:', err.message);
  }
}

// Load on startup
const chatHistories = loadMemory();

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
  description: `Manage GitHub Pull Requests for the repo. Use this when the user wants to:
  - create a pull request (needs: title, head branch, base branch, optional body)
  - list open pull requests
  - review/summarize a pull request (needs: PR number)
  Always use this tool for any GitHub or PR related requests.`,
  parameters: {
    type: "OBJECT",
    properties: {
      action: {
        type: "STRING",
        description: "One of: 'create', 'list', 'review'"
      },
      title: {
        type: "STRING",
        description: "PR title (required for create)"
      },
      head: {
        type: "STRING",
        description: "Source branch name (required for create)"
      },
      base: {
        type: "STRING",
        description: "Target branch, usually 'main' (required for create)"
      },
      body: {
        type: "STRING",
        description: "PR description (optional for create)"
      },
      pr_number: {
        type: "NUMBER",
        description: "PR number (required for review)"
      }
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
  try {
    const result = Function('"use strict"; return (' + expression + ')')();
    return { result: result.toString() };
  } catch (err) {
    return { result: `Calculation error: ${err.message}` };
  }
}
  async function github_pr({ action, title, head, base, body, pr_number }) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const OWNER = process.env.GITHUB_USERNAME;
  const REPO = process.env.GITHUB_REPO;
  const BASE_URL = `https://api.github.com/repos/${OWNER}/${REPO}`;

  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  console.log(`\n🐙 [Tool Called] github_pr → action: "${action}"`);

  try {

    // ── CREATE PR ────────────────────────────────────────────────
    if (action === 'create') {
      if (!title || !head || !base) {
        return { result: "Missing required fields: title, head branch, and base branch are all needed to create a PR." };
      }

      const res = await axios.post(`${BASE_URL}/pulls`, {
        title,
        head,
        base,
        body: body || `PR created by Gossaye's AI Agent 🤖`
      }, { headers });

      return {
        result: `✅ PR created successfully!\n\n` +
                `📌 Title: ${res.data.title}\n` +
                `🔀 Branch: ${head} → ${base}\n` +
                `🔗 Link: ${res.data.html_url}\n` +
                `#️⃣ PR Number: #${res.data.number}`
      };
    }

    // ── LIST PRs ─────────────────────────────────────────────────
    if (action === 'list') {
      const res = await axios.get(`${BASE_URL}/pulls?state=open`, { headers });

      if (res.data.length === 0) {
        return { result: "📭 No open pull requests found in this repo." };
      }

      const prList = res.data.map(pr =>
        `#${pr.number} — ${pr.title}\n` +
        `   🔀 ${pr.head.ref} → ${pr.base.ref}\n` +
        `   👤 by ${pr.user.login}\n` +
        `   🔗 ${pr.html_url}`
      ).join('\n\n');

      return { result: `📋 Open Pull Requests (${res.data.length}):\n\n${prList}` };
    }

    // ── REVIEW PR ────────────────────────────────────────────────
    if (action === 'review') {
      if (!pr_number) {
        return { result: "Please provide a PR number to review." };
      }

      // Get PR details
      const prRes = await axios.get(`${BASE_URL}/pulls/${pr_number}`, { headers });
      const pr = prRes.data;

      // Get PR files changed
      const filesRes = await axios.get(`${BASE_URL}/pulls/${pr_number}/files`, { headers });
      const files = filesRes.data;

      const fileList = files.map(f =>
        `• ${f.filename} (+${f.additions} -${f.deletions})`
      ).join('\n');

      return {
        result: `🔍 PR Review Summary — #${pr_number}\n\n` +
                `📌 Title: ${pr.title}\n` +
                `👤 Author: ${pr.user.login}\n` +
                `🔀 Branch: ${pr.head.ref} → ${pr.base.ref}\n` +
                `📊 Changes: +${pr.additions} lines, -${pr.deletions} lines\n` +
                `📁 Files changed (${files.length}):\n${fileList}\n\n` +
                `📝 Description: ${pr.body || 'No description provided'}\n` +
                `🔗 Link: ${pr.html_url}`
      };
    }

    return { result: `Unknown action: ${action}. Use 'create', 'list', or 'review'.` };

  } catch (err) {
    // Handle common GitHub API errors clearly
    if (err.response?.status === 401) {
      return { result: "❌ GitHub token is invalid or expired. Please update GITHUB_TOKEN in .env" };
    }
    if (err.response?.status === 404) {
      return { result: "❌ Repo or branch not found. Check your branch names." };
    }
    if (err.response?.status === 422) {
      return { result: `❌ Could not create PR: ${err.response.data.message}. The branch may not exist or a PR already exists for it.` };
    }
    return { result: `❌ GitHub API error: ${err.message}` };
  }
}  

const toolHandlers = { search_web, calculate, github_pr };

// ── AGENT: runs one user message through Gemini + tools ───────────────────
async function runAgent(chatId, userMessage) {
  // Get or create history for this chat
  if (!chatHistories[chatId]) {
    chatHistories[chatId] = [];
  }
  const history = chatHistories[chatId];

  console.log(`\n💬 [Chat ${chatId}] User: ${userMessage}`);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: tools,
   systemInstruction: `You are a helpful AI assistant with three tools:
1. search_web — for facts, people, news, general knowledge
2. calculate — for any math or number problems  
3. github_pr — for GitHub Pull Request actions (create, list, review)

BEHAVIOR RULES:
- Always use a tool when needed. Never guess — use the right tool.
- For GitHub/PR requests always use github_pr tool.
- For math always use calculate tool.
- For facts always use search_web tool.
- When creating a PR and user doesn't specify base branch, assume 'main'.
- Be concise and friendly. Add emojis to make responses readable.
- For tax/financial estimates: use best available data, state assumptions, then calculate.`
  });

  // Start chat WITH history so it remembers previous messages
  const chat = model.startChat({ history });

  // Send user message
  let response = await chat.sendMessage(userMessage);
  let candidate = response.response.candidates[0];
  let content = candidate.content;

  // Agent loop — keep calling tools until Gemini is done
  while (content.parts.some(p => p.functionCall)) {
    const toolCallPart = content.parts.find(p => p.functionCall);
    const { name, args } = toolCallPart.functionCall;

    console.log(`🤖 Gemini chose: "${name}" with ${JSON.stringify(args)}`);

    const toolResult = await toolHandlers[name](args);

    response = await chat.sendMessage([{
      functionResponse: { name, response: toolResult }
    }]);

    candidate = response.response.candidates[0];
    content = candidate.content;
  }

  const finalAnswer = response.response.text();

 // Only save clean text responses (no thoughtSignature bloat)
history.push({ role: "user", parts: [{ text: userMessage }] });
history.push({ role: "model", parts: [{ text: finalAnswer }] });

// Deduplicate — remove consecutive duplicate messages
const seen = new Set();
chatHistories[chatId] = history.filter(msg => {
  const key = msg.role + msg.parts[0]?.text;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Keep last 20 messages
if (chatHistories[chatId].length > 20) {
  chatHistories[chatId] = chatHistories[chatId].slice(-20);
}

saveMemory(chatHistories);
  console.log(`✅ Answer: ${finalAnswer}`);
  return finalAnswer;
}

// ── TELEGRAM EVENT HANDLERS ────────────────────────────────────────────────

// /start command
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "there";
  bot.sendMessage(msg.chat.id,
    `👋 Hey ${name}! I'm your AI Agent.\n\n` +
    `I have two tools:\n` +
    `🧮 *Calculator* — ask me any math\n` +
    `🔍 *Web Search* — ask me anything factual\n\n` +
    `I also remember our conversation, so you can ask follow-up questions!\n\n` +
    `Try asking: _"What is 20% of $350?"_`,
    { parse_mode: "Markdown" }
  );
});

// /clear command — wipe memory for fresh start
bot.onText(/\/clear/, (msg) => {
  chatHistories[msg.chat.id] = [];
  saveMemory(chatHistories);  // 💾 persist the clear
  bot.sendMessage(msg.chat.id, "🧹 Memory cleared! Fresh start.");
});
// /help command
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

// Handle all regular messages
bot.on('message', async (msg) => {
  // Ignore commands (they're handled above)
  if (msg.text?.startsWith('/')) return;
  // Ignore non-text messages
  if (!msg.text) {
    bot.sendMessage(msg.chat.id, "Please send a text message!");
    return;
  }

  const chatId = msg.chat.id;

  // Show typing indicator while processing
  bot.sendChatAction(chatId, 'typing');

  try {
    const answer = await runAgent(chatId, msg.text);
    bot.sendMessage(chatId, answer);
  } catch (err) {
    console.error("Error:", err.message);

    // Handle rate limit gracefully
    if (err.status === 429) {
      bot.sendMessage(chatId, "⏳ I'm thinking too fast! Give me 15 seconds and try again.");
    } else {
      bot.sendMessage(chatId, "❌ Something went wrong. Try again in a moment.");
    }
  }
});

// ── START ──────────────────────────────────────────────────────────────────
console.log("🤖 Bot is running! Open Telegram and message your bot.");
console.log("📌 Press Ctrl+C to stop.\n");
