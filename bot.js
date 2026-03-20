 require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ── SETUP ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── MEMORY: stores chat history per user ───────────────────────────────────
// Key = Telegram chat ID, Value = array of messages
const chatHistories = {};

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

const toolHandlers = { search_web, calculate };

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
    systemInstruction: `You are a helpful AI assistant with two tools:
    1. search_web — for facts, people, news, general knowledge
    2. calculate — for any math or number problems
    Always use a tool when needed. Be concise and friendly in your replies.`
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

  // ── Save this exchange to memory ──
  history.push({ role: "user", parts: [{ text: userMessage }] });
  history.push({ role: "model", parts: [{ text: finalAnswer }] });

  // Keep history to last 20 messages (10 exchanges) to avoid token bloat
  if (history.length > 20) {
    chatHistories[chatId] = history.slice(-20);
  }

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
  bot.sendMessage(msg.chat.id, "🧹 Memory cleared! Fresh start.");
});

// /help command
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*Commands:*\n` +
    `/start — Welcome message\n` +
    `/clear — Clear chat memory\n` +
    `/help — Show this message\n\n` +
    `*Just type any question and I'll answer it!*`,
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
