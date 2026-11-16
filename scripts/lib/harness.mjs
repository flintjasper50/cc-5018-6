// Shared plumbing for the experiment harness (not part of the product UI).
//
// Keeps the browser setup in one place: a headless Chrome on the X display for
// the presenter/viewer, plus a CDP attachment to the kiosk fixture that is
// already painting the 1920x1080 desktop.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
export const TURN_CTL = process.env.TURN_CTL || 'http://127.0.0.1:3479';
export const CHROME =
  process.env.CHROME_BIN ||
  '/home/node/.cache/ms-playwright/chromium-1255/chrome-linux-arm64/chrome';
export const XENV = {
  ...process.env,
  DISPLAY: process.env.EXPERIMENT_DISPLAY || ':99',
  LD_LIBRARY_PATH:
    process.env.CHROME_LIBS ||
    '/tmp/rootfs/usr/lib/aarch64-linux-gnu:/tmp/rootfs/lib/aarch64-linux-gnu',
};
export const FIXTURE_CDP = process.env.FIXTURE_CDP || 'http://127.0.0.1:9555';
export const SCREEN = { w: 1920, h: 1080 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// --- TURN shaper control -------------------------------------------------
export async function shape(profile) {
  const res = await fetch(`${TURN_CTL}/shape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error(`shape failed: ${res.status}`);
  return res.json();
}

export async function unshape() {
  return shape({ upKbps: 0, downKbps: 0, delayMs: 0, jitterMs: 0, lossPct: 0 });
}

export async function turnState() {
  const res = await fetch(`${TURN_CTL}/state`);
  return res.json();
}

export async function resetTurn() {
  await fetch(`${TURN_CTL}/reset`, { method: 'POST' });
  await unshape();
}

// --- fixture --------------------------------------------------------------
export async function connectFixture() {
  const browser = await chromium.connectOverCDP(FIXTURE_CDP);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('fixture'));
  if (!page) throw new Error('fixture page not found; run scripts/fixture-up.sh');
  return { browser, page };
}

/**
 * Region of the fixture's calibration strip in *screen* pixels (the coordinate
 * space of the captured desktop), not page CSS pixels. The kiosk window is
 * deliberately positioned above the screen edge to hide Chrome's "for testing"
 * infobar, so the page origin sits at a negative Y offset.
 */
export async function fixtureGeometry(page) {
  return page.evaluate(() => {
    const r = document.getElementById('calib').getBoundingClientRect();
    const chromeY = outerHeight - innerHeight; // infobar/toolbar, hidden offscreen
    return {
      state: window.__fixture.state(),
      // Screen-space top-left of the *page viewport*.
      originX: screenX,
      originY: screenY + chromeY,
      stripScreen: {
        x: Math.round(r.x + screenX),
        y: Math.round(r.y + screenY + chromeY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  });
}

// --- presenter / viewer ---------------------------------------------------
export async function launchBrowser() {
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    env: XENV,
    args: [
      '--no-sandbox',
      '--headless=new',
      '--disable-gpu',
      '--use-fake-ui-for-media-stream',
      '--allow-http-screen-capture',
      '--enable-usermedia-screen-capturing',
      '--auto-select-desktop-capture-source=screen',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
}

export async function openPresenter(browser, { room, ice = 'relay', startLadder = 2, name = '演示者' }) {
  // Match the captured desktop size so getDisplayMedia yields 1:1 pixels and
  // every screen-space measurement maps straight onto the capture.
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    permissions: [],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const q = new URLSearchParams({ room, ice, startLadder: String(startLadder), name });
  await page.goto(`${BASE}/presenter.html?${q}`);
  await page.waitForFunction(() => !!window.__presenter, null, { timeout: 15000 });
  await page.evaluate(() => window.__presenter.join());
  await page.waitForTimeout(600);
  return { ctx, page, errors };
}

export async function openViewer(browser, { room, ice = 'relay', t0Wall, strip, text, screen, region = false, name = '观看者' }) {
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 950 },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const q = new URLSearchParams({ room, ice, name, auto: '1' });
  if (t0Wall) q.set('t0Wall', String(t0Wall));
  if (strip) q.set('strip', strip);
  if (text) q.set('text', text);
  if (screen) q.set('screen', screen);
  if (region) q.set('region', '1');
  await page.goto(`${BASE}/viewer.html?${q}`);
  await page.waitForFunction(() => !!window.__viewer, null, { timeout: 15000 });
  return { ctx, page, errors };
}

// Poll both ends into a single time-aligned row.
export async function sampleBoth(presenterPage, viewerPage) {
  const [pres, view] = await Promise.all([
    presenterPage.evaluate(() => window.__presenter.summary()),
    viewerPage.evaluate(() => window.__viewer.summary()),
  ]);
  return { at: Date.now(), presenter: pres, viewer: view };
}

// Record for `ms`, sampling every `everyMs`, optionally running a hook midway.
export async function record(presenterPage, viewerPage, ms, everyMs = 1000, onTick = null) {
  const rows = [];
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < ms) {
    rows.push(await sampleBoth(presenterPage, viewerPage));
    if (onTick) await onTick(i, Date.now() - start);
    i++;
    await sleep(everyMs);
  }
  return rows;
}

export async function waitForViewerLive(viewerPage, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await viewerPage.evaluate(() => window.__viewer.summary());
    if (s.state === 'live' && s.video.width > 0) return s;
    await sleep(300);
  }
  throw new Error('viewer did not reach live state');
}

// Save a data URL returned by captureRegion/captureFull to disk.
export function saveDataUrl(file, dataUrl) {
  if (!dataUrl) return 0;
  const b64 = dataUrl.split(',')[1];
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(file, buf);
  return buf.length;
}

// --- focus-region verification -------------------------------------------
// The fixture (the real shared screen) draws a solid red block at a known
// page position. The presenter's selection is a screen rectangle, so the block
// has a predictable position inside the region crop. Finding it in the
// *received* region image proves that what the viewer decodes is the content
// under the selection box - not a cached frame, a neighbouring crop, or an
// upscaled full-screen picture.
export async function drawFixtureMarker(fixPage, { x, y, size = 26 } = {}) {
  return fixPage.evaluate(
    ({ x, y, size }) => window.__fixture.markAt(x, y, size),
    { x, y, size },
  );
}

export async function clearFixtureMarker(fixPage) {
  return fixPage.evaluate(() => window.__fixture.clearMark());
}

// Find the red block in a PNG buffer; returns its centroid in 0..1 of the
// image. Requires a saturated red cluster, so ordinary code/chart colours
// (which are never that red) cannot produce a false positive.
export function findRedMarker(buf) {
  const png = PNG.sync.read(buf);
  let sx = 0;
  let sy = 0;
  let n = 0;
  let minX = png.width;
  let maxX = 0;
  let minY = png.height;
  let maxY = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      if (r > 170 && g < 100 && b < 100) {
        sx += x;
        sy += y;
        n++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!n) return null;
  return {
    x: sx / n / png.width,
    y: sy / n / png.height,
    pixels: n,
    spanX: (maxX - minX + 1) / png.width,
    spanY: (maxY - minY + 1) / png.height,
    imgW: png.width,
    imgH: png.height,
  };
}

// Compare the same physical content as delivered by the two strategies.
//
// Both images are resampled to the *same output width* first, so the
// comparison answers "how sharp does this content look at the same size on
// the viewer's screen", not "which image has more pixels". Resampling the
// full-frame crop up cannot invent detail - it stays smooth - while the region
// crop already carries native pixels and stays sharp. That is exactly the
// difference a viewer experiences when they look at the selected area.
export function pngDetail(buf, targetWidth = 720) {
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  if (width < 8 || height < 8) return null;
  const outW = Math.max(8, Math.min(2048, Math.round(targetWidth)));
  const outH = Math.max(8, Math.round((outW * height) / width));
  const lum = new Float32Array(outW * outH);
  // Bilinear sample of the luminance plane.
  for (let y = 0; y < outH; y++) {
    const sy = ((y + 0.5) * height) / outH - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < outW; x++) {
      const sx = ((x + 0.5) * width) / outW - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const l = (px, py) => {
        const p = (py * width + px) * 4;
        return 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      };
      const top = l(x0, y0) * (1 - fx) + l(x1, y0) * fx;
      const bot = l(x0, y1) * (1 - fx) + l(x1, y1) * fx;
      lum[y * outW + x] = top * (1 - fy) + bot * fy;
    }
  }
  let sum = 0;
  let n = 0;
  for (let y = 1; y < outH; y++) {
    for (let x = 1; x < outW; x++) {
      const i = y * outW + x;
      sum += Math.abs(lum[i] - lum[i - 1]) + Math.abs(lum[i] - lum[i - outW]);
      n += 2;
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of lum) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    source: `${width}x${height}`,
    compared: `${outW}x${outH}`,
    detail: n ? sum / n : null,
    contrast: max - min,
  };
}

export function dataUrlDetail(dataUrl, targetWidth) {
  if (!dataUrl) return null;
  return pngDetail(Buffer.from(dataUrl.split(',')[1], 'base64'), targetWidth);
}

export function pct(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))));
  return v[i];
}

export function summarizeLatency(latencies) {
  const v = latencies.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    p50: pct(v, 0.5),
    p95: pct(v, 0.95),
    p99: pct(v, 0.99),
    max: Math.max(...v),
    mean: Number(mean.toFixed(1)),
  };
}
