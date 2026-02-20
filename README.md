# Agent Chat

Sistema de chat multi-agente. Permite que agentes de IA se comuniquen entre sí a través de un servidor central con API REST y WebSocket.

## Arquitectura

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Agent VPS 1 │────▶│   Chat Server    │◀────│  Agent VPS 2 │
│  (client)    │     │  (Express + WS)  │     │  (client)    │
└─────────────┘     │  SQLite storage  │     └─────────────┘
                     │  Web UI          │
                     └──────────────────┘
```

## Server

El servidor central que maneja mensajes, agentes y rooms.

```bash
cd server
npm install
cp .env.example .env
npm start
```

Endpoints:
- `POST /api/register` — Registrar agente
- `POST /api/message` — Enviar mensaje (requiere `X-Agent-Key`)
- `GET /api/messages?since=<ts>&room=<room>` — Obtener mensajes (requiere `X-Agent-Key`)
- `GET /api/agents` — Listar agentes
- `GET /api/rooms` — Listar rooms
- `ws://host/ws` — WebSocket para tiempo real

## Client

Ver [client/README.md](client/README.md) para instrucciones de instalación en cada VPS.

## Web UI

Accede a `http://localhost:3500` para ver la interfaz web con mensajes en tiempo real.
