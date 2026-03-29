  require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ── VALIDATE ENV VARS ──────────────────────────────────────────────────────
const REQUIRED_ENV = ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'GITHUB_USERNAME', 'GITHUB_REPO'];
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
});

const app = express();
const PORT = process.env.PORT || 3001;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:3000',           // React dev
    'https://gossaye-ai-agent.netlify.app'  // React production
  ]
}));
app.use(express.json());

// ── MEMORY ─────────────────────────────────────────────────────────────────
const MEMORY_FILE = './memory.json';
const PROFILE_FILE = './userProfile.json';

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Memory load error:', err.message);
  }
  return {};
}

function saveMemory(data) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Memory save error:', err.message);
  }
}

function loadProfile() {
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Profile load error:', err.message);
  }
  return {};
}

function saveProfile(profile) {
  try {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
  } catch (err) {
    console.error('Profile save error:', err.message);
  }
}

const chatHistories = loadMemory();

// ── TOOL DEFINITIONS ───────────────────────────────────────────────────────
const tools = [{
  functionDeclarations: [
    {
      name: "search_web",
      description: "Search the web for real-world facts, current events, people, places.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "The search query" }
        },
        required: ["query"]
      }
    },
    {
      name: "calculate",
      description: "Evaluate a math expression. Use for any arithmetic or numeric calculations.",
      parameters: {
        type: "OBJECT",
        properties: {
          expression: { type: "STRING", description: "Math expression e.g. '250 * 0.18'" }
        },
        required: ["expression"]
      }
    },
    {
      name: "github_pr",
      description: "Manage GitHub Pull Requests. Create, list or review PRs.",
      parameters: {
        type: "OBJECT",
        properties: {
          action: { type: "STRING", description: "One of: create, list, review" },
          title: { type: "STRING", description: "PR title (for create)" },
          head: { type: "STRING", description: "Source branch (for create)" },
          base: { type: "STRING", description: "Target branch (for create)" },
          body: { type: "STRING", description: "PR description (optional)" },
          pr_number: { type: "NUMBER", description: "PR number (for review)" }
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
      `No direct answer found. Please answer "${query}" using your own knowledge.`;
    return { result: answer };
  } catch (err) {
    return { result: `Search failed. Please answer "${query}" using your own knowledge.` };
  }
}

function calculate({ expression }) {
  console.log(`🧮 calculate → "${expression}"`);
  const banned = ['process', 'require', 'import', 'eval', 'Function', '__dirname'];
  if (banned.some(word => expression.includes(word))) {
    return { result: 'Invalid expression: contains unsafe code.' };
  }
  try {
    const result = Function('"use strict"; return (' + expression + ')')();
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
      const res = await axios.post(`${BASE_URL}/pulls`, {
        title, head, base,
        body: body || `PR created by Gossaye's AI Agent 🤖`
      }, { headers });
      return {
        result: `✅ PR created!\n📌 ${res.data.title}\n🔗 ${res.data.html_url}\n#️⃣ PR #${res.data.number}`
      };
    }
    if (action === 'list') {
      const res = await axios.get(`${BASE_URL}/pulls?state=open`, { headers });
      if (!res.data.length) return { result: "📭 No open PRs found." };
      return {
        result: res.data.map(pr =>
          `#${pr.number} — ${pr.title}\n🔗 ${pr.html_url}`
        ).join('\n\n')
      };
    }
    if (action === 'review') {
      if (!pr_number) return { result: "Please provide a PR number." };
      const prRes = await axios.get(`${BASE_URL}/pulls/${pr_number}`, { headers });
      const filesRes = await axios.get(`${BASE_URL}/pulls/${pr_number}/files`, { headers });
      if (!prRes.data.number) return { result: `❌ PR #${pr_number} not found.` };
      const files = filesRes.data.map(f => `• ${f.filename} (+${f.additions} -${f.deletions})`).join('\n');
      return {
        result: `🔍 PR #${pr_number}: ${prRes.data.title}\n👤 ${prRes.data.user.login}\n🔀 ${prRes.data.head.ref} → ${prRes.data.base.ref}\n📁 Files:\n${files}\n🔗 ${prRes.data.html_url}`
      };
    }
    return { result: `Unknown action: ${action}` };
  } catch (err) {
    return { result: `❌ GitHub error: ${err.message}` };
  }
}

const toolHandlers = { search_web, calculate, github_pr };

// ── AGENT RUNNER ───────────────────────────────────────────────────────────
async function runAgent(sessionId, userMessage) {
  if (!chatHistories[sessionId]) chatHistories[sessionId] = [];
  const history = chatHistories[sessionId];

  // Load user profile for RAG context
  const profile = loadProfile();
  const profileContext = Object.keys(profile).length
    ? `\n\nKNOWN USER FACTS:\n${Object.entries(profile)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n')}`
    : '';

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools,
    systemInstruction: `You are a helpful AI assistant with three tools:
1. search_web — facts, news, general knowledge
2. calculate — any math or number problems
3. github_pr — GitHub Pull Request actions (create, list, review)
Always use the right tool. Be concise and friendly.${profileContext}`
  });

  // Clean history — only user and model text roles
  const cleanHistory = history.filter(msg =>
    (msg.role === 'user' || msg.role === 'model') && msg.parts[0]?.text
  );

  const chat = model.startChat({ history: cleanHistory });
  let response = await chat.sendMessage(userMessage);
  let candidate = response.response.candidates[0];
  let content = candidate.content;

  while (content.parts.some(p => p.functionCall)) {
    const toolCallPart = content.parts.find(p => p.functionCall);
    const { name, args } = toolCallPart.functionCall;
    console.log(`🤖 Tool: "${name}" args: ${JSON.stringify(args)}`);
    const toolResult = await toolHandlers[name](args);
    response = await chat.sendMessage([{ functionResponse: { name, response: toolResult } }]);
    candidate = response.response.candidates[0];
    content = candidate.content;
  }

  const finalAnswer = response.response.text();

  // Save to memory
  history.push({ role: "user", parts: [{ text: userMessage }] });
  history.push({ role: "model", parts: [{ text: finalAnswer }] });

  if (history.length > 20) chatHistories[sessionId] = history.slice(-20);
  saveMemory(chatHistories);

  return finalAnswer;
}

// ── API ROUTES ─────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Gossaye AI Agent API is running!' });
});

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  const { message, sessionId = 'react-ui' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  console.log(`\n💬 [${sessionId}] User: ${message}`);

  try {
    const answer = await runAgent(sessionId, message);
    console.log(`✅ Answer: ${answer.slice(0, 100)}...`);
    res.json({ answer });
  } catch (err) {
    console.error('Agent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get user profile
app.get('/api/profile', (req, res) => {
  res.json(loadProfile());
});

// Update user profile
app.post('/api/profile', (req, res) => {
  const profile = req.body;
  saveProfile(profile);
  res.json({ success: true, profile });
});

// Clear chat history
app.delete('/api/chat/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  delete chatHistories[sessionId];
  saveMemory(chatHistories);
  res.json({ success: true });
});

// ── START SERVER ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Gossaye AI Agent API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`💬 Chat endpoint: http://localhost:${PORT}/api/chat\n`);
});
