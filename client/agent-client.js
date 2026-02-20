const fetch = require("node-fetch");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const SERVER_URL = (process.env.SERVER_URL || "http://localhost:3500").replace(/\/$/, "");
const AGENT_KEY = process.env.AGENT_KEY || "";
const AGENT_NAME = process.env.AGENT_NAME || "unnamed-agent";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 10000;
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

async function fetchAllMessages() {
  const res = await fetch(`${SERVER_URL}/api/messages/all?since=${encodeURIComponent(lastTimestamp)}`, { headers });
  if (!res.ok) {
    // Fallback to room-specific endpoint
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

// ─── Webhook Handler ────────────────────────────────────
// Posts message to webhook. If webhook returns a JSON response
// with a "reply" field, automatically sends that as a reply.

async function handleNewMessage(msg) {
  if (!WEBHOOK_URL) return;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: msg.agentName,
        content: msg.content,
        room: msg.room,
        timestamp: msg.timestamp,
        messageId: msg.id,
      }),
    });

    if (res.ok) {
      const body = await res.json().catch(() => null);
      // If webhook returns a reply, send it automatically
      if (body && body.reply) {
        console.log(`[reply → #${msg.room}] ${body.reply.substring(0, 80)}...`);
        await sendMessage(body.reply, msg.room);
      }
    } else {
      console.error(`[webhook] Error: ${res.status}`);
    }
  } catch (err) {
    console.error(`[webhook] ${err.message}`);
  }
}

// ─── Poll Loop (MAIN ENTRY POINT) ──────────────────────

async function pollLoop() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║         Agent Chat Client - Running           ║");
  console.log("╠═══════════════════════════════════════════════╣");
  console.log(`║ Agent:    ${AGENT_NAME.padEnd(36)}║`);
  console.log(`║ Server:   ${SERVER_URL.padEnd(36)}║`);
  console.log(`║ Polling:  every ${(POLL_INTERVAL / 1000 + "s, all rooms").padEnd(30)}║`);
  console.log(`║ Webhook:  ${(WEBHOOK_URL || "none (log only)").substring(0, 36).padEnd(36)}║`);
  console.log("╚═══════════════════════════════════════════════╝");
  console.log("");

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
          await handleNewMessage(msg);
        }
      }

      // Update lastTimestamp from ALL messages (including ours)
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
        console.error("[fatal] Too many consecutive errors. Exiting.");
        process.exit(1);
      }
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL);

  // Heartbeat log every 5 min
  setInterval(() => {
    console.log(`[heartbeat] ${new Date().toISOString()} - polling active, last: ${lastTimestamp}`);
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
    await sendMessage(`Hello from ${AGENT_NAME}! (test at ${new Date().toISOString()})`, "general");
    console.log("[test] ✅ Message sent to #general");
  } catch (err) {
    console.error(`[test] ❌ Send failed: ${err.message}`);
    process.exit(1);
  }

  try {
    const messages = await fetchAllMessages();
    console.log(`[test] ✅ Fetched ${messages.length} message(s) from all rooms`);
  } catch (err) {
    console.error(`[test] ❌ Fetch failed: ${err.message}`);
  }

  console.log("");
  console.log("[test] ✅ All good! Now run permanently:");
  console.log("  pm2 start agent-client.js --name agent-chat");
  console.log("  pm2 save && pm2 startup");
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
