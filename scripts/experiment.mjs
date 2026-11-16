#!/usr/bin/env node
// End-to-end scenarios for the screen-share stack.
//
// Run with:  node scripts/experiment.mjs --scenario all
//
// Each scenario drives the real presenter and viewer pages through a real TURN
// relay, applies a link profile on that relay, and records what the sender
// actually encoded alongside what the receiver actually decoded. Output goes to
// evidence/<run>/ as JSON plus PNG crops taken from the same screen region at
// both ends, so the two can be compared directly.

import fs from 'node:fs';
import path from 'node:path';
import {
  BASE, ROOT, SCREEN, sleep, stamp, ensureDir, shape, unshape, resetTurn, turnState,
  connectFixture, fixtureGeometry, launchBrowser, openPresenter, openViewer,
  sampleBoth, record, waitForViewerLive, saveDataUrl, summarizeLatency,
} from './lib/harness.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const SCENARIO = arg('scenario', 'all');
const RUN = arg('run', null);
const OUT_DIR = path.join(ROOT, 'evidence', RUN || stamp());

function jitter(x, y, z) {
  return String(x).padStart(y, '0') + (z || '');
}

async function seedFixture(fix, { scrolling = true, speed = 42, chartHz = 12, mode = 'mixed', scrollTo = null } = {}) {
  const info = await fix.page.evaluate(
    (opts) => {
      const f = window.__fixture;
      f.setScrolling(opts.scrolling);
      f.setSpeed(opts.speed);
      f.setChartHz(opts.chartHz);
      f.setMode(opts.mode);
      const st = f.state();
      // Park inside the generated document. Letting the scroll run past the
      // end leaves the editor blank, which would make every readability number
      // meaningless.
      if (opts.scrollTo != null) {
        f.setScroll(Math.max(0, Math.min(st.maxScroll, opts.scrollTo)));
      } else if (st.scrollY > st.maxScroll * 0.85) {
        f.setScroll(st.lineHeight * 40);
      }
      return f.state();
    },
    { scrolling, speed, chartHz, mode, scrollTo },
  );
  await sleep(400);
  return info;
}

// Text region used for readability: a band of the editor body with fine
// comments. Coordinates are relative to the page viewport, then shifted into
// screen space using the fixture's measured origin.
function textRegion(geom) {
  return { x: 66, y: geom.originY + 120, w: 820, h: 300 };
}

async function presetup(fix, { room, startLadder = 2 }) {
  // Clear any profile left behind by an interrupted run *before* the peers
  // connect. The controller's bandwidth estimate starts from whatever the path
  // looks like at connection time; a stale 250 kbps cap makes it begin at the
  // floor and climb for tens of seconds, which would silently contaminate the
  // scenario that follows.
  await resetTurn();
  const geom = await fixtureGeometry(fix.page);
  const browser = await launchBrowser();
  const pres = await openPresenter(browser, { room, startLadder });
  await pres.page.evaluate(() => window.__presenter.startShare());
  await pres.page.waitForFunction(
    () => ['ready', 'live'].includes(window.__presenter.state()),
    null,
    { timeout: 20000 },
  );
  const tr = textRegion(geom);
  const strip = `${geom.stripScreen.x},${geom.stripScreen.y},${geom.stripScreen.w},${geom.stripScreen.h}`;
  const text = `${tr.x},${tr.y},${tr.w},${tr.h}`;
  const view = await openViewer(browser, {
    room,
    t0Wall: Math.round(geom.state.t0EpochMs),
    strip,
    text,
    screen: `${SCREEN.w}x${SCREEN.h}`,
  });
  const live = await waitForViewerLive(view.page, 30000);
  // Let the congestion controller finish its start-up probe before any
  // measurement window begins, otherwise every scenario starts mid-transient.
  await sleep(7000);
  return { geom, browser, pres, view, tr, strip, text, live };
}

// Closing the per-scenario browser occasionally hangs: the page still holds a
// capture or a peer connection, and close() waits for the renderer to unwind.
// The scenario's evidence is already written at this point, so cap the wait and
// SIGKILL the process group rather than letting one stuck close block the rest
// of the suite. Only browsers launched here are touched; the fixture kiosk is a
// separate process and is never closed by the harness.
async function closeBrowser(browser, ms = 5000) {
  const closed = await Promise.race([
    browser.close().then(() => true, () => true),
    sleep(ms).then(() => false),
  ]);
  if (!closed) killChildBrowsers(process.pid);
}

// Playwright does not expose the Chrome handle, so find the browsers it spawned
// under this process and kill them. The fixture kiosk is not our child, so it
// is never matched.
function killChildBrowsers(parentPid) {
  let found = 0;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    // comm may contain spaces; PPid is the field after the closing paren.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (ppid !== parentPid) continue;
    if (!isPlaywrightChrome(Number(name))) continue;
    try {
      process.kill(Number(name), 'SIGKILL');
      found++;
    } catch { /* already gone */ }
  }
  if (found) console.log(`  (forced close: ${found} browser process(es))`);
}

function isPlaywrightChrome(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('playwright_chromiumdev_profile');
  } catch {
    return false;
  }
}

// Wait until the ladder has stopped moving, so a measurement window describes
// a settled rung rather than a transient. Without this the baseline crop can be
// taken while the controller is still climbing from the start rung, which makes
// "no impairment" look like a downgraded session.
async function waitForSteadyRung(page, ms = 30000) {
  const start = Date.now();
  let last = null;
  let since = Date.now();
  while (Date.now() - start < ms) {
    const s = await page.evaluate(() => {
      const a = window.__presenter.summary().adaptive;
      return { rung: a.resolution, probing: !!a.probing };
    });
    // A probe reports the *current* rung while sending at the next one, so a
    // steady reading taken mid-probe does not describe what the frame is.
    if (s.probing || s.rung !== last) {
      last = s.rung;
      since = Date.now();
    } else if (Date.now() - since > 4000) {
      return s.rung;
    }
    await sleep(500);
  }
  return last;
}

async function captureCrops(pres, view, geom, label, textScreen, scale = 1) {
  // Same physical region at both ends: presenter crop is in capture pixels,
  // viewer crop is in decoded pixels, rescaled by the viewer's helper.
  const dir = await ensureDir(OUT_DIR);
  const presFull = await pres.page.evaluate(() => window.__presenter.captureFull());
  saveDataUrl(path.join(dir, `${label}-presenter-full.png`), presFull);
  const viewFull = await view.page.evaluate(() => window.__viewer.captureFull());
  saveDataUrl(path.join(dir, `${label}-viewer-full.png`), viewFull);

  const pc = await pres.page.evaluate(() => {
    const v = document.querySelector('#preview');
    return { w: v.videoWidth, h: v.videoHeight };
  });
  // Screen-space rects must be projected into whatever the capture produced;
  // the capture width can differ from the desktop width when Chrome picks a
  // scaled logical surface.
  const csx = pc.w ? pc.w / SCREEN.w : 1;
  const csy = pc.h ? pc.h / SCREEN.h : 1;
  const vv = await view.page.evaluate(() => {
    const v = document.querySelector('#remote');
    return { w: v.videoWidth, h: v.videoHeight };
  });
  const sx = vv.w && pc.w ? vv.w / pc.w : 1;

  // Calibration strip crop, so block legibility can be inspected at low bitrate.
  const stripPres = await pres.page.evaluate(
    (s) => window.__presenter.captureRegion(s.x, s.y, s.w, s.h),
    {
      x: geom.stripScreen.x * csx,
      y: geom.stripScreen.y * csy,
      w: geom.stripScreen.w * csx,
      h: geom.stripScreen.h * csy,
    },
  );
  saveDataUrl(path.join(dir, `${label}-strip-presenter.png`), stripPres);
  const stripView = await view.page.evaluate(() =>
    window.__viewer.captureRegion(window.__viewer.summary().stripRect),
  );
  saveDataUrl(path.join(dir, `${label}-strip-viewer.png`), stripView);

  // Text crop, scaled into each frame's own pixel space.
  const textPres = await pres.page.evaluate(
    (r) => window.__presenter.captureRegion(r.x, r.y, r.w, r.h),
    textScreen
      ? { x: textScreen.x * csx, y: textScreen.y * csy, w: textScreen.w * csx, h: textScreen.h * csy }
      : { x: 0, y: 0, w: 0, h: 0 },
  );
  saveDataUrl(path.join(dir, `${label}-text-presenter.png`), textPres);
  const vText = await view.page.evaluate(() => {
    const s = window.__viewer.summary();
    return s.textRect;
  });
  const textView = await view.page.evaluate(
    (r) => window.__viewer.captureRegion(r),
    vText,
  );
  saveDataUrl(path.join(dir, `${label}-text-viewer.png`), textView);
  const vStrip = await view.page.evaluate(() => window.__viewer.summary().stripRect);
  return { presFrame: pc, viewFrame: vv, scale: sx, stripRect: vStrip, textRect: vText };
}

async function saveRun(name, payload) {
  const dir = await ensureDir(OUT_DIR);
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(payload, null, 2));
  return path.join(dir, `${name}.json`);
}

function viewLatencies(rows) {
  return rows.flatMap((r) => (r.viewer?.latency?.n ? [r.viewer.latency] : []));
}

function lastOf(rows, get) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = get(rows[i]);
    if (v != null) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scenario 1: baseline quality + latency + text readability, no impairment.
// ---------------------------------------------------------------------------
async function scenarioBaseline(fix, runName) {
  await seedFixture(fix, { scrolling: true, speed: 42, chartHz: 12, mode: 'mixed' });
  const room = `BASE-${Date.now().toString(36)}`;
  const { geom, browser, pres, view, tr, strip, text } = await presetup(fix, { room, startLadder: 3 });
  // Unshaped, the relay is a local loopback and the BWE estimate settles around
  // 4-6 Mbps - right at the 1080p rung's 5000 kbps ceiling. The ladder then
  // oscillates between 900p and 1080p and "baseline" describes a transient.
  // Pin a comfortable profile so the settled state is unambiguous.
  await resetTurn();
  await shape({ upKbps: 25000, downKbps: 25000, delayMs: 5, jitterMs: 0, lossPct: 0 });
  // A baseline must describe the settled, unimpaired state. Wait for the rung
  // to stop changing before cropping or sampling.
  const baselineRung = await waitForSteadyRung(pres.page);

  const crops = await captureCrops(pres, view, geom, 'baseline', tr);
  const rows = await record(pres.page, view.page, 20000, 1000);

  const lat = [];
  for (const r of rows) {
    if (r.viewer.latencyRecent?.p50 != null) lat.push(r.viewer.latencyRecent);
  }
  const allP50 = lat.map((x) => x.p50).filter((x) => Number.isFinite(x));

  const result = {
    scenario: 'baseline',
    room,
    baselineRung,
    geometry: { geom, textRegion: tr, stripParam: strip, textParam: text },
    crops,
    samples: rows,
    latencySummary: {
      // Rows carry a 5 s trailing window; reduce those to a single number here
      // rather than keeping every raw sample in the JSON.
      rowsWithSamples: lat.length,
      p50OfRowP50: allP50.length ? allP50.sort((a, b) => a - b)[(allP50.length - 1) >> 1] : null,
    },
    turn: await turnState(),
  };

  const final = rows[rows.length - 1];
  result.final = {
    presenter: final.presenter,
    viewer: final.viewer,
    encoded: final.presenter.sender && {
      w: final.presenter.sender.encodedWidth,
      h: final.presenter.sender.encodedHeight,
      fps: final.presenter.sender.encodeFps,
      kbps: final.presenter.sender.bytesSentKbps,
    },
    decoded: { w: final.viewer.video.width, h: final.viewer.video.height },
    latency: final.viewer.latencyRecent ?? final.viewer.latency,
    read: final.viewer.read,
  };

  await unshape();
  await saveRun(runName || 'baseline', result);
  await closeBrowser(browser);
  return result;
}

// ---------------------------------------------------------------------------
// Scenario 2: static text vs fast motion. Frame rate must diverge.
// ---------------------------------------------------------------------------
async function scenarioMotion(fix, runName) {
  const room = `MOT-${Date.now().toString(36)}`;
  const { geom, browser, pres, view } = await presetup(fix, { room, startLadder: 2 });
  await resetTurn();

  // --- static: stop scrolling, keep charts slow ---
  await seedFixture(fix, { scrolling: false, speed: 0, chartHz: 1, mode: 'static', scrollTo: 0 });
  // The motion score is an EWMA over 750ms reference frames, so it takes a few
  // seconds to fall after the scroll stops. Measure only once it has settled;
  // otherwise the first sample still carries the previous phase's motion.
  await sleep(9000);
  const staticRows = await record(pres.page, view.page, 9000, 1000);
  const staticCrops = await captureCrops(pres, view, geom, 'motion-static', textRegion(geom));

  // --- fast: scroll + charts at full rate ---
  await seedFixture(fix, { scrolling: true, speed: 120, chartHz: 20, mode: 'scroll' });
  await sleep(3000);
  const fastRows = await record(pres.page, view.page, 9000, 1000);
  const fastCrops = await captureCrops(pres, view, geom, 'motion-fast', textRegion(geom));

  const fpsOf = (rows) => rows.map((r) => r.presenter.sender?.encodeFps ?? 0);
  const result = {
    scenario: 'motion',
    room,
    static: {
      crops: staticCrops,
      encodeFps: fpsOf(staticRows),
      targetFps: staticRows.map((r) => r.presenter.adaptive.targetFps),
      meanMotion: staticRows.reduce((a, r) => a + r.presenter.adaptive.motionScore, 0) / staticRows.length,
      samples: staticRows,
    },
    fast: {
      crops: fastCrops,
      encodeFps: fpsOf(fastRows),
      targetFps: fastRows.map((r) => r.presenter.adaptive.targetFps),
      meanMotion: fastRows.reduce((a, r) => a + r.presenter.adaptive.motionScore, 0) / fastRows.length,
      samples: fastRows,
    },
    conclusion: {
      staticMeanFps: fpsOf(staticRows).reduce((a, b) => a + b, 0) / staticRows.length,
      fastMeanFps: fpsOf(fastRows).reduce((a, b) => a + b, 0) / fastRows.length,
    },
  };
  await saveRun(runName || 'motion', result);
  await closeBrowser(browser);
  return result;
}

// ---------------------------------------------------------------------------
// Scenario 3: bandwidth collapse, then recovery. Verifies that recovery is
// slow (hold-down) and does not slam back to the top rung immediately.
// ---------------------------------------------------------------------------
async function scenarioCongestion(fix, runName) {
  const room = `CONG-${Date.now().toString(36)}`;
  const { geom, browser, pres, view, tr } = await presetup(fix, { room, startLadder: 2 });
  await resetTurn();
  await seedFixture(fix, { scrolling: true, speed: 60, chartHz: 12, mode: 'mixed' });

  const events = [];
  const phaseLog = [];
  const started = Date.now();
  const phase = async (name, apply, ms, opts = {}) => {
    if (apply) await shape(apply);
    events.push({ phase: name, at: Date.now() - started, applied: apply });
    const rows = await record(pres.page, view.page, ms, 1000);
    phaseLog.push({
      name,
      rows,
      first: rows[0],
      last: rows[rows.length - 1],
      ladderSeen: [...new Set(rows.map((r) => r.presenter.adaptive.resolution))],
      upgrades: rows.flatMap((r) => r.presenter.adaptive.historyTail.filter((h) => h.direction === 'upgrade')).length,
    });
    if (opts.crop) await captureCrops(pres, view, geom, name, tr);
    return rows;
  };

  // 0. healthy baseline at a comfortable rate
  await phase('healthy', { upKbps: 6000, downKbps: 6000, delayMs: 20, jitterMs: 5, lossPct: 0 }, 12000);
  // 1. collapse to a rate below the lowest rung
  await phase('collapse-300k', { upKbps: 300, downKbps: 300, delayMs: 60, jitterMs: 25, lossPct: 1 }, 14000, { crop: true });
  // 2. partial recovery, still tight
  await phase('recover-700k', { upKbps: 700, downKbps: 700, delayMs: 40, jitterMs: 15, lossPct: 0 }, 12000, { crop: true });
  // 3. full recovery: must climb gradually, not instantly. Long enough to show
  // several separate rungs with an observation window between each.
  await phase('recover-4000k', { upKbps: 4000, downKbps: 4000, delayMs: 25, jitterMs: 5, lossPct: 0 }, 48000, { crop: true });
  // 4. heavier loss/jitter at moderate rate
  await phase('lossy-1200k', { upKbps: 1200, downKbps: 1200, delayMs: 50, jitterMs: 40, lossPct: 3 }, 14000, { crop: true });

  await unshape();

  const allSamples = phaseLog.flatMap((p) => p.rows);
  // historyTail is a rolling window repeated in every sample, so dedupe by
  // timestamp before reporting the recovery ramp.
  const ups = [...new Map(
    allSamples.flatMap((r) => r.presenter.adaptive.historyTail)
      .filter((h) => h.direction === 'upgrade' && !h.manual)
      .map((h) => [h.at, h]),
  ).values()].sort((a, b) => a.at - b.at);
  const notices = [...new Map(
    allSamples.flatMap((r) => r.presenter.adaptive.noticesTail)
      .map((n) => [`${n.at}:${n.level}`, n]),
  ).values()].sort((a, b) => a.at - b.at).slice(-24);

  const result = {
    scenario: 'congestion',
    room,
    events,
    phases: phaseLog.map((p) => ({
      name: p.name,
      ladderSeen: p.ladderSeen,
      resolutionStart: p.first.presenter.adaptive.resolution,
      resolutionEnd: p.last.presenter.adaptive.resolution,
      estimateStart: p.first.presenter.adaptive.estimateKbps,
      estimateEnd: p.last.presenter.adaptive.estimateKbps,
      encodedStart: [p.first.presenter.sender?.encodedWidth, p.first.presenter.sender?.encodedHeight],
      encodedEnd: [p.last.presenter.sender?.encodedWidth, p.last.presenter.sender?.encodedHeight],
      viewerStateEnd: p.last.viewer.state,
      viewerLatencyEnd: p.last.viewer.latencyRecent ?? p.last.viewer.latency,
      viewerReadEnd: p.last.viewer.read,
      samples: p.rows,
    })),
    upgradesDuringRecovery: ups,
    notices,
    turn: await turnState(),
  };
  await saveRun(runName || 'congestion', result);
  await closeBrowser(browser);
  return result;
}

// ---------------------------------------------------------------------------
// Scenario 4: lifecycle states. Permission denial, source end, signaling loss.
// The viewer must never keep showing the old frame as if it were live.
// ---------------------------------------------------------------------------
async function scenarioStates(fix, runName) {
  const room = `STATE-${Date.now().toString(36)}`;
  const browser = await launchBrowser();

  // --- permission denial (fresh presenter, no stream) ---
  const denyPres = await openPresenter(browser, { room: `${room}-DENY`, startLadder: 4 });
  await denyPres.page.evaluate(() => window.__presenter.simulateDenial());
  await denyPres.page.evaluate(() => window.__presenter.startShare());
  await sleep(1200);
  const denyState = await denyPres.page.evaluate(() => window.__presenter.summary());
  await denyPres.page.evaluate(() => window.__presenter.restoreGetDisplayMedia());

  // --- track ended mid-stream ---
  const { geom, pres, view, tr } = await presetup(fix, { room, startLadder: 3 });
  await resetTurn();
  await waitForViewerLive(view.page, 30000);
  await sleep(3000);
  const beforeEnd = await view.page.evaluate(() => window.__viewer.summary());
  const endCrops = await captureCrops(pres, view, geom, 'states-live', tr);

  await pres.page.evaluate(() => window.__presenter.simulateTrackEnd());
  await sleep(1500);
  const afterEnd = {
    presenter: await pres.page.evaluate(() => window.__presenter.summary()),
    viewer: await view.page.evaluate(() => window.__viewer.summary()),
  };
  const endedVideo = await view.page.evaluate(() => {
    const v = document.querySelector('#remote');
    return {
      hasStream: !!v.srcObject,
      width: v.videoWidth,
      height: v.videoHeight,
      stale: v.classList.contains('stale'),
      overlayVisible: !document.getElementById('overlay').classList.contains('hidden'),
      overlayTitle: document.getElementById('o-title').textContent,
    };
  });
  const endedFull = await view.page.evaluate(() => window.__viewer.captureFull());
  saveDataUrl(path.join(OUT_DIR, 'states-ended-viewer-full.png'), endedFull);

  // --- signaling loss while live (new room, fresh stream) ---
  const room2 = `${room}-SIG`;
  const p2 = await presetup(fix, { room: room2, startLadder: 3 });
  await sleep(2500);
  const sigBefore = await p2.view.page.evaluate(() => window.__viewer.summary());
  await p2.pres.page.evaluate(() => window.__presenter.dropSignaling());
  await sleep(2000);
  const sigAfter = {
    presenter: await p2.pres.page.evaluate(() => window.__presenter.summary()),
    viewer: await p2.view.page.evaluate(() => window.__viewer.summary()),
  };
  const sigVideo = await p2.view.page.evaluate(() => {
    const v = document.querySelector('#remote');
    return {
      hasStream: !!v.srcObject,
      stale: v.classList.contains('stale'),
      overlayTitle: document.getElementById('o-title').textContent,
    };
  });

  const result = {
    scenario: 'states',
    rooms: { denial: `${room}-DENY`, ended: room, signaling: room2 },
    permissionDenied: {
      presenterState: denyState.state,
      hasStream: !!denyState.capture,
    },
    trackEnded: {
      presenterStateBefore: beforeEnd.presenterState,
      viewerStateBefore: beforeEnd.state,
      viewerVideoBefore: beforeEnd.video,
      presenterStateAfter: afterEnd.presenter.state,
      viewerStateAfter: afterEnd.viewer.state,
      viewerVideoAfter: endedVideo,
      cropsBefore: endCrops,
    },
    signalingLost: {
      viewerStateBefore: sigBefore.state,
      presenterStateAfter: sigAfter.presenter.state,
      viewerStateAfter: sigAfter.viewer.state,
      viewerVideoAfter: sigVideo,
    },
  };
  await saveRun(runName || 'states', result);
  await closeBrowser(browser);
  return result;
}

// ---------------------------------------------------------------------------
// Scenario 5: resolution floor. Deliberately pin the ladder to the minimum and
// verify the encoded frame never goes below the declared floor.
// ---------------------------------------------------------------------------
async function scenarioFloor(fix, runName) {
  const room = `FLOOR-${Date.now().toString(36)}`;
  const { geom, browser, pres, view, tr } = await presetup(fix, { room, startLadder: 2 });
  await resetTurn();

  await seedFixture(fix, { scrolling: true, speed: 80, chartHz: 15, mode: 'mixed' });
  // Force the lowest rung, then hold a rate just under what it needs.
  await pres.page.evaluate(() => window.__presenter.forceLadder(8));
  await shape({ upKbps: 250, downKbps: 250, delayMs: 80, jitterMs: 30, lossPct: 2 });
  await sleep(4000);
  const rows = await record(pres.page, view.page, 12000, 1000);
  const crops = await captureCrops(pres, view, geom, 'floor-360p', tr);
  await unshape();

  const encSizes = rows
    .map((r) => r.presenter.sender && [r.presenter.sender.encodedWidth, r.presenter.sender.encodedHeight])
    .filter(Boolean);
  const minH = Math.min(...encSizes.map((s) => s[1]));
  const result = {
    scenario: 'floor',
    room,
    ladder: rows.at(-1).presenter.adaptive,
    crops,
    encodedSizes: encSizes,
    minEncodedHeight: minH,
    floorHeight: 360,
    floorRespected: minH >= 360,
    viewer: rows.at(-1).viewer,
    notices: rows.flatMap((r) => r.presenter.adaptive.noticesTail).slice(-10),
    samples: rows,
  };
  await saveRun(runName || 'floor', result);
  await closeBrowser(browser);
  return result;
}

// ---------------------------------------------------------------------------
async function main() {
  ensureDir(OUT_DIR);
  const fix = await connectFixture();
  const manifest = { startedAt: new Date().toISOString(), scenarios: {} };
  console.log(`evidence dir: ${OUT_DIR}`);

  const wanted = SCENARIO === 'all'
    ? ['baseline', 'motion', 'congestion', 'states', 'floor']
    : SCENARIO.split(',');

  const runners = {
    baseline: scenarioBaseline,
    motion: scenarioMotion,
    congestion: scenarioCongestion,
    states: scenarioStates,
    floor: scenarioFloor,
  };

  try {
    for (const name of wanted) {
      const fn = runners[name];
      if (!fn) {
        console.error(`unknown scenario ${name}`);
        continue;
      }
      console.log(`\n=== ${name} ===`);
      try {
        const res = await fn(fix, name);
        manifest.scenarios[name] = { ok: true, file: `${name}.json` };
        if (name === 'baseline' && res.final) {
          console.log(`  encoded ${res.final.encoded?.w}x${res.final.encoded?.h} ` +
            `fps=${res.final.encoded?.fps} kbps=${res.final.encoded?.kbps}`);
          console.log(`  latency p50=${res.final.latency?.p50} p95=${res.final.latency?.p95}`);
          // Legibility is measured from the saved crop (one frame, one
          // resolution); the viewer's live reading is a trailing average that
          // spans resolution switches.
          const crop = res.final.read;
          console.log(`  read frame=${crop?.frameWidth}x${crop?.frameHeight} ` +
            `decodeOk=${crop?.decodeOk} (crop metrics: scripts/report.mjs)`);
        }
        if (name === 'motion' && res.conclusion) {
          console.log(`  static=${res.conclusion.staticMeanFps.toFixed(1)}fps ` +
            `fast=${res.conclusion.fastMeanFps.toFixed(1)}fps`);
        }
        if (name === 'floor') {
          console.log(`  encoded sizes ${JSON.stringify(res.encodedSizes.slice(-4))} ` +
            `floorRespected=${res.floorRespected}`);
        }
        if (name === 'states') {
          console.log(`  ended: presenter=${res.trackEnded.presenterStateAfter} ` +
            `viewer=${res.trackEnded.viewerStateAfter} stream=${res.trackEnded.viewerVideoAfter.hasStream}`);
          console.log(`  signaling: viewer=${res.signalingLost.viewerStateAfter} ` +
            `stream=${res.signalingLost.viewerVideoAfter.hasStream}`);
        }
      } catch (err) {
        console.error(`  FAILED: ${err.stack || err}`);
        manifest.scenarios[name] = { ok: false, error: String(err) };
      }
    }
  } finally {
    manifest.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // The fixture is a long-lived kiosk browser started by scripts/fixture-up.sh;
    // closing it here would kill the desktop for the next run. Only drop the
    // CDP attachment. close() on a connected (non-launched) browser can hang
    // when the browser stays alive, so cap it and continue regardless.
    await Promise.race([
      fix.browser.close().catch(() => {}),
      sleep(3000),
    ]);
    console.log(`\nmanifest: ${path.join(OUT_DIR, 'manifest.json')}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
