import dgram from 'node:dgram';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  ATTR,
  CLASS,
  METHOD,
  buildMessage,
  decodeXorAddress,
  decodeErrorCode,
  encodeErrorCode,
  encodeXorAddress,
  findAttr,
  attrString,
  attrU32,
  parseMessage,
  longTermKey,
  textValue,
  u32Value,
  verifyIntegrity,
} from './stun.mjs';

const REALM = 'demo.local';
const NONCE = crypto.randomBytes(16).toString('hex');
const CREDENTIALS = new Map([
  ['demo', 'demo-pass'],
  ['viewer', 'viewer-pass'],
]);
const LIFETIME_SEC = 600;
const MAX_DATAGRAM = 65535;

export class LinkShaper {
  constructor() {
    this.reset();
  }

  reset() {
    this.rateBps = 0;
    this.delayMs = 0;
    this.jitterMs = 0;
    this.lossPct = 0;
    this.nextFreeAt = 0;
    this.queued = [];
    // A real bottleneck queue is finite; without this the sender would see
    // ever-growing delay instead of the loss/discard a full buffer produces.
    this.maxQueueMs = 1200;
    this.stats = {
      shapedPackets: 0,
      shapedBytes: 0,
      dropped: 0,
      dropByLoss: 0,
      dropByBuffer: 0,
      peakQueueMs: 0,
      currentQueueMs: 0,
      maxOneWayMs: 0,
      oneWaySamples: 0,
      oneWaySumMs: 0,
    };
  }

  configure({ rateBps, delayMs, jitterMs, lossPct, maxQueueMs }) {
    if (typeof rateBps === 'number') this.rateBps = Math.max(0, rateBps);
    if (typeof delayMs === 'number') this.delayMs = Math.max(0, delayMs);
    if (typeof jitterMs === 'number') this.jitterMs = Math.max(0, jitterMs);
    if (typeof lossPct === 'number')
      this.lossPct = Math.min(100, Math.max(0, lossPct));
    if (typeof maxQueueMs === 'number') this.maxQueueMs = Math.max(0, maxQueueMs);
    if (this.rateBps === 0) this.nextFreeAt = 0;
  }

  // Returns a delay in ms before the packet may be emitted, or null to drop.
  schedule(size) {
    this.stats.shapedPackets++;
    this.stats.shapedBytes += size;

    if (this.lossPct > 0 && Math.random() * 100 < this.lossPct) {
      this.stats.dropped++;
      this.stats.dropByLoss++;
      return null;
    }

    const now = performance.now();
    let waitMs = this.delayMs;
    if (this.jitterMs > 0) waitMs += Math.random() * this.jitterMs;

    if (this.rateBps > 0) {
      const serializationMs = (size * 8 * 1000) / this.rateBps;
      const startAt = Math.max(now, this.nextFreeAt);
      this.nextFreeAt = startAt + serializationMs;
      const queueDelay = startAt - now;
      this.stats.currentQueueMs = queueDelay;
      if (queueDelay > this.stats.peakQueueMs)
        this.stats.peakQueueMs = queueDelay;
      if (queueDelay > this.maxQueueMs) {
        // Tail-drop with a *finite* buffer. The buffer holds at most
        // maxQueueMs worth of serialized bytes, so the standing queue is
        // clamped there: leaving the wire clock arbitrarily far in the future
        // would model an infinite buffer and pin the path at zero throughput
        // long after the offered rate dropped.
        const cap = now + this.maxQueueMs;
        if (this.nextFreeAt > cap) this.nextFreeAt = cap;
        this.stats.dropped++;
        this.stats.dropByBuffer++;
        return null;
      }
      waitMs += queueDelay;
    }

    const oneWay = waitMs;
    this.stats.oneWaySumMs += oneWay;
    this.stats.oneWaySamples++;
    if (oneWay > this.stats.maxOneWayMs) this.stats.maxOneWayMs = oneWay;
    return waitMs;
  }

  snapshot() {
    return {
      rateBps: this.rateBps,
      delayMs: this.delayMs,
      jitterMs: this.jitterMs,
      lossPct: this.lossPct,
      maxQueueMs: this.maxQueueMs,
      ...this.stats,
      meanOneWayMs: this.stats.oneWaySamples
        ? this.stats.oneWaySumMs / this.stats.oneWaySamples
        : 0,
    };
  }
}

class Scheduler {
  constructor() {
    this.items = [];
    this.timer = null;
    this.seq = 0;
  }

  add(atMs, fn) {
    const item = { at: atMs, fn, seq: this.seq++ };
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.items[mid];
      if (other.at < item.at || (other.at === item.at && other.seq < item.seq))
        lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, item);
    this.arm();
  }

  arm() {
    if (this.timer || this.items.length === 0) return;
    const now = performance.now();
    const delta = Math.max(0, this.items[0].at - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      const current = performance.now();
      while (this.items.length && this.items[0].at <= current + 0.5) {
        this.items.shift().fn();
      }
      this.arm();
    }, delta);
    if (this.timer.unref) this.timer.unref();
  }
}

export class TurnServer {
  constructor(options = {}) {
    this.port = options.port ?? 3478;
    this.host = options.host ?? '127.0.0.1';
    this.controlPort = options.controlPort ?? 3479;
    this.allocations = new Map();
    this.scheduler = new Scheduler();
    this.uplink = new LinkShaper();
    this.downlink = new LinkShaper();
    this.stats = {
      allocations: 0,
      activeAllocations: 0,
      clientToPeerPackets: 0,
      clientToPeerBytes: 0,
      peerToClientPackets: 0,
      peerToClientBytes: 0,
      authFailures: 0,
      permissionDenied: 0,
    };
    this.controlEvents = [];
  }

  start() {
    this.socket = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20 });
    this.socket.bind(this.port, this.host, () => {
      console.log(`[turn] listening udp ${this.host}:${this.port}`);
    });
    this.socket.on('message', (msg, rinfo) => this.onClientData(msg, rinfo));
    this.socket.on('error', (err) => console.error('[turn] socket error', err));
    this.startControl();
    return this;
  }

  keyFor(rinfo) {
    return `${rinfo.address}:${rinfo.port}`;
  }

  onClientData(buf, rinfo) {
    if (buf.length < 4) return;
    const first = buf[0];
    if (first >= 0x40 && first <= 0x7f) {
      this.onChannelData(buf, rinfo);
      return;
    }
    const msg = parseMessage(buf);
    if (!msg) return;
    this.onStun(msg, rinfo);
  }

  onChannelData(buf, rinfo) {
    const alloc = this.allocations.get(this.keyFor(rinfo));
    if (!alloc) return;
    const channel = buf.readUInt16BE(0);
    const length = buf.readUInt16BE(2);
    if (buf.length < 4 + length) return;
    const binding = alloc.channels.get(channel);
    if (!binding) return;
    const payload = buf.subarray(4, 4 + length);
    this.relayToPeer(alloc, binding.peer, payload, 'clientToPeer');
  }

  onStun(msg, rinfo) {
    if (msg.cls === CLASS.REQUEST) {
      switch (msg.method) {
        case METHOD.BINDING:
          return this.onBinding(msg, rinfo);
        case METHOD.ALLOCATE:
          return this.onAllocate(msg, rinfo);
        case METHOD.REFRESH:
          return this.onRefresh(msg, rinfo);
        case METHOD.CREATE_PERMISSION:
          return this.onCreatePermission(msg, rinfo);
        case METHOD.CHANNEL_BIND:
          return this.onChannelBind(msg, rinfo);
        default:
          return this.replyError(msg, rinfo, 400, 'Bad Request');
      }
    }
    if (msg.cls === CLASS.INDICATION && msg.method === METHOD.SEND) {
      return this.onSendIndication(msg, rinfo);
    }
  }

  reply(msg, rinfo, attrs, key) {
    const out = buildMessage({
      method: msg.method,
      cls: CLASS.SUCCESS,
      transactionId: msg.transactionId,
      attrs,
      integrityKey: key,
      fingerprint: true,
    });
    this.socket.send(out, rinfo.port, rinfo.address);
  }

  replyError(msg, rinfo, code, reason, key = null) {
    const attrs = [
      { type: ATTR.ERROR_CODE, value: encodeErrorCode(code, reason) },
      { type: ATTR.REALM, value: textValue(REALM) },
      { type: ATTR.NONCE, value: textValue(NONCE) },
    ];
    const out = buildMessage({
      method: msg.method,
      cls: CLASS.ERROR,
      transactionId: msg.transactionId,
      attrs,
      integrityKey: key,
      fingerprint: true,
    });
    this.socket.send(out, rinfo.port, rinfo.address);
  }

  authenticate(msg, rinfo) {
    const username = attrString(msg, ATTR.USERNAME);
    const realm = attrString(msg, ATTR.REALM);
    const nonce = attrString(msg, ATTR.NONCE);
    if (!username || !realm || !nonce || nonce !== NONCE) return null;
    if (realm !== REALM) return null;
    const password = CREDENTIALS.get(username);
    if (!password) return null;
    const key = longTermKey(username, realm, password);
    if (!verifyIntegrity(msg, key)) return null;
    return { username, key };
  }

  requireAuth(msg, rinfo) {
    const auth = this.authenticate(msg, rinfo);
    if (!auth) {
      this.stats.authFailures++;
      const hasCreds = findAttr(msg, ATTR.MESSAGE_INTEGRITY);
      this.replyError(
        msg,
        rinfo,
        hasCreds ? 401 : 401,
        'Unauthorized',
      );
      return null;
    }
    return auth;
  }

  onBinding(msg, rinfo) {
    this.reply(
      msg,
      rinfo,
      [
        {
          type: ATTR.XOR_MAPPED_ADDRESS,
          value: encodeXorAddress(rinfo.address, rinfo.port),
        },
      ],
      null,
    );
  }

  onAllocate(msg, rinfo) {
    const auth = this.requireAuth(msg, rinfo);
    if (!auth) return;

    const transport = findAttr(msg, ATTR.REQUESTED_TRANSPORT);
    if (!transport || transport.value.length < 4 || transport.value[0] !== 17) {
      return this.replyError(
        msg,
        rinfo,
        442,
        'Unsupported Transport Protocol',
        auth.key,
      );
    }

    const existing = this.allocations.get(this.keyFor(rinfo));
    if (existing) {
      if (existing.transactionId.equals(msg.transactionId)) {
        this.socket.send(existing.response, rinfo.port, rinfo.address);
        return;
      }
      return this.replyError(msg, rinfo, 437, 'Allocation Mismatch', auth.key);
    }

    const relay = dgram.createSocket('udp4');
    const alloc = {
      client: { address: rinfo.address, port: rinfo.port },
      username: auth.username,
      key: auth.key,
      relay,
      relayPort: 0,
      channels: new Map(),
      permissions: new Map(),
      expiresAt: Date.now() + LIFETIME_SEC * 1000,
      transactionId: msg.transactionId,
      response: null,
      created: Date.now(),
    };

    relay.on('message', (data, peer) => this.onPeerData(alloc, data, peer));
    relay.on('error', () => {});
    relay.bind(0, this.host, () => {
      alloc.relayPort = relay.address().port;
      this.allocations.set(this.keyFor(rinfo), alloc);
      this.stats.allocations++;
      this.stats.activeAllocations = this.allocations.size;

      const response = buildMessage({
        method: METHOD.ALLOCATE,
        cls: CLASS.SUCCESS,
        transactionId: msg.transactionId,
        attrs: [
          {
            type: ATTR.XOR_RELAYED_ADDRESS,
            value: encodeXorAddress(this.host, alloc.relayPort),
          },
          {
            type: ATTR.XOR_MAPPED_ADDRESS,
            value: encodeXorAddress(rinfo.address, rinfo.port),
          },
          { type: ATTR.LIFETIME, value: u32Value(LIFETIME_SEC) },
        ],
        integrityKey: auth.key,
        fingerprint: true,
      });
      alloc.response = response;
      this.socket.send(response, rinfo.port, rinfo.address);
      console.log(
        `[turn] allocation for ${auth.username} ${rinfo.address}:${rinfo.port} relay :${alloc.relayPort}`,
      );
      this.record('allocate');
    });
  }

  onRefresh(msg, rinfo) {
    const auth = this.requireAuth(msg, rinfo);
    if (!auth) return;
    const alloc = this.allocations.get(this.keyFor(rinfo));
    if (!alloc) {
      return this.replyError(msg, rinfo, 437, 'Allocation Mismatch', auth.key);
    }
    const lifetime = attrU32(msg, ATTR.LIFETIME);
    if (lifetime === 0) {
      this.closeAllocation(alloc);
      return this.reply(
        msg,
        rinfo,
        [{ type: ATTR.LIFETIME, value: u32Value(0) }],
        auth.key,
      );
    }
    alloc.expiresAt = Date.now() + LIFETIME_SEC * 1000;
    this.reply(
      msg,
      rinfo,
      [{ type: ATTR.LIFETIME, value: u32Value(LIFETIME_SEC) }],
      auth.key,
    );
  }

  peerAttrs(msg) {
    const peers = [];
    for (const a of msg.attrs) {
      if (a.type === ATTR.XOR_PEER_ADDRESS) {
        const peer = decodeXorAddress(a.value);
        if (peer) peers.push(peer);
      }
    }
    return peers;
  }

  onCreatePermission(msg, rinfo) {
    const auth = this.requireAuth(msg, rinfo);
    if (!auth) return;
    const alloc = this.allocations.get(this.keyFor(rinfo));
    if (!alloc) {
      return this.replyError(msg, rinfo, 437, 'Allocation Mismatch', auth.key);
    }
    const peers = this.peerAttrs(msg);
    if (!peers.length) {
      return this.replyError(msg, rinfo, 400, 'Bad Request', auth.key);
    }
    for (const p of peers) alloc.permissions.set(p.ip, Date.now() + 300000);
    this.reply(msg, rinfo, [], auth.key);
  }

  onChannelBind(msg, rinfo) {
    const auth = this.requireAuth(msg, rinfo);
    if (!auth) return;
    const alloc = this.allocations.get(this.keyFor(rinfo));
    if (!alloc) {
      return this.replyError(msg, rinfo, 437, 'Allocation Mismatch', auth.key);
    }
    const chan = findAttr(msg, ATTR.CHANNEL_NUMBER);
    const peers = this.peerAttrs(msg);
    if (!chan || chan.value.length < 2 || !peers.length) {
      return this.replyError(msg, rinfo, 400, 'Bad Request', auth.key);
    }
    const channel = chan.value.readUInt16BE(0);
    const peer = peers[0];
    for (const [num, b] of alloc.channels) {
      if (b.peer.ip === peer.ip && b.peer.port === peer.port)
        alloc.channels.delete(num);
    }
    alloc.channels.set(channel, { peer, expiresAt: Date.now() + 600000 });
    alloc.permissions.set(peer.ip, Date.now() + 300000);
    this.reply(msg, rinfo, [], auth.key);
  }

  onSendIndication(msg, rinfo) {
    const alloc = this.allocations.get(this.keyFor(rinfo));
    if (!alloc) return;
    const peerAttr = findAttr(msg, ATTR.XOR_PEER_ADDRESS);
    const dataAttr = findAttr(msg, ATTR.DATA);
    if (!peerAttr || !dataAttr) return;
    const peer = decodeXorAddress(peerAttr.value);
    if (!peer) return;
    this.relayToPeer(alloc, peer, dataAttr.value, 'clientToPeer');
  }

  relayToPeer(alloc, peer, payload, direction) {
    if (!this.permissionGranted(alloc, peer)) {
      this.stats.permissionDenied++;
      if (this.stats.permissionDenied < 6) {
        console.log('[turn] permission denied peer', JSON.stringify(peer), 'allocClient', JSON.stringify(alloc.client), 'perms', [...alloc.permissions.keys()]);
      }
      return;
    }
    const wait = this.uplink.schedule(payload.length);
    if (wait === null) return;
    const at = performance.now() + wait;
    this.scheduler.add(at, () => {
      if (!this.allocations.has(`${alloc.client.address}:${alloc.client.port}`))
        return;
      alloc.relay.send(payload, peer.port, peer.ip, () => {});
    });
    this.noteDirection(direction, payload.length);
  }

  onPeerData(alloc, data, peer) {
    if (!this.permissionGranted(alloc, peer)) {
      this.stats.permissionDenied++;
      if (this.stats.permissionDenied < 6) {
        console.log('[turn] rcv denied peer', JSON.stringify(peer), 'allocClient', JSON.stringify(alloc.client), 'perms', [...alloc.permissions.keys()]);
      }
      return;
    }
    const wait = this.downlink.schedule(data.length);
    if (wait === null) return;
    this.noteDirection('peerToClient', data.length);

    let channel = null;
    const now = Date.now();
    for (const [num, b] of alloc.channels) {
      if (b.expiresAt < now) {
        alloc.channels.delete(num);
        continue;
      }
      if (b.peer.ip === peer.address && b.peer.port === peer.port)
        channel = num;
    }

    const at = performance.now() + wait;
    this.scheduler.add(at, () => {
      if (channel !== null) {
        const head = Buffer.alloc(4);
        head.writeUInt16BE(channel, 0);
        head.writeUInt16BE(data.length, 2);
        const out = Buffer.concat([head, data]);
        this.socket.send(
          out,
          alloc.client.port,
          alloc.client.address,
          () => {},
        );
      } else {
        const out = buildMessage({
          method: METHOD.DATA,
          cls: CLASS.INDICATION,
          transactionId: crypto.randomBytes(12),
          attrs: [
            {
              type: ATTR.XOR_PEER_ADDRESS,
              value: encodeXorAddress(peer.address, peer.port),
            },
            { type: ATTR.DATA, value: data },
          ],
          fingerprint: true,
        });
        this.socket.send(
          out,
          alloc.client.port,
          alloc.client.address,
          () => {},
        );
      }
    });
  }

  permissionGranted(alloc, peer) {
    // Peers decoded from XOR-PEER-ADDRESS carry `ip`; UDP rinfo carries
    // `address`. Accept both so relayed packets are not rejected only because
    // of an address-field naming difference.
    const ip = peer.ip ?? peer.address;
    const exp = alloc.permissions.get(ip);
    return exp !== undefined && exp > Date.now();
  }

  noteDirection(direction, bytes) {
    if (direction === 'clientToPeer') {
      this.stats.clientToPeerPackets++;
      this.stats.clientToPeerBytes += bytes;
    } else {
      this.stats.peerToClientPackets++;
      this.stats.peerToClientBytes += bytes;
    }
  }

  closeAllocation(alloc) {
    const key = `${alloc.client.address}:${alloc.client.port}`;
    this.allocations.delete(key);
    this.stats.activeAllocations = this.allocations.size;
    try {
      alloc.relay.close();
    } catch {}
    this.record('close');
  }

  reap() {
    const now = Date.now();
    for (const alloc of [...this.allocations.values()]) {
      if (alloc.expiresAt < now) this.closeAllocation(alloc);
    }
  }

  record(type) {
    this.controlEvents.push({ type, at: Date.now() });
    if (this.controlEvents.length > 200) this.controlEvents.shift();
  }

  configure(profile) {
    const shared = {
      delayMs: profile.delayMs,
      jitterMs: profile.jitterMs,
      lossPct: profile.lossPct,
      maxQueueMs: profile.maxQueueMs,
    };
    this.uplink.configure({
      ...shared,
      rateBps: profile.upKbps ? profile.upKbps * 1000 : 0,
    });
    this.downlink.configure({
      ...shared,
      rateBps: profile.downKbps ? profile.downKbps * 1000 : 0,
    });
    this.record('configure');
    return { up: this.uplink.snapshot(), down: this.downlink.snapshot() };
  }

  startControl() {
    this.control = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const json = (code, obj) => {
        res.writeHead(code, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET,POST',
        });
        return res.end();
      }

      if (url.pathname === '/allocations') {
        const out = [...this.allocations.values()].map((a) => ({
          client: a.client,
          relayPort: a.relayPort,
          permissions: [...a.permissions.entries()],
          channels: [...a.channels.entries()].map(([n, b]) => ({ n, peer: b.peer })),
        }));
        return json(200, { allocations: out });
      }
      if (url.pathname === '/state') {
        return json(200, {
          profile: {
            up: this.uplink.snapshot(),
            down: this.downlink.snapshot(),
          },
          turn: this.stats,
          events: this.controlEvents.slice(-20),
        });
      }
      if (url.pathname === '/reset' && req.method === 'POST') {
        this.uplink.reset();
        this.downlink.reset();
        this.stats.clientToPeerPackets = 0;
        this.stats.clientToPeerBytes = 0;
        this.stats.peerToClientPackets = 0;
        this.stats.peerToClientBytes = 0;
        this.stats.authFailures = 0;
        this.stats.permissionDenied = 0;
        this.record('reset');
        return json(200, { ok: true });
      }
      if (url.pathname === '/shape' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const p = JSON.parse(body || '{}');
            const applied = this.configure(p);
            this.record('shape:' + JSON.stringify(p));
            json(200, { ok: true, applied, requested: p });
          } catch (err) {
            json(400, { error: String(err) });
          }
        });
        return;
      }
      json(404, { error: 'not found' });
    });
    this.control.listen(this.controlPort, this.host, () => {
      console.log(
        `[turn] control http ${this.host}:${this.controlPort} (POST /shape, GET /state)`,
      );
    });
    setInterval(() => this.reap(), 15000).unref();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new TurnServer().start();
  process.on('SIGINT', () => {
    server.control?.close();
    server.socket?.close();
    process.exit(0);
  });
}
