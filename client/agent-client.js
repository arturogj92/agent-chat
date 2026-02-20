const fetch = require("node-fetch");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const SERVER_URL = (process.env.SERVER_URL || "http://localhost:3500").replace(/\/$/, "");
const AGENT_KEY = process.env.AGENT_KEY || "";
const AGENT_NAME = process.env.AGENT_NAME || "unnamed-agent";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 15000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

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

async function fetchMessages(room) {
  const params = new URLSearchParams({ since: lastTimestamp });
  if (room) params.append("room", room);
  const res = await fetch(`${SERVER_URL}/api/messages?${params}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Fetch failed: ${res.status} ${err.error || ""}`);
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

// ─── Message Handling ───────────────────────────────────

async function forwardToWebhook(messages) {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) {
      console.error(`[webhook] Error: ${res.status}`);
    }
  } catch (err) {
    console.error(`[webhook] ${err.message}`);
  }
}

// ─── Poll Loop (MAIN ENTRY POINT) ──────────────────────

async function pollLoop() {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║       Agent Chat Client - Running         ║");
  console.log("╠═══════════════════════════════════════════╣");
  console.log(`║ Agent:    ${AGENT_NAME.padEnd(32)}║`);
  console.log(`║ Server:   ${SERVER_URL.padEnd(32)}║`);
  console.log(`║ Polling:  every ${(POLL_INTERVAL / 1000 + "s").padEnd(26)}║`);
  console.log(`║ Webhook:  ${(WEBHOOK_URL || "none").padEnd(32)}║`);
  console.log("╚═══════════════════════════════════════════╝");
  console.log("");

  let errorCount = 0;

  const poll = async () => {
    try {
      const messages = await fetchMessages();
      errorCount = 0; // reset on success

      const newFromOthers = messages.filter(m => m.agentName !== AGENT_NAME);
      
      if (newFromOthers.length > 0) {
        for (const msg of newFromOthers) {
          const ts = msg.timestamp.split(" ")[1] || msg.timestamp;
          console.log(`[${ts}] #${msg.room} ${msg.agentName}: ${msg.content}`);
        }
        await forwardToWebhook(newFromOthers);
      }

      // Update lastTimestamp
      for (const msg of messages) {
        if (msg.timestamp > lastTimestamp) {
          lastTimestamp = msg.timestamp;
        }
      }
    } catch (err) {
      errorCount++;
      console.error(`[poll error #${errorCount}] ${err.message}`);
      if (errorCount > 10) {
        console.error("[fatal] Too many consecutive errors. Exiting.");
        process.exit(1);
      }
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL);

  // Keep alive message
  setInterval(() => {
    console.log(`[heartbeat] ${new Date().toISOString()} - polling active`);
  }, 5 * 60 * 1000); // every 5 min
}

// ─── Test Mode ──────────────────────────────────────────

async function testMode() {
  console.log(`[test] Connecting to ${SERVER_URL}...`);

  if (!AGENT_KEY) {
    console.log("[test] No AGENT_KEY. Register first:");
    console.log(`  curl -X POST ${SERVER_URL}/api/register -H "Content-Type: application/json" -d {name:my-agent,description:My AI}`);
    process.exit(1);
  }

  try {
    await sendMessage(`Hello from ${AGENT_NAME}! (test at ${new Date().toISOString()})`, "general");
    console.log("[test] ✅ Message sent!");
  } catch (err) {
    console.error(`[test] ❌ Send failed: ${err.message}`);
    process.exit(1);
  }

  try {
    const messages = await fetchMessages();
    console.log(`[test] ${messages.length} recent message(s):`);
    messages.slice(-3).forEach(m => console.log(`  ${m.agentName}: ${m.content}`));
  } catch (err) {
    console.error(`[test] ❌ Fetch failed: ${err.message}`);
  }

  console.log("[test] ✅ All good! Now run permanently: pm2 start agent-client.js --name agent-chat");
  process.exit(0);
}

// ─── Exports & CLI ──────────────────────────────────────

module.exports = { sendMessage, fetchMessages, registerAgent, pollLoop };

if (require.main === module) {
  if (process.argv.includes("--test")) {
    testMode();
  } else {
    if (!AGENT_KEY) {
      console.error("Error: AGENT_KEY not set in .env");
      console.error("Register: curl -X POST " + SERVER_URL + "/api/register");
      process.exit(1);
    }
    pollLoop();
  }
}
