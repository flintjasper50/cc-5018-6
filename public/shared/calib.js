// Machine-readable calibration strip.
//
// The fixture renders a 3x18 grid of high-contrast blocks. The viewer samples
// the same region out of the *received* video and recovers a 44-bit payload:
//
//   bits  0..23  time since fixture start, in 20 ms ticks (wraps every ~5.6 min)
//   bits 24..31  editor scroll offset, in 32 px units
//   bits 32..33  content mode (0 static, 1 scroll, 2 chart, 3 mixed)
//   bits 34..43  sequence counter (10 bits)
//
// A finder pattern (1,0,1,1) in the first four slots and a check pattern
// (0,1,1,0) in the last four slots reject wrong regions and torn frames.
// Blocks are large on purpose so the payload survives VP8/H.264 at low
// bitrates, which is what makes end-to-end latency measurable without OCR.

export const STRIP_COLS = 18;
export const STRIP_ROWS = 3;
export const STRIP_BLOCK_PX = 32;
export const STRIP_QUIET_PX = 8;
export const STRIP_SLOTS = STRIP_COLS * STRIP_ROWS; // 54

export const FINDER = [1, 0, 1, 1];
export const CHECK = [0, 1, 1, 0];
export const PAYLOAD_BITS = 44;

export const MODE_BITS = { static: 0, scroll: 1, chart: 2, mixed: 3 };

export function encodePayload({ ticks, scrollTop, mode, seq }) {
  const scrollUnits = BigInt(Math.floor(scrollTop / 32) & 0xff);
  let value = 0n;
  value |= BigInt(ticks & 0xffffff);
  value |= scrollUnits << 24n;
  value |= BigInt((MODE_BITS[mode] ?? 3) & 0x3) << 32n;
  value |= BigInt(seq & 0x3ff) << 34n;

  const bits = new Array(STRIP_SLOTS).fill(0);
  bits[0] = FINDER[0];
  bits[1] = FINDER[1];
  bits[2] = FINDER[2];
  bits[3] = FINDER[3];
  for (let i = 0; i < PAYLOAD_BITS; i++) {
    const slot = 4 + i;
    bits[slot] = Number((value >> BigInt(PAYLOAD_BITS - 1 - i)) & 1n);
  }
  const checkStart = STRIP_SLOTS - 4;
  for (let i = 0; i < 4; i++) bits[checkStart + i] = CHECK[i];
  return { bits, value };
}

export function decodeBits(bits) {
  if (bits.length !== STRIP_SLOTS) return null;
  const finderOk = FINDER.every((b, i) => bits[i] === b);
  const checkStart = STRIP_SLOTS - 4;
  const checkOk = CHECK.every((b, i) => bits[checkStart + i] === b);
  if (!finderOk || !checkOk) return null;

  let value = 0n;
  for (let i = 0; i < PAYLOAD_BITS; i++) {
    value = (value << 1n) | BigInt(bits[4 + i] ? 1 : 0);
  }
  const ticks = Number(value & 0xffffffn);
  const scrollUnits = Number((value >> 24n) & 0xffn);
  const modeId = Number((value >> 32n) & 0x3n);
  const seq = Number((value >> 34n) & 0x3ffn);
  const mode =
    Object.keys(MODE_BITS).find((k) => MODE_BITS[k] === modeId) ?? 'mixed';
  return { ticks, scrollTop: scrollUnits * 32, mode, seq };
}

// Luminance helper shared by decode and readability metrics.
export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function sampleBlockBits(imageData, box) {
  const { width, height, data } = imageData;
  const bits = [];
  // Accept both {width,height} and {w,h}; call sites use both spellings and a
  // silent NaN here turns every sampled bit into 0, which looks like "strip is
  // all white" rather than a programming error.
  const boxW = box.w ?? box.width;
  const boxH = box.h ?? box.height;
  if (!(boxW > 0) || !(boxH > 0)) throw new Error('sampleBlockBits: empty box');
  const cw = boxW / STRIP_COLS;
  const ch = boxH / STRIP_ROWS;
  const insetX = cw * 0.3;
  const insetY = ch * 0.3;
  for (let row = 0; row < STRIP_ROWS; row++) {
    for (let col = 0; col < STRIP_COLS; col++) {
      const x0 = Math.floor(box.x + col * cw + insetX);
      const x1 = Math.ceil(box.x + (col + 1) * cw - insetX);
      const y0 = Math.floor(box.y + row * ch + insetY);
      const y1 = Math.ceil(box.y + (row + 1) * ch - insetY);
      let sum = 0;
      let n = 0;
      for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
          const i = (y * width + x) * 4;
          sum += luma(data[i], data[i + 1], data[i + 2]);
          n++;
        }
      }
      // A payload bit of 1 is drawn as a dark block, so dark means 1 here.
      // Sampling brightness would invert every field and reject the finder.
      bits.push(n > 0 && sum / n < 127 ? 1 : 0);
    }
  }
  return bits;
}

// Laplacian variance: a blur/sharpness proxy. Higher is sharper.
export function laplacianVariance(imageData) {
  const { width, height, data } = imageData;
  if (width < 3 || height < 3) return 0;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    gray[i] = luma(data[p], data[p + 1], data[p + 2]);
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v =
        4 * gray[i] -
        gray[i - 1] -
        gray[i + 1] -
        gray[i - width] -
        gray[i + width];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function textPixelRatio(imageData, threshold = 128) {
  const { data } = imageData;
  let dark = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = luma(data[i], data[i + 1], data[i + 2]);
    if (l < threshold) dark++;
    total++;
  }
  return total ? dark / total : 0;
}
