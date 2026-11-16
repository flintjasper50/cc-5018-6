import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const ROOM_ID_RE = /^[A-Za-z0-9_-]{3,32}$/;

function jsonReply(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(obj));
}

class Room {
  constructor(id) {
    this.id = id;
    this.peers = new Map();
    this.presenterId = null;
    this.presenterState = {
      state: 'idle',
      reason: null,
      detail: null,
      at: Date.now(),
    };
    this.createdAt = Date.now();
    this.telemetry = [];
    this.events = [];
  }

  addEvent(type, payload = {}) {
    const ev = { type, at: Date.now(), ...payload };
    this.events.push(ev);
    if (this.events.length > 4000) this.events.splice(0, 1000);
    return ev;
  }

  addTelemetry(from, sample) {
    const rec = { from, at: Date.now(), ...sample };
    this.telemetry.push(rec);
    if (this.telemetry.length > 8000) this.telemetry.splice(0, 2000);
  }
}

class SignalingHub {
  constructor({ evidenceDir }) {
    this.rooms = new Map();
    this.evidenceDir = evidenceDir;
  }

  room(id) {
    let r = this.rooms.get(id);
    if (!r) {
      r = new Room(id);
      this.rooms.set(id, r);
    }
    return r;
  }

  send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcast(room, obj, exclude = null) {
    for (const peer of room.peers.values()) {
      if (peer.id === exclude) continue;
      this.send(peer.ws, obj);
    }
  }

  peerSummary(peer) {
    return {
      id: peer.id,
      role: peer.role,
      name: peer.name,
      joinedAt: peer.joinedAt,
    };
  }

  attach(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role');
    const roomId = url.searchParams.get('room');
    const name = (url.searchParams.get('name') || '').slice(0, 60);

    if (!ROOM_ID_RE.test(roomId || '') || !['presenter', 'viewer'].includes(role)) {
      this.send(ws, {
        t: 'error',
        code: 'bad-join',
        message: 'role must be presenter|viewer and room must be 3-32 chars',
      });
      ws.close();
      return;
    }

    const room = this.room(roomId);
    if (role === 'presenter' && room.presenterId) {
      this.send(ws, {
        t: 'error',
        code: 'presenter-exists',
        message: 'this room already has a presenter',
      });
      ws.close();
      return;
    }

    const peer = {
      id: crypto.randomUUID(),
      role,
      name: name || (role === 'presenter' ? 'presenter' : 'viewer'),
      ws,
      joinedAt: Date.now(),
      roomId,
    };
    room.peers.set(peer.id, peer);
    if (role === 'presenter') room.presenterId = peer.id;

    room.addEvent('join', { peerId: peer.id, role, name: peer.name });
    this.send(ws, {
      t: 'welcome',
      selfId: peer.id,
      room: roomId,
      role,
      peers: [...room.peers.values()].map((p) => this.peerSummary(p)),
      presenterId: room.presenterId,
      presenterState: room.presenterState,
      iceServers: this.iceServers(),
      serverTime: Date.now(),
    });

    this.broadcast(
      room,
      { t: 'peer-join', peer: this.peerSummary(peer) },
      peer.id,
    );

    // A presenter who is already live should learn about new viewers only when
    // the viewer requests a stream; viewers get the current presenter state.
    ws.on('message', (raw) => this.onMessage(room, peer, raw));
    ws.on('close', () => this.onClose(room, peer));
    ws.on('error', () => {});
  }

  iceServers() {
    const turnUrl = process.env.TURN_URL;
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (turnUrl) {
      iceServers.unshift({
        urls: turnUrl,
        username: process.env.TURN_USER || 'demo',
        credential: process.env.TURN_PASS || 'demo-pass',
      });
    }
    return iceServers;
  }

  onMessage(room, peer, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'signal': {
        const target = room.peers.get(msg.to);
        if (!target) {
          this.send(peer.ws, {
            t: 'error',
            code: 'no-peer',
            message: `peer ${msg.to} not in room`,
          });
          return;
        }
        this.send(target.ws, {
          t: 'signal',
          from: peer.id,
          role: peer.role,
          payload: msg.payload,
        });
        return;
      }
      case 'state': {
        if (peer.role !== 'presenter') return;
        room.presenterState = {
          state: String(msg.state || 'unknown'),
          reason: msg.reason ?? null,
          detail: msg.detail ?? null,
          at: Date.now(),
        };
        room.addEvent('presenter-state', room.presenterState);
        this.broadcast(room, {
          t: 'state',
          ...room.presenterState,
          from: peer.id,
        });
        return;
      }
      case 'stats': {
        room.addTelemetry(peer.id, msg.sample || {});
        return;
      }
      case 'request-stream': {
        if (peer.role !== 'viewer') return;
        const presenter = room.peers.get(room.presenterId);
        if (!presenter) {
          this.send(peer.ws, {
            t: 'error',
            code: 'no-presenter',
            message: 'presenter is not in the room',
          });
          return;
        }
        this.send(presenter.ws, {
          t: 'viewer-request',
          viewerId: peer.id,
          viewerName: peer.name,
        });
        room.addEvent('request-stream', {
          viewerId: peer.id,
          presenterState: room.presenterState.state,
        });
        return;
      }
      case 'viewer-leave': {
        return;
      }
      case 'region-want': {
        // A viewer opts in to the focus-region track. The presenter uses this
        // to decide whether to attach the region stream at all: a viewer that
        // stays on whole-screen does not make the presenter pay the extra
        // encode. The reverse message (want=false) is what makes "switch back
        // to full screen" release the track instead of leaving it running.
        if (peer.role !== 'viewer') return;
        const presenter = room.peers.get(room.presenterId);
        if (!presenter) return;
        this.send(presenter.ws, {
          t: 'region-want',
          viewerId: peer.id,
          want: !!msg.want,
        });
        room.addEvent('region-want', { viewerId: peer.id, want: !!msg.want });
        return;
      }
      default:
        return;
    }
  }

  onClose(room, peer) {
    room.peers.delete(peer.id);
    room.addEvent('leave', { peerId: peer.id, role: peer.role });
    if (peer.role === 'presenter') {
      room.presenterId = null;
      room.presenterState = {
        state: 'ended',
        reason: 'presenter-disconnected',
        detail: null,
        at: Date.now(),
      };
      room.addEvent('presenter-state', room.presenterState);
      this.broadcast(room, { t: 'state', ...room.presenterState });
    }
    this.broadcast(room, { t: 'peer-leave', peerId: peer.id });
  }

  roomSnapshot(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      id: room.id,
      presenterId: room.presenterId,
      presenterState: room.presenterState,
      peers: [...room.peers.values()].map((p) => this.peerSummary(p)),
      events: room.events,
      telemetry: room.telemetry,
    };
  }
}

export function createApp({ publicDir, evidenceDir }) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const hub = new SignalingHub({ evidenceDir });

  async function handleApi({ req, res, url, hub }) {
    if (url.pathname === '/api/health') {
      return jsonReply(res, 200, { ok: true, rooms: hub.rooms.size });
    }
    const snap = url.pathname.match(/^\/api\/room\/([A-Za-z0-9_-]+)$/);
    if (snap && req.method === 'GET') {
      const room = hub.roomSnapshot(snap[1]);
      return jsonReply(res, room ? 200 : 404, room || { error: 'no room' });
    }
    const ev = url.pathname.match(
      /^\/api\/evidence\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
    );
    if (ev && req.method === 'POST') {
      const [, runId, filename] = ev;
      const dir = path.join(evidenceDir, runId);
      fs.mkdirSync(dir, { recursive: true });
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 60 * 1024 * 1024) {
          return jsonReply(res, 413, { error: 'payload too large' });
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!/^[A-Za-z0-9_.-]+$/.test(filename)) {
        return jsonReply(res, 400, { error: 'bad filename' });
      }
      fs.writeFileSync(path.join(dir, filename), body);
      return jsonReply(res, 200, { ok: true, bytes: body.length });
    }
    if (url.pathname === '/api/evidence/list' && req.method === 'GET') {
      const runId = url.searchParams.get('run') || '';
      if (!/^[A-Za-z0-9_.-]+$/.test(runId)) {
        return jsonReply(res, 400, { error: 'bad run' });
      }
      const dir = path.join(evidenceDir, runId);
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).map((name) => {
            const st = fs.statSync(path.join(dir, name));
            return { name, bytes: st.size, mtime: st.mtimeMs };
          })
        : [];
      return jsonReply(res, 200, { run: runId, files });
    }
    return jsonReply(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      return handleApi({ req, res, url, hub }).catch((err) => {
        jsonReply(res, 500, { error: String(err && err.message ? err.message : err) });
      });
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.join(publicDir, path.normalize(rel));
    if (!full.startsWith(publicDir)) {
      return jsonReply(res, 403, { error: 'forbidden' });
    }
    fs.stat(full, (err, stat) => {
      if (err || !stat.isFile()) {
        return jsonReply(res, 404, { error: 'not found', path: rel });
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-store',
        'permissions-policy':
          'display-capture=(self), autoplay=(self), fullscreen=(self)',
      });
      fs.createReadStream(full).pipe(res);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, req));
  });

  return { server, hub, wss };
}
