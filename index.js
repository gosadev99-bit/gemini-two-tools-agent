require('dotenv').config();

async function listModels() {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
  );
  const data = await res.json();
  
  console.log("\n✅ Models available to your API key:\n");
  data.models.forEach(m => {
    // Only show models that support generateContent (what we need)
    if (m.supportedGenerationMethods?.includes("generateContent")) {
      console.log(`  ✔ ${m.name.replace("models/", "")}`);
    }
  });
}

listModels().catch(console.error);
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ── TOOL DEFINITIONS (what Gemini can "see") ──────────────────────────────
const tools = [
  {
    functionDeclarations: [

      {
        name: "search_web",
        description: "Search the web for real-world facts, current events, people, places, or anything that needs a live lookup.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "The search query to look up"
            }
          },
          required: ["query"]
        }
      },

      {
        name: "calculate",
        description: "Evaluate a math expression. Use this for any arithmetic, percentages, or numeric calculations.",
        parameters: {
          type: "OBJECT",
          properties: {
            expression: {
              type: "STRING",
              description: "A valid math expression e.g. '250 * 0.18' or '(100 + 50) / 3'"
            }
          },
          required: ["expression"]
        }
      }

    ]
  }
];
// ── ACTUAL TOOL LOGIC (runs on YOUR machine) ──────────────────────────────

async function search_web({ query }) {
  console.log(`\n🔍 [Tool Called] search_web → "${query}"`);
  try {
    // Using DuckDuckGo instant answer API (free, no key needed)
    const res = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 }
    });
    const data = res.data;
    const answer =
      data.AbstractText ||
      data.Answer ||
      (data.RelatedTopics?.[0]?.Text) ||
      `No direct answer found for: "${query}"`;
    console.log(`   Result: ${answer.slice(0, 100)}...`);
    return { result: answer };
  } catch (err) {
    return { result: `Search failed: ${err.message}` };
  }
}

function calculate({ expression }) {
  console.log(`\n🧮 [Tool Called] calculate → "${expression}"`);
  try {
    // Safe eval using Function (avoids global scope)
    const result = Function('"use strict"; return (' + expression + ')')();
    console.log(`   Result: ${result}`);
    return { result: result.toString() };
  } catch (err) {
    return { result: `Calculation error: ${err.message}` };
  }
}

// Router — maps tool name → function
const toolHandlers = {
  search_web,
  calculate
};
// ── THE AGENT ─────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function runAgent(userQuestion) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`👤 User: ${userQuestion}`);
  console.log('='.repeat(60));

  const model = genAI.getGenerativeModel({
   model: "gemini-2.5-flash-lite",
    tools: tools,
  });

  const chat = model.startChat();

  // ── TURN 1: Send user question → Gemini decides which tool to use
  let response = await chat.sendMessage(userQuestion);
  let candidate = response.response.candidates[0];
  let content = candidate.content;

  // ── AGENT LOOP: keep going while Gemini wants to call tools
  while (content.parts.some(p => p.functionCall)) {

    const toolCallPart = content.parts.find(p => p.functionCall);
    const { name, args } = toolCallPart.functionCall;

    console.log(`\n🤖 Gemini chose tool: "${name}"`);
    console.log(`   With args: ${JSON.stringify(args)}`);

    // ── Execute the tool locally
    const handler = toolHandlers[name];
    const toolResult = await handler(args);

    // ── Send tool result back to Gemini
    response = await chat.sendMessage([
      {
        functionResponse: {
          name: name,
          response: toolResult
        }
      }
    ]);

    candidate = response.response.candidates[0];
    content = candidate.content;
  }

  // ── Final text response from Gemini
  const finalAnswer = response.response.text();
  console.log(`\n✅ Agent Answer: ${finalAnswer}`);
  return finalAnswer;
}
// ── RUN TESTS ─────────────────────────────────────────────────────────────

// helper — pauses execution for N seconds
function wait(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

async function main() {
  await runAgent("What is 15% tip on a $84 restaurant bill?");
  
  console.log("\n⏳ Waiting 15 seconds (free tier rate limit)...\n");
  await wait(15);
  
  await runAgent("Who is the CEO of Anthropic?");
  
  console.log("\n⏳ Waiting 15 seconds...\n");
  await wait(15);
  
  await runAgent("If I save $450 per month for 3 years, how much will I have?");
  
  console.log("\n⏳ Waiting 15 seconds...\n");
  await wait(15);
  
  await runAgent("What is React.js used for?");
}

main().catch(console.error);