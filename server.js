 require('dotenv').config();
const { Langfuse } = require('langfuse');

const langfuse = new Langfuse({
  secretKey:  process.env.LANGFUSE_SECRET_KEY,
  publicKey:  process.env.LANGFUSE_PUBLIC_KEY,
  baseUrl:    'https://us.cloud.langfuse.com',
});

console.log('📊 Langfuse monitoring enabled');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const express = require('express');
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
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json({ limit: '10kb' }));

// ── SECURITY: INPUT VALIDATION ─────────────────────────────────────────────
const INJECTION_PATTERNS = [
  /ignore (all |previous |above )?(instructions|prompts|rules)/i,
  /you are now/i,
  /forget (everything|all|your instructions)/i,
  /act as (a |an )?(different|new|another)/i,
  /pretend (you are|to be)/i,
  /jailbreak/i,
  /dan mode/i,
  /developer mode/i,
  /bypass (your |all )?(restrictions|rules|guidelines)/i,
  /system prompt/i,
  /reveal (your |the )?(prompt|instructions|system)/i,
];

function detectInjection(text) {
  if (!text || typeof text !== 'string') return false;
  return INJECTION_PATTERNS.some(pattern => pattern.test(text));
}

function validateInput(text, maxLength = 500) {
  if (!text || typeof text !== 'string') {
    return { valid: false, reason: 'Input must be a non-empty string' };
  }
  if (text.trim().length === 0) {
    return { valid: false, reason: 'Input cannot be empty' };
  }
  if (text.length > maxLength) {
    return { valid: false, reason: `Input too long (max ${maxLength} characters)` };
  }
  if (detectInjection(text)) {
    return { valid: false, reason: 'Invalid input detected' };
  }
  return { valid: true };
}

function sanitizeOutput(text) {
  if (!text || typeof text !== 'string') return '';
  // Remove any system-level information leakage
  return text
    .replace(/sk-[a-zA-Z0-9-]+/g, '[REDACTED]')
    .replace(/pk-[a-zA-Z0-9-]+/g, '[REDACTED]')
    .replace(/AIza[a-zA-Z0-9-_]+/g, '[REDACTED]')
    .trim();
}

// ── SECURITY: RATE LIMITING ────────────────────────────────────────────────
const requestCounts = new Map();

function rateLimit(ip, maxRequests = 20, windowMs = 60000) {
  const now = Date.now();
  const userRequests = requestCounts.get(ip) || [];
  
  // Remove old requests outside window
  const recentRequests = userRequests.filter(time => now - time < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return false; // Rate limited
  }
  
  recentRequests.push(now);
  requestCounts.set(ip, recentRequests);
  return true; // Allowed
}


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
  // ── LANGFUSE TRACE ─────────────────────────────────────
  const trace = langfuse.trace({
    name: 'agent-chat',
    userId: sessionId,
    input: { message: userMessage },
    metadata: { sessionId }
  });
  // ──────────────────────────────────────────────────────

  if (!chatHistories[sessionId]) chatHistories[sessionId] = [];
  const history = chatHistories[sessionId];

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

  const cleanHistory = history.filter(msg =>
    (msg.role === 'user' || msg.role === 'model') && msg.parts[0]?.text
  );

  const chat = model.startChat({ history: cleanHistory });

  // ── TRACE: LLM GENERATION ─────────────────────────────
  const generation = trace.generation({
    name: 'gemini-chat',
    model: 'gemini-2.5-flash',
    input: userMessage,
  });
  // ──────────────────────────────────────────────────────

  let response = await chat.sendMessage(userMessage);
  let candidate = response.response.candidates[0];
  let content = candidate.content;

  while (content.parts.some(p => p.functionCall)) {
    const toolCallPart = content.parts.find(p => p.functionCall);
    const { name, args } = toolCallPart.functionCall;

    // ── TRACE: TOOL CALL ────────────────────────────────
    const toolSpan = trace.span({
      name: `tool-${name}`,
      input: args,
    });
    // ────────────────────────────────────────────────────

    console.log(`🤖 Tool: "${name}" args: ${JSON.stringify(args)}`);
    const toolResult = await toolHandlers[name](args);

    // ── END TOOL SPAN ───────────────────────────────────
    toolSpan.end({ output: toolResult });
    // ────────────────────────────────────────────────────

    response = await chat.sendMessage([{ functionResponse: { name, response: toolResult } }]);
    candidate = response.response.candidates[0];
    content = candidate.content;
  }

  const finalAnswer = response.response.text();
  const usage = response.response.usageMetadata;

  // ── END GENERATION + TRACE ─────────────────────────────
  generation.end({
    output: finalAnswer,
    usage: {
      input:  usage?.promptTokenCount     || 0,
      output: usage?.candidatesTokenCount || 0,
    }
  });

  trace.update({
    output: { answer: finalAnswer },
    metadata: {
      inputTokens:  usage?.promptTokenCount     || 0,
      outputTokens: usage?.candidatesTokenCount || 0,
    }
  });
  // ──────────────────────────────────────────────────────

  history.push({ role: "user",  parts: [{ text: userMessage }] });
  history.push({ role: "model", parts: [{ text: finalAnswer }] });

  if (history.length > 20) chatHistories[sessionId] = history.slice(-20);
  saveMemory(chatHistories);
   return sanitizeOutput(finalAnswer);
}

// ── API ROUTES ─────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Gossaye AI Agent API is running!' });
});
 
// ── MAIN CHAT ENDPOINT ────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId = 'react-ui' } = req.body;

  // Rate limiting
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: '⏳ Too many requests. Please wait a minute.' });
  }

  // Input validation
  const validation = validateInput(message, 1000);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
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


// ── STREAMING CHAT ENDPOINT ───────────────────────────────────────────────
app.post('/api/chat/stream', async (req, res) => {
  const { message, sessionId = 'react-ui' } = req.body;
  
  // Rate limiting
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: '⏳ Too many requests. Please wait a minute.' });
  }

  // Input validation
  const validation = validateInput(message, 1000);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
  }

  console.log(`\n💬 [STREAM] [${sessionId}] User: ${message}`);

  // Set headers for Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  try {
    if (!chatHistories[sessionId]) chatHistories[sessionId] = [];
    const history = chatHistories[sessionId];

    // Load profile for RAG
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

    const cleanHistory = history.filter(msg =>
      (msg.role === 'user' || msg.role === 'model') && msg.parts[0]?.text
    );

    const chat = model.startChat({ history: cleanHistory });

    // Track token usage
    let inputTokens = 0;
    let outputTokens = 0;
    let fullAnswer = '';

    // Handle tool calls first (non-streaming)
    let response = await chat.sendMessage(message);
    let candidate = response.response.candidates[0];
    let content = candidate.content;

    // Tool loop
    while (content.parts.some(p => p.functionCall)) {
      const toolCallPart = content.parts.find(p => p.functionCall);
      const { name, args } = toolCallPart.functionCall;

      // Send tool status to client
      res.write(`data: ${JSON.stringify({ type: 'tool', tool: name })}\n\n`);
      console.log(`🤖 Tool: "${name}"`);
      const toolResult = await toolHandlers[name](args);

      response = await chat.sendMessage([{ functionResponse: { name, response: toolResult } }]);
      candidate = response.response.candidates[0];
      content = candidate.content;
    }

    // Stream the final answer directly — no second Gemini call
const finalText = response.response.text();
fullAnswer = finalText;

// Simulate streaming by sending words one by one
const words = finalText.split(' ');
for (const word of words) {
  res.write(`data: ${JSON.stringify({ type: 'chunk', text: word + ' ' })}\n\n`);
  await new Promise(r => setTimeout(r, 30)); // 30ms between words
}

    // Get usage metadata
    const usage = response.response.usageMetadata;
    inputTokens = usage?.promptTokenCount || 0;
    outputTokens = usage?.candidatesTokenCount || 0;

    // Calculate cost (Gemini 2.5 Flash pricing)
    const inputCost  = (inputTokens  / 1000000) * 0.075;
    const outputCost = (outputTokens / 1000000) * 0.30;
    const totalCost  = inputCost + outputCost;

    console.log(`📊 Tokens: ${inputTokens} in / ${outputTokens} out | Cost: $${totalCost.toFixed(6)}`);

    // Send completion signal with cost data
    res.write(`data: ${JSON.stringify({
      type: 'done',
      fullAnswer,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCost: `$${totalCost.toFixed(6)}`
      }
    })}\n\n`);

    // Save to memory
    history.push({ role: "user", parts: [{ text: message }] });
    history.push({ role: "model", parts: [{ text: fullAnswer }] });
    if (history.length > 20) chatHistories[sessionId] = history.slice(-20);
    saveMemory(chatHistories);

    res.end();

  } catch (err) {
    console.error('Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
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
// ── LEAD RESEARCH ENDPOINT ─────────────────────────────────────────────────
app.post('/api/leads/research', async (req, res) => {
  const { company } = req.body;

  // Rate limiting
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(ip, 10, 60000)) { // 10 lead researches per minute
    return res.status(429).json({ error: '⏳ Too many requests. Please wait a minute.' });
  }

  // Input validation
  const validation = validateInput(company, 100);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
  }
  console.log(`\n💼 Lead Research: "${company}"`);

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    async function searchWeb(query) {
      try {
        const r = await axios.get('https://api.duckduckgo.com/', {
          params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 }
        });
        return r.data.AbstractText || r.data.Answer ||
               r.data.RelatedTopics?.[0]?.Text || `No result for: ${query}`;
      } catch { return `Search failed for: ${query}`; }
    }

    async function ask(prompt) {
  for (let i = 0; i < 3; i++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      if (i < 2) {
        console.log(`⏳ Retrying in 10s... (${i+1}/3)`);
        await new Promise(r => setTimeout(r, 10000));
      } else throw err;
    }
  }
}

    const [overview, news, tech, funding] = await Promise.all([
      searchWeb(`${company} company SaaS startup overview`),
      searchWeb(`${company} latest news 2025`),
      searchWeb(`${company} tech stack technology`),
      searchWeb(`${company} funding valuation investors`)
    ]);

   const summary = await ask(`Summarize ${company} for a B2B sales rep in 3 short paragraphs: what they do, recent news, tech stack. Data: ${overview.slice(0,300)} ${news.slice(0,200)} ${tech.slice(0,150)} ${funding.slice(0,150)}`);
   const score = await ask(`Score ${company} as B2B lead. Reply EXACTLY:
SCORE: [1-10]
TIER: [HOT/WARM/COLD]
BUDGET_ESTIMATE: [range]
COMPANY_SIZE: [range]
PAIN_POINTS:
- [point 1]
- [point 2]
- [point 3]
OPPORTUNITY: [one sentence]
TIMING: [IMMEDIATE/3-6 MONTHS/6-12 MONTHS]
Data: ${summary.slice(0,400)}`);

  const email = await ask(`Write a cold outreach email to ${company}. 3 short paragraphs, soft CTA for 15min call. No generic openers. Format: SUBJECT: [line]\n\n[body]. Data: ${summary.slice(0,300)} ${score.slice(0,200)}`);
     const report = {
      company,
      timestamp: new Date().toISOString(),
      research: summary,
      news, tech, funding, score, email
    };
     // ── LANGFUSE: TRACE LEAD RESEARCH ─────────────────────
const leadTrace = langfuse.trace({
  name: 'lead-research',
  input: { company },
  output: { score: score.slice(0, 200), email: email.slice(0, 200) },
  metadata: { company, tier: score.match(/TIER:\s*(\w+)/)?.[1] || 'N/A' }
});
leadTrace.generation({
  name: 'lead-pipeline',
  model: 'gemini-2.5-flash',
  input: company,
  output: summary.slice(0, 500),
  usage: {
    input:  Math.round((company.length + summary.length) / 4),
    output: Math.round((summary.length + score.length + email.length) / 4),
  }
});
// ──────────────────────────────────────────────────────
    console.log(`✅ Lead research complete: ${company}`);

    // ── AUTO-LOG TO GOOGLE SHEETS ─────────────────────────
    try {
      const scoreMatch  = score.match(/SCORE:\s*(\d+)/);
      const tierMatch   = score.match(/TIER:\s*(\w+)/);
      const budgetMatch = score.match(/BUDGET_ESTIMATE:\s*(.+)/);
      const oppMatch    = score.match(/OPPORTUNITY:\s*(.+)/);
      const subjMatch   = email.match(/SUBJECT:\s*(.+)/);

      const auth = new google.auth.GoogleAuth({
        keyFile: './google-credentials.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth });

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Sheet1!A:H',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            new Date().toLocaleString(),
            company,
            scoreMatch  ? scoreMatch[1]         : 'N/A',
            tierMatch   ? tierMatch[1]           : 'N/A',
            budgetMatch ? budgetMatch[1].trim()  : 'N/A',
            oppMatch    ? oppMatch[1].trim()     : 'N/A',
            subjMatch   ? subjMatch[1].trim()    : 'N/A',
            summary.slice(0, 500),
          ]],
        },
      });
      console.log(`📊 Auto-logged to Sheets: ${company}`);
    } catch (sheetErr) {
      console.error('Auto-sheet log error:', sheetErr.message);
    }
    // ─────────────────────────────────────────────────────

    res.json({ success: true, report });

  } catch (err) {
    console.error('Lead research error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ── SMS NOTIFICATION ───────────────────────────────────────────────────────
app.post('/api/notify/sms', async (req, res) => {
  const { name, phone, email, service, message } = req.body;

  console.log(`\n📱 SMS notification for: ${name}`);

  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const smsBody = 
      `🔔 New Booking!\n` +
      `👤 ${name}\n` +
      `📞 ${phone}\n` +
      `✉️ ${email}\n` +
      `📋 ${service}\n` +
      `💬 ${message || 'No message'}`;

    await client.messages.create({
      body: smsBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.MY_PHONE_NUMBER
    });

    console.log('✅ SMS sent!');
    res.json({ success: true });
  } catch (err) {
    console.error('SMS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ── GOOGLE SHEETS LOGGER ──────────────────────────────────────────────────
app.post('/api/leads/log-sheet', async (req, res) => {
  const { company, score, tier, budgetEstimate, opportunity, emailSubject, research } = req.body;

  console.log(`\n📊 Logging lead to Google Sheets: ${company}`);

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: './google-credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          new Date().toLocaleString(),
          company,
          score,
          tier,
          budgetEstimate || '',
          opportunity || '',
          emailSubject || '',
          research ? research.slice(0, 500) : '',
        ]],
      },
    });

    console.log(`✅ Lead logged to Sheets: ${company}`);
    res.json({ success: true, message: `${company} logged to Google Sheets` });

  } catch (err) {
    console.error('Sheets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EMAIL SENDER ──────────────────────────────────────────────────────────
app.post('/api/leads/send-email', async (req, res) => {
  const { to, subject, body, company } = req.body;

  console.log(`\n📧 Sending email to ${to} for ${company}`);

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `Gossaye Bireda <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text: body,
    });

    console.log(`✅ Email sent to ${to}`);
    res.json({ success: true, message: `Email sent to ${to}` });

  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Flush Langfuse traces every 10 seconds
setInterval(() => {
  langfuse.flushAsync().catch(() => {});
}, 10000);
// ── START SERVER ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Gossaye AI Agent API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`💬 Chat endpoint: http://localhost:${PORT}/api/chat\n`);
});
