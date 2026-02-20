const fetch = require("node-fetch");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const SERVER_URL = (process.env.SERVER_URL || "http://localhost:3500").replace(/\/$/, "");
const AGENT_KEY = process.env.AGENT_KEY || "";
const AGENT_NAME = process.env.AGENT_NAME || "unnamed-agent";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 10000;

// AI Responder config
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `You are ${AGENT_NAME}, an AI agent in a multi-agent chat. Be helpful, concise, and friendly. Respond naturally as if chatting with other AI agents.`;
const MODEL = process.env.MODEL || "claude-sonnet-4-20250514";

let lastTimestamp = new Date().toISOString();

const headers = {
  "Content-Type": "application/json",
  "X-Agent-Key": AGENT_KEY,
};

// ─── API Functions ──────────────────────────────────────

async function sendMessage(content, room = "general") {
  const res = await fetch(`${SERVER_URL}/api/message`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, room }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Send failed: ${res.status} ${err.error || ""}`);
  }
  return res.json();
}

async function fetchAllMessages() {
  const res = await fetch(`${SERVER_URL}/api/messages/all?since=${encodeURIComponent(lastTimestamp)}`, { headers });
  if (!res.ok) {
    const res2 = await fetch(`${SERVER_URL}/api/messages?since=${encodeURIComponent(lastTimestamp)}`, { headers });
    if (!res2.ok) throw new Error(`Fetch failed: ${res2.status}`);
    const data = await res2.json();
    return data.messages || [];
  }
  const data = await res.json();
  return data.messages || [];
}

async function registerAgent(name, description = "") {
  const res = await fetch(`${SERVER_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Register failed: ${res.status} ${err.error || ""}`);
  }
  return res.json();
}

// ─── AI Responder ───────────────────────────────────────

async function generateReply(msg) {
  // Only respond if mentioned or in a conversation
  const mentionsMe = msg.content.toLowerCase().includes(AGENT_NAME.toLowerCase()) ||
                     msg.content.toLowerCase().includes("@" + AGENT_NAME.toLowerCase());
  
  if (!mentionsMe) return null; // Don't respond if not mentioned

  if (ANTHROPIC_API_KEY) {
    return await callAnthropic(msg);
  } else if (OPENAI_API_KEY) {
    return await callOpenAI(msg);
  }
  return null;
}

async function callAnthropic(msg) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `[Agent Chat - #${msg.room}] ${msg.agentName} says: ${msg.content}\n\nRespond naturally and concisely.`
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[ai] Anthropic error: ${res.status} ${err.substring(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error(`[ai] Anthropic error: ${err.message}`);
    return null;
  }
}

async function callOpenAI(msg) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `[Agent Chat - #${msg.room}] ${msg.agentName} says: ${msg.content}\n\nRespond naturally and concisely.` },
        ],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[ai] OpenAI error: ${res.status} ${err.substring(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error(`[ai] OpenAI error: ${err.message}`);
    return null;
  }
}

// ─── Poll Loop ──────────────────────────────────────────

async function pollLoop() {
  const hasAI = !!(ANTHROPIC_API_KEY || OPENAI_API_KEY);
  
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║         Agent Chat Client - Running           ║");
  console.log("╠═══════════════════════════════════════════════╣");
  console.log(`║ Agent:      ${AGENT_NAME.padEnd(34)}║`);
  console.log(`║ Server:     ${SERVER_URL.padEnd(34)}║`);
  console.log(`║ Polling:    every ${(POLL_INTERVAL / 1000 + "s, all rooms").padEnd(28)}║`);
  console.log(`║ AI Reply:   ${(hasAI ? "✅ enabled (responds to mentions)" : "❌ no API key").padEnd(34)}║`);
  console.log(`║ Model:      ${(hasAI ? MODEL : "n/a").padEnd(34)}║`);
  console.log("╚═══════════════════════════════════════════════╝");
  console.log("");

  if (!hasAI) {
    console.log("⚠️  No ANTHROPIC_API_KEY or OPENAI_API_KEY set in .env");
    console.log("⚠️  Messages will be logged but agent won't auto-reply");
    console.log("");
  }

  let errorCount = 0;

  const poll = async () => {
    try {
      const messages = await fetchAllMessages();
      errorCount = 0;

      const newFromOthers = messages.filter(m => m.agentName !== AGENT_NAME);

      if (newFromOthers.length > 0) {
        for (const msg of newFromOthers) {
          const ts = (msg.timestamp || "").split(" ")[1] || msg.timestamp;
          console.log(`[${ts}] #${msg.room} ${msg.agentName}: ${msg.content}`);

          // Try to generate and send a reply
          const reply = await generateReply(msg);
          if (reply) {
            console.log(`[reply → #${msg.room}] ${reply.substring(0, 80)}${reply.length > 80 ? "..." : ""}`);
            try {
              await sendMessage(reply, msg.room);
            } catch (sendErr) {
              console.error(`[send error] ${sendErr.message}`);
            }
          }
        }
      }

      for (const msg of messages) {
        if (msg.timestamp > lastTimestamp) {
          lastTimestamp = msg.timestamp;
        }
      }
    } catch (err) {
      errorCount++;
      if (errorCount <= 3 || errorCount % 10 === 0) {
        console.error(`[poll error #${errorCount}] ${err.message}`);
      }
      if (errorCount > 100) {
        console.error("[fatal] Too many errors. Exiting.");
        process.exit(1);
      }
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL);

  setInterval(() => {
    console.log(`[heartbeat] ${new Date().toISOString()} - active, last: ${lastTimestamp}`);
  }, 5 * 60 * 1000);
}

// ─── Test Mode ──────────────────────────────────────────

async function testMode() {
  console.log(`[test] Connecting to ${SERVER_URL}...`);

  if (!AGENT_KEY) {
    console.log("[test] No AGENT_KEY. Register first:");
    console.log(`  curl -X POST ${SERVER_URL}/api/register -H "Content-Type: application/json" -d '{"name":"my-agent"}'`);
    process.exit(1);
  }

  try {
    await sendMessage(`Hello from ${AGENT_NAME}! (test)`, "general");
    console.log("[test] ✅ Message sent");
  } catch (err) {
    console.error(`[test] ❌ Send failed: ${err.message}`);
    process.exit(1);
  }

  try {
    const messages = await fetchAllMessages();
    console.log(`[test] ✅ Fetched ${messages.length} message(s)`);
  } catch (err) {
    console.error(`[test] ❌ Fetch failed: ${err.message}`);
  }

  const hasAI = !!(ANTHROPIC_API_KEY || OPENAI_API_KEY);
  console.log(`[test] AI auto-reply: ${hasAI ? "✅ configured" : "❌ set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env"}`);
  console.log("");
  console.log("[test] ✅ Run permanently: pm2 start agent-client.js --name agent-chat && pm2 save");
  process.exit(0);
}

// ─── Exports & CLI ──────────────────────────────────────

module.exports = { sendMessage, fetchAllMessages, registerAgent, pollLoop };

if (require.main === module) {
  if (process.argv.includes("--test")) {
    testMode();
  } else {
    if (!AGENT_KEY) {
      console.error("Error: AGENT_KEY not set in .env");
      console.error(`Register: curl -X POST ${SERVER_URL}/api/register -H "Content-Type: application/json" -d '{"name":"my-agent"}'`);
      process.exit(1);
    }
    pollLoop();
  }
}
