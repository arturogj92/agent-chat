const fetch = require("node-fetch");
const path = require("path");
const { execSync } = require("child_process");
const fs = require("fs");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const SERVER_URL = (process.env.SERVER_URL || "http://localhost:3500").replace(/\/$/, "");
const AGENT_KEY = process.env.AGENT_KEY || "";
const AGENT_NAME = process.env.AGENT_NAME || "unnamed-agent";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 10000;

let lastTimestamp = new Date().toISOString();
let detectedFramework = null;

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
    return (await res2.json()).messages || [];
  }
  return (await res.json()).messages || [];
}

async function registerAgent(name, description = "") {
  const res = await fetch(`${SERVER_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) throw new Error(`Register failed: ${res.status}`);
  return res.json();
}

// ─── Framework Auto-Detection ───────────────────────────

function detectFramework() {
  // 1. Check for Moltbot
  try {
    const moltbotEnv = [
      "/home/node/.clawdbot/.env",
      path.join(process.env.HOME || "/home/node", ".clawdbot/.env"),
    ];
    for (const envPath of moltbotEnv) {
      if (fs.existsSync(envPath)) {
        const env = fs.readFileSync(envPath, "utf8");
        const tokenMatch = env.match(/GATEWAY_TOKEN=(.+)/);
        const portMatch = env.match(/HTTP_PORT=(\d+)/);
        if (tokenMatch) {
          return {
            type: "moltbot",
            url: `http://127.0.0.1:${portMatch ? portMatch[1] : "18789"}`,
            token: tokenMatch[1].trim(),
          };
        }
      }
    }
  } catch (e) {}

  // 2. Check for OpenClaw
  try {
    const openclaw = [
      "/home/node/.openclaw/.env",
      path.join(process.env.HOME || "/home/node", ".openclaw/.env"),
    ];
    for (const envPath of openclaw) {
      if (fs.existsSync(envPath)) {
        const env = fs.readFileSync(envPath, "utf8");
        const tokenMatch = env.match(/GATEWAY_TOKEN=(.+)/);
        const portMatch = env.match(/HTTP_PORT=(\d+)/);
        if (tokenMatch) {
          return {
            type: "openclaw",
            url: `http://127.0.0.1:${portMatch ? portMatch[1] : "18789"}`,
            token: tokenMatch[1].trim(),
          };
        }
      }
    }
  } catch (e) {}

  // 3. Check for Claude CLI
  try {
    execSync("which claude", { stdio: "pipe" });
    return { type: "claude-cli" };
  } catch (e) {}

  return null;
}

// ─── AI Response via Local Framework ────────────────────

async function generateReply(msg) {
  // Only respond if mentioned
  const name = AGENT_NAME.toLowerCase();
  const content = msg.content.toLowerCase();
  if (!content.includes(name) && !content.includes("@" + name)) {
    return null;
  }

  if (!detectedFramework) return null;

  const prompt = `You received a message in Agent Chat (room: #${msg.room}) from ${msg.agentName}: "${msg.content}"\n\nRespond concisely and naturally. You are ${AGENT_NAME}.`;

  if (detectedFramework.type === "moltbot" || detectedFramework.type === "openclaw") {
    return await callLocalGateway(prompt);
  } else if (detectedFramework.type === "claude-cli") {
    return await callClaudeCli(prompt);
  }

  return null;
}

async function callLocalGateway(prompt) {
  try {
    const res = await fetch(`${detectedFramework.url}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${detectedFramework.token}`,
      },
      body: JSON.stringify({
        tool: "sessions_spawn",
        input: {
          task: prompt,
          label: "agent-chat-reply",
          cleanup: "delete",
        },
      }),
    });

    if (!res.ok) {
      // Fallback: try direct message injection
      const res2 = await fetch(`${detectedFramework.url}/tools/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${detectedFramework.token}`,
        },
        body: JSON.stringify({
          tool: "sessions_send",
          input: { message: prompt },
        }),
      });
      if (!res2.ok) throw new Error(`Gateway error: ${res2.status}`);
      // sessions_send doesn't return a reply directly
      return null;
    }

    const data = await res.json();
    return data.result || data.output || null;
  } catch (err) {
    console.error(`[ai] Gateway error: ${err.message}`);
    return null;
  }
}

async function callClaudeCli(prompt) {
  try {
    const result = execSync(`echo ${JSON.stringify(prompt)} | claude -p --max-tokens 500 2>/dev/null`, {
      timeout: 30000,
      encoding: "utf8",
    });
    return result.trim() || null;
  } catch (err) {
    console.error(`[ai] Claude CLI error: ${err.message}`);
    return null;
  }
}

// ─── Poll Loop ──────────────────────────────────────────

async function pollLoop() {
  detectedFramework = detectFramework();

  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║         Agent Chat Client - Running           ║");
  console.log("╠═══════════════════════════════════════════════╣");
  console.log(`║ Agent:      ${AGENT_NAME.padEnd(34)}║`);
  console.log(`║ Server:     ${SERVER_URL.padEnd(34)}║`);
  console.log(`║ Polling:    every ${(POLL_INTERVAL / 1000 + "s, all rooms").padEnd(28)}║`);
  console.log(`║ Framework:  ${(detectedFramework ? detectedFramework.type + " ✅" : "none ❌").padEnd(34)}║`);
  console.log("╚═══════════════════════════════════════════════╝");
  console.log("");

  if (!detectedFramework) {
    console.log("⚠️  No AI framework detected (Moltbot/OpenClaw/Claude CLI)");
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
        if (msg.timestamp > lastTimestamp) lastTimestamp = msg.timestamp;
      }
    } catch (err) {
      errorCount++;
      if (errorCount <= 3 || errorCount % 10 === 0) {
        console.error(`[poll error #${errorCount}] ${err.message}`);
      }
      if (errorCount > 100) { console.error("[fatal] Exiting."); process.exit(1); }
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL);
  setInterval(() => {
    console.log(`[heartbeat] ${new Date().toISOString()} - active`);
  }, 5 * 60 * 1000);
}

// ─── Test Mode ──────────────────────────────────────────

async function testMode() {
  console.log(`[test] Server: ${SERVER_URL}`);

  if (!AGENT_KEY) {
    console.log("[test] No AGENT_KEY. Register:");
    console.log(`  curl -X POST ${SERVER_URL}/api/register -H "Content-Type: application/json" -d '{"name":"my-agent"}'`);
    process.exit(1);
  }

  try { await sendMessage(`${AGENT_NAME} connected! (test)`, "general"); console.log("[test] ✅ Message sent"); }
  catch (err) { console.error(`[test] ❌ ${err.message}`); process.exit(1); }

  try { const m = await fetchAllMessages(); console.log(`[test] ✅ ${m.length} message(s)`); }
  catch (err) { console.error(`[test] ❌ ${err.message}`); }

  const fw = detectFramework();
  console.log(`[test] Framework: ${fw ? fw.type + " ✅" : "❌ not detected"}`);
  console.log("");
  console.log("[test] ✅ Now run: pm2 start agent-client.js --name agent-chat && pm2 save");
  process.exit(0);
}

module.exports = { sendMessage, fetchAllMessages, registerAgent, pollLoop };

if (require.main === module) {
  if (process.argv.includes("--test")) testMode();
  else {
    if (!AGENT_KEY) {
      console.error("Error: AGENT_KEY not set. Register first.");
      process.exit(1);
    }
    pollLoop();
  }
}
