const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

require('dotenv').config();

const PORT = process.env.PORT || 3500;
const ADMIN_KEY = process.env.ADMIN_KEY || 'cambiar-esto';

// Database setup
const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    apiKey TEXT UNIQUE NOT NULL,
    createdAt TEXT DEFAULT (datetime('now')),
    lastSeen TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agentId TEXT NOT NULL,
    agentName TEXT NOT NULL,
    content TEXT NOT NULL,
    room TEXT DEFAULT 'general',
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (agentId) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room_timestamp ON messages(room, timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
`);

// Prepared statements
const stmts = {
  insertAgent: db.prepare('INSERT INTO agents (id, name, description, apiKey) VALUES (?, ?, ?, ?)'),
  getAgentByKey: db.prepare('SELECT * FROM agents WHERE apiKey = ?'),
  updateLastSeen: db.prepare("UPDATE agents SET lastSeen = datetime('now') WHERE id = ?"),
  getAllAgents: db.prepare('SELECT id, name, description, createdAt, lastSeen FROM agents ORDER BY lastSeen DESC'),
  insertMessage: db.prepare('INSERT INTO messages (agentId, agentName, content, room) VALUES (?, ?, ?, ?)'),
  getMessagesSince: db.prepare('SELECT * FROM messages WHERE room = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT 200'),
  getAllMessages: db.prepare('SELECT * FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 100'),
  getMessagesSinceAllRooms: db.prepare("SELECT * FROM messages WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 200"),
  getRecentAllRooms: db.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 100"),
  getRooms: db.prepare('SELECT DISTINCT room FROM messages ORDER BY room'),
};

// Express app
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function authenticate(req, res, next) {
  const apiKey = req.headers['x-agent-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-Agent-Key header' });
  }
  const agent = stmts.getAgentByKey.get(apiKey);
  if (!agent) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  stmts.updateLastSeen.run(agent.id);
  req.agent = agent;
  next();
}

// HTTP server + WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const wsClients = new Set();

// Rate limit: max 1 message per 30s per agent (anti-loop)
const rateLimits = new Map();
const RATE_LIMIT_MS = 30000;

function checkRateLimit(agentId) {
  const last = rateLimits.get(agentId) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) {
    return false; // too soon
  }
  rateLimits.set(agentId, now);
  return true;
}


wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcastWs(data) {
  const payload = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

// Routes

// Register a new agent
app.post('/api/register', (req, res) => {
  const { name, description } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }

  const agentId = uuidv4();
  const apiKey = `ak_${uuidv4().replace(/-/g, '')}`;

  try {
    stmts.insertAgent.run(agentId, name.trim(), (description || '').trim(), apiKey);
    broadcastWs({ type: 'agent_joined', agent: { id: agentId, name: name.trim(), description: (description || '').trim() } });
    res.json({ agentId, apiKey, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to register agent', details: err.message });
  }
});

// Send a message
app.post('/api/message', authenticate, (req, res) => {
  const { content, room } = req.body;
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'content is required' });
  }

  const targetRoom = (room || 'general').trim();

  try {
    const result = stmts.insertMessage.run(req.agent.id, req.agent.name, content.trim(), targetRoom);
    const message = {
      id: result.lastInsertRowid,
      agentId: req.agent.id,
      agentName: req.agent.name,
      content: content.trim(),
      room: targetRoom,
      timestamp: new Date().toISOString(),
    };

    broadcastWs({ type: 'new_message', message });
    res.json({ ok: true, messageId: message.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message', details: err.message });
  }
});

// Get messages since timestamp
app.get('/api/messages', (req, res) => {
  const { since, room } = req.query;
  const targetRoom = (room || 'general').trim();

  try {
    let messages;
    if (since) {
      messages = stmts.getMessagesSince.all(targetRoom, since);
    } else {
      messages = stmts.getAllMessages.all(targetRoom).reverse();
    }
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get messages', details: err.message });
  }
});


// Get messages from ALL rooms since timestamp
app.get("/api/messages/all", (req, res) => {
  const { since } = req.query;
  try {
    let messages;
    if (since) {
      messages = stmts.getMessagesSinceAllRooms.all(since);
    } else {
      messages = stmts.getRecentAllRooms.all().reverse();
    }
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: "Failed to get messages", details: err.message });
  }
});

// List agents
app.get('/api/agents', (req, res) => {
  try {
    const agents = stmts.getAllAgents.all();
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get agents', details: err.message });
  }
});

// List rooms
app.get('/api/rooms', (req, res) => {
  try {
    const rooms = stmts.getRooms.all().map((r) => r.room);
    if (!rooms.includes('general')) {
      rooms.unshift('general');
    }
    res.json({ rooms });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get rooms', details: err.message });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Agent Chat Server running on port ${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
});
