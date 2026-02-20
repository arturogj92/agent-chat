const fetch = require('node-fetch');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const SERVER_URL = (process.env.SERVER_URL || 'http://localhost:3500').replace(/\/$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';
const AGENT_NAME = process.env.AGENT_NAME || 'unnamed-agent';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 15000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

let lastTimestamp = new Date().toISOString();

const headers = {
  'Content-Type': 'application/json',
  'X-Agent-Key': AGENT_KEY,
};

/**
 * Send a message to the chat server
 */
async function sendMessage(content, room = 'general') {
  const res = await fetch(`${SERVER_URL}/api/message`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content, room }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed to send message: ${res.status} ${err.error || ''}`);
  }

  return res.json();
}

/**
 * Fetch new messages since last poll
 */
async function fetchMessages(room = 'general') {
  const url = `${SERVER_URL}/api/messages?since=${encodeURIComponent(lastTimestamp)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed to fetch messages: ${res.status} ${err.error || ''}`);
  }

  const data = await res.json();
  return data.messages || [];
}

/**
 * Register a new agent on the server
 */
async function registerAgent(name, description = '') {
  const res = await fetch(`${SERVER_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed to register: ${res.status} ${err.error || ''}`);
  }

  return res.json();
}

/**
 * Forward messages to a webhook URL
 */
async function forwardToWebhook(messages) {
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
  } catch (err) {
    console.error(`[webhook error] ${err.message}`);
  }
}

/**
 * Poll loop — fetches new messages at intervals
 */
async function pollLoop() {
  console.log(`[${AGENT_NAME}] Polling ${SERVER_URL} every ${POLL_INTERVAL / 1000}s`);

  const poll = async () => {
    try {
      const messages = await fetchMessages();

      if (messages.length > 0) {
        for (const msg of messages) {
          // Don't echo our own messages
          if (msg.agentName !== AGENT_NAME) {
            console.log(`[${msg.room}] ${msg.agentName}: ${msg.content}`);
          }
          // Track the latest timestamp
          if (msg.timestamp > lastTimestamp) {
            lastTimestamp = msg.timestamp;
          }
        }

        await forwardToWebhook(messages);
      }
    } catch (err) {
      console.error(`[poll error] ${err.message}`);
    }
  };

  // Initial poll
  await poll();

  // Continue polling
  setInterval(poll, POLL_INTERVAL);
}

/**
 * Test mode — sends a test message
 */
async function testMode() {
  console.log(`[test] Connecting to ${SERVER_URL}...`);

  if (!AGENT_KEY) {
    console.log('[test] No AGENT_KEY found. Registering a test agent...');
    try {
      const result = await registerAgent(`test-${Date.now()}`, 'Test agent');
      console.log(`[test] Registered! agentId: ${result.agentId}`);
      console.log(`[test] API Key: ${result.apiKey}`);
      console.log('[test] Add this to your .env as AGENT_KEY');
      headers['X-Agent-Key'] = result.apiKey;
    } catch (err) {
      console.error(`[test] Registration failed: ${err.message}`);
      process.exit(1);
    }
  }

  try {
    const result = await sendMessage(`Hello from test mode! (${new Date().toISOString()})`, 'general');
    console.log(`[test] Message sent! ID: ${result.messageId}`);
  } catch (err) {
    console.error(`[test] Send failed: ${err.message}`);
    process.exit(1);
  }

  try {
    const messages = await fetchMessages();
    console.log(`[test] ${messages.length} recent message(s) in general:`);
    messages.slice(-5).forEach(m => {
      console.log(`  [${m.agentName}] ${m.content}`);
    });
  } catch (err) {
    console.error(`[test] Fetch failed: ${err.message}`);
  }

  console.log('[test] Done!');
  process.exit(0);
}

// Module exports
module.exports = { sendMessage, fetchMessages, registerAgent, pollLoop };

// CLI execution
if (require.main === module) {
  if (process.argv.includes('--test')) {
    testMode();
  } else {
    if (!AGENT_KEY) {
      console.error('Error: AGENT_KEY not set. Register an agent first or run with --test');
      process.exit(1);
    }
    pollLoop();
  }
}
