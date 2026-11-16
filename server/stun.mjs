import crypto from 'node:crypto';

export const MAGIC_COOKIE = 0x2112a442;

export const CLASS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 };
export const METHOD = {
  BINDING: 0x001,
  ALLOCATE: 0x003,
  REFRESH: 0x004,
  SEND: 0x006,
  DATA: 0x007,
  CREATE_PERMISSION: 0x008,
  CHANNEL_BIND: 0x009,
};

export const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_ADDRESS_FAMILY: 0x0017,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
  FINGERPRINT: 0x8028,
};

export function encodeType(method, cls) {
  return (
    ((method & 0x0f80) << 2) |
    ((method & 0x0070) << 1) |
    (method & 0x000f) |
    ((cls & 0x2) << 7) |
    ((cls & 0x1) << 4)
  );
}

export function decodeType(type) {
  const cls = ((type >> 7) & 0x2) | ((type >> 4) & 0x1);
  const method =
    ((type >> 2) & 0x0f80) | ((type >> 1) & 0x0070) | (type & 0x000f);
  return { method, cls };
}

export function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc(pad)]);
}

export function parseMessage(buf) {
  if (buf.length < 20) return null;
  if ((buf[0] & 0xc0) !== 0) return null;
  const length = buf.readUInt16BE(2);
  if (buf.length < 20 + length) return null;
  if (buf.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  const { method, cls } = decodeType(buf.readUInt16BE(0));
  const transactionId = Buffer.from(buf.subarray(8, 20));
  const attrs = [];
  let off = 20;
  const end = 20 + length;
  while (off + 4 <= end) {
    const type = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    if (off + 4 + len > end) break;
    attrs.push({
      type,
      value: buf.subarray(off + 4, off + 4 + len),
      start: off,
      end: off + 4 + ((len + 3) & ~3),
    });
    off += 4 + ((len + 3) & ~3);
  }
  return {
    method,
    cls,
    transactionId,
    attrs,
    raw: Buffer.from(buf.subarray(0, end)),
  };
}

export function findAttr(msg, type) {
  return msg.attrs.find((a) => a.type === type);
}

export function attrString(msg, type) {
  const a = findAttr(msg, type);
  return a ? a.value.toString('utf8') : null;
}

export function attrU32(msg, type) {
  const a = findAttr(msg, type);
  return a && a.value.length === 4 ? a.value.readUInt32BE(0) : null;
}

function xorPort(port) {
  return port ^ (MAGIC_COOKIE >>> 16);
}

export function encodeXorAddress(ip, port) {
  const parts = ip.split('.').map(Number);
  const v = Buffer.alloc(8);
  v[0] = 0;
  v[1] = 0x01;
  v.writeUInt16BE(xorPort(port), 2);
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(MAGIC_COOKIE, 0);
  for (let i = 0; i < 4; i++) v[4 + i] = parts[i] ^ cookie[i];
  return v;
}

export function decodeXorAddress(attrVal) {
  if (!attrVal || attrVal.length < 8) return null;
  const family = attrVal[1];
  if (family !== 0x01) return null;
  const port = attrVal.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(MAGIC_COOKIE, 0);
  const ip = [0, 1, 2, 3].map((i) => attrVal[4 + i] ^ cookie[i]).join('.');
  return { ip, port };
}

export function encodeErrorCode(code, reason) {
  const cls = Math.floor(code / 100);
  const num = code % 100;
  const head = Buffer.from([0, 0, cls & 0xff, num & 0xff]);
  return Buffer.concat([head, Buffer.from(reason, 'utf8')]);
}

export function decodeErrorCode(val) {
  if (!val || val.length < 4) return null;
  const cls = val[2] & 0x07;
  const num = val[3];
  return { code: cls * 100 + num, reason: val.subarray(4).toString('utf8') };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function longTermKey(username, realm, password) {
  return crypto
    .createHash('md5')
    .update(`${username}:${realm}:${password}`, 'utf8')
    .digest();
}

export function verifyIntegrity(msg, key) {
  const mi = findAttr(msg, ATTR.MESSAGE_INTEGRITY);
  if (!mi || mi.value.length !== 20) return false;
  const head = Buffer.from(msg.raw.subarray(0, mi.start));
  head.writeUInt16BE(mi.start - 20 + 24, 2);
  const mac = crypto.createHmac('sha1', key).update(head).digest();
  return crypto.timingSafeEqual(mac, mi.value);
}

export function buildMessage({
  method,
  cls,
  transactionId,
  attrs = [],
  integrityKey = null,
  fingerprint = false,
}) {
  const body = Buffer.concat(attrs.map((a) => attr(a.type, a.value)));
  const header = Buffer.alloc(20);
  header.writeUInt16BE(encodeType(method, cls), 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  let msg = Buffer.concat([header, body]);

  if (integrityKey) {
    msg.writeUInt16BE(body.length + 24, 2);
    const mac = crypto.createHmac('sha1', integrityKey).update(msg).digest();
    msg = Buffer.concat([msg, attr(ATTR.MESSAGE_INTEGRITY, mac)]);
  }
  if (fingerprint) {
    msg.writeUInt16BE(msg.length - 20 + 8, 2);
    const crc = (crc32(msg) ^ 0x5354554e) >>> 0;
    const v = Buffer.alloc(4);
    v.writeUInt32BE(crc, 0);
    msg = Buffer.concat([msg, attr(ATTR.FINGERPRINT, v)]);
  }
  return msg;
}

export function textValue(str) {
  return Buffer.from(str, 'utf8');
}

export function u32Value(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
