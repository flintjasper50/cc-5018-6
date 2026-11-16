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
  drawFixtureMarker, clearFixtureMarker, findRedMarker, dataUrlDetail,
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
// Scenario 6: focus region. Verifies that the region track carries genuinely
// more pixels for the selected content than the full-screen rung does, that the
// received crop matches the selection box, and that every lifecycle edge
// (high-density source, window resize, source close, region crossing the
// boundary, viewer switching back to full screen) is handled without leaving a
// stale stream behind.
// ---------------------------------------------------------------------------
async function scenarioRegion(fix, runName) {
  const room = `REG-${Date.now().toString(36)}`;
  await seedFixture(fix, { scrolling: true, speed: 42, chartHz: 12, mode: 'mixed' });
  const geom = await fixtureGeometry(fix.page);
  const browser = await launchBrowser();
  const pres = await openPresenter(browser, { room, startLadder: 3 });
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
    region: true,
  });
  await waitForViewerLive(view.page, 30000);
  await resetTurn();
  // Comfortable, settled path so the comparison is about the region strategy,
  // not about congestion.
  await shape({ upKbps: 25000, downKbps: 25000, delayMs: 5, jitterMs: 0, lossPct: 0 });
  const baselineRung = await waitForSteadyRung(pres.page);

  const cap = await pres.page.evaluate(() => {
    const v = document.querySelector('#preview');
    return { w: v.videoWidth, h: v.videoHeight };
  });
  // Screen-space -> capture-space scale. On a 1:1 monitor capture this is 1,
  // but a scaled logical surface changes it, and a crop that ignored the scale
  // would select the wrong content.
  const csx = cap.w ? cap.w / SCREEN.w : 1;
  const csy = cap.h ? cap.h / SCREEN.h : 1;
  const regionScreen = { x: tr.x, y: tr.y, w: 900, h: 430 };
  const regionCapture = {
    x: regionScreen.x * csx,
    y: regionScreen.y * csy,
    w: regionScreen.w * csx,
    h: regionScreen.h * csy,
  };

  const dir = await ensureDir(OUT_DIR);
  const label = 'region-selected';

  // ---- 0. baseline cost of the untouched whole-screen mode ----------------
  // The cost of region mode is only meaningful against what the same physical
  // content costs in the original full-screen strategy. Sample that first.
  const fullOnly = await measureBoth(pres.page, view.page, 6000);

  // ---- 1. select, wait for the region track to actually encode -----------
  await pres.page.evaluate(() => window.__presenter.setSendMode('region'));
  const plan = await pres.page.evaluate(
    (r) => window.__presenter.setRegionPixels(r),
    regionCapture,
  );
  await sleep(4500);
  const selSummary = await sampleBoth(pres.page, view.page);
  const presRegion = await pres.page.evaluate(() => window.__presenter.region());
  const viewRegion = await view.page.evaluate(() => window.__viewer.regionSummary());
  // Same content, now with both m-lines live: this is the actual bandwidth the
  // region strategy adds, measured, not inferred from a bitrate setting.
  const bothModes = await measureBoth(pres.page, view.page, 6000);

  // ---- 2. correspondence: red block at a known point in the crop ---------
  // Page coordinates == screen coordinates minus the page origin, and the
  // presenter's capture is 1:1 with the screen here.
  const markPage = {
    x: (regionCapture.x + regionCapture.w * 0.5) / csx - geom.originX,
    y: (regionCapture.y + regionCapture.h * 0.35) / csy - geom.originY,
  };
  const markRect = await drawFixtureMarker(fix.page, { x: markPage.x, y: markPage.y, size: 26 });
  // The marker must land inside the selected content; wait long enough for the
  // capture, the region pipeline and the receiver to all carry it.
  await sleep(1600);
  const presCrop = await pres.page.evaluate(
    (r) => window.__presenter.captureRegion(r.x, r.y, r.w, r.h),
    regionCapture,
  );
  const viewCrop = await view.page.evaluate(() => window.__viewer.captureRegionFrame());
  const viewFull = await view.page.evaluate(() => window.__viewer.captureFull());
  saveDataUrl(path.join(dir, `${label}-presenter-preview-crop.png`), presCrop);
  saveDataUrl(path.join(dir, `${label}-viewer-region.png`), viewCrop);
  saveDataUrl(path.join(dir, `${label}-viewer-full.png`), viewFull);
  const markerExpected = {
    // Region rect is in capture space; the marker is returned in page space.
    // Shift the page position back by the page origin before projecting.
    x: ((markRect.x + geom.originX) * csx - regionCapture.x) / regionCapture.w,
    y: ((markRect.y + geom.originY) * csy - regionCapture.y) / regionCapture.h,
  };
  const markerInRegion = viewCrop ? findRedMarker(Buffer.from(viewCrop.split(',')[1], 'base64')) : null;
  const markerInPreview = presCrop ? findRedMarker(Buffer.from(presCrop.split(',')[1], 'base64')) : null;
  // A red block that is *not* in the selected content: it sits just outside
  // the right edge. If the crop were silently widened, or showed the whole
  // screen scaled up, this block would appear too.
  const outsidePage = {
    x: (regionCapture.x + regionCapture.w + 60) / csx - geom.originX,
    y: (regionCapture.y + regionCapture.h * 0.6) / csy - geom.originY,
  };
  const outsideRect = await drawFixtureMarker(fix.page, {
    x: outsidePage.x,
    y: outsidePage.y,
    size: 26,
  });
  await sleep(1600);
  const viewCrop2 = await view.page.evaluate(() => window.__viewer.captureRegionFrame());
  saveDataUrl(path.join(dir, `${label}-viewer-region-outside-mark.png`), viewCrop2);
  const outsideInRegion = viewCrop2
    ? findRedMarker(Buffer.from(viewCrop2.split(',')[1], 'base64'))
    : null;
  await clearFixtureMarker(fix.page);

  // ---- 3. high pixel-density source -------------------------------------
  // Shrink the glyphs inside the same row pitch. The full-screen rung cannot
  // follow within a constrained budget; the region crop, which keeps native
  // pixels, can. Pin a budget where the full stream is forced down a rung, so
  // the comparison is not two streams that are both already lossless.
  const zoom = await fix.page.evaluate(() => window.__fixture.setHighZoom(true));
  await shape({ upKbps: 1400, downKbps: 1400, delayMs: 15, jitterMs: 2, lossPct: 0 });
  const zoomRung = await waitForSteadyRung(pres.page, 25000);
  await sleep(2500);
  const zoomRows = await measureBoth(pres.page, view.page, 8000);
  const zoomRegion = await pres.page.evaluate(() => window.__presenter.region());
  const zoomPresCrop = await pres.page.evaluate(
    (r) => window.__presenter.captureRegion(r.x, r.y, r.w, r.h),
    regionCapture,
  );
  const zoomViewCrop = await view.page.evaluate(() => window.__viewer.captureRegionFrame());
  const zoomViewFull = await view.page.evaluate(() => window.__viewer.captureFull());
  // The same physical region as delivered inside the whole-screen frame. This
  // is the fair comparison: identical content, two different transmit
  // strategies.
  const zoomFullRegion = await view.page.evaluate((r) => {
    const v = document.querySelector('#remote');
    const sx = v.videoWidth / 1920;
    const sy = v.videoHeight / 1080;
    return window.__viewer.captureRegion({
      x: r.x * sx,
      y: r.y * sy,
      w: r.w * sx,
      h: r.h * sy,
    });
  }, regionScreen);
  saveDataUrl(path.join(dir, 'region-highdensity-viewer-full-samecrop.png'), zoomFullRegion);
  saveDataUrl(path.join(dir, 'region-highdensity-presenter-preview.png'), zoomPresCrop);
  saveDataUrl(path.join(dir, 'region-highdensity-viewer-region.png'), zoomViewCrop);
  saveDataUrl(path.join(dir, 'region-highdensity-viewer-full.png'), zoomViewFull);
  // Legibility numbers from the *received* pixels. The region crop and the
  // full frame cover different extents, so the comparison is grid-normalized
  // detail (see pngDetail), not a raw pixel count.
  const zoomSharp = {
    region: dataUrlDetail(zoomViewCrop),
    fullSameCrop: dataUrlDetail(zoomFullRegion),
    preview: dataUrlDetail(zoomPresCrop),
  };
  await fix.page.evaluate(() => window.__fixture.setHighZoom(false));
  await unshape();
  await shape({ upKbps: 25000, downKbps: 25000, delayMs: 5, jitterMs: 0, lossPct: 0 });
  await sleep(2000);
  const restoredRung = await waitForSteadyRung(pres.page, 20000);

  // ---- 4. capture resize under the selection -----------------------------
  // Shrink the *live* capture in place. A monitor capture does not follow the
  // kiosk window's size and re-requesting it ignores a smaller constraint, so
  // this is the only transition that actually changes the source dimensions.
  // The selection is normalized, so it must re-project onto the smaller frame
  // and keep sending the same content - not the same pixel rectangle.
  const beforeResize = await pres.page.evaluate(() => window.__presenter.region());
  const resizeCapBefore = await pres.page.evaluate(() => window.__presenter.summary().capture);
  await pres.page.evaluate(() => window.__presenter.resizeCapture(1280, 720));
  await pres.page.waitForFunction(
    () => (document.querySelector('#preview')?.videoWidth ?? 0) === 1280,
    null,
    { timeout: 15000 },
  ).catch(() => {});
  await sleep(3500);
  const resizeCapAfter = await pres.page.evaluate(() => window.__presenter.summary().capture);
  const afterResize = await pres.page.evaluate(() => window.__presenter.region());
  const resizeView = await view.page.evaluate(() => window.__viewer.regionSummary());
  const resizeTrack = await pres.page.evaluate(() => window.__presenter.regionTrack());
  const resizePresCrop = await pres.page.evaluate(() => {
    const c = window.__presenter.region()?.plan?.crop;
    return c ? window.__presenter.captureRegion(c.x, c.y, c.w, c.h) : null;
  });
  const resizeViewCrop = await view.page.evaluate(() => window.__viewer.captureRegionFrame());
  saveDataUrl(path.join(dir, 'region-resized-presenter-preview.png'), resizePresCrop);
  saveDataUrl(path.join(dir, 'region-resized-viewer-region.png'), resizeViewCrop);
  // Restore 1920x1080 for the remaining steps.
  await pres.page.evaluate(() => window.__presenter.resizeCapture(1920, 1080));
  await pres.page.waitForFunction(
    () => (document.querySelector('#preview')?.videoWidth ?? 0) >= 1900,
    null,
    { timeout: 15000 },
  ).catch(() => {});
  await sleep(3000);
  const restoredCap = await pres.page.evaluate(() => window.__presenter.summary().capture);

  // ---- 4b. the framed content moves out from under the selection --------
  // A crop rectangle can stay perfectly valid in coordinates while the content
  // it used to show is gone. Moving the fixture window down exposes the empty
  // desktop where the selection used to be; the presenter must notice and stop
  // sending the region rather than keep encoding whatever is now there.
  const beforeMoveBytes = await readRegionSenderBytes(pres.page);
  const beforeMove = await pres.page.evaluate(() => ({
    region: window.__presenter.region(),
    track: window.__presenter.regionTrack(),
  }));
  const moved = await moveFixtureWindow(fix, { left: 0, top: 620, width: 1920, height: 1116 });
  await sleep(6000);
  const afterMove = await pres.page.evaluate(() => ({
    region: window.__presenter.region(),
    track: window.__presenter.regionTrack(),
    debug: window.__presenter.regionDebug(),
  }));
  const moveBytes1 = await readRegionSenderBytes(pres.page);
  await sleep(3000);
  const moveBytes2 = await readRegionSenderBytes(pres.page);
  const moveViewer = await view.page.evaluate(() => window.__viewer.regionSummary());
  const movePresCrop = await pres.page.evaluate(() => {
    const c = window.__presenter.region()?.plan?.crop;
    return c ? window.__presenter.captureRegion(c.x, c.y, c.w, c.h) : null;
  });
  saveDataUrl(path.join(dir, 'region-content-lost-presenter-preview.png'), movePresCrop);
  // Put the source back where it was: the region must resume on its own,
  // without the presenter having to re-select.
  await restoreFixtureWindow(moved);
  await sleep(6000);
  const afterRestore = await pres.page.evaluate(() => ({
    region: window.__presenter.region(),
    track: window.__presenter.regionTrack(),
    debug: window.__presenter.regionDebug(),
  }));
  const restoreViewer = await view.page.evaluate(() => window.__viewer.regionSummary());
  const restoreBytes1 = await readRegionSenderBytes(pres.page);
  await sleep(2500);
  const restoreBytes2 = await readRegionSenderBytes(pres.page);
  const restoreViewCrop = await view.page.evaluate(() => window.__viewer.captureRegionFrame());
  saveDataUrl(path.join(dir, 'region-content-restored-viewer.png'), restoreViewCrop);

  // ---- 5. selection crossing the source boundary ------------------------
  // A rectangle half outside the captured source must be clamped, and the
  // portion outside must never be captured (no black padding with new content).
  const overshoot = await pres.page.evaluate(() => {
    const v = document.querySelector('#preview');
    return window.__presenter.setRegionPixels({
      x: v.videoWidth - 220,
      y: v.videoHeight - 180,
      w: 600,
      h: 500,
    });
  });
  await sleep(2500);
  const overshootCrop = await view.page.evaluate(() => window.__viewer.captureRegionFrame());
  const overshootDbg = await pres.page.evaluate(() => window.__presenter.regionDebug());
  const overshootPresCrop = await pres.page.evaluate(() => {
    const c = window.__presenter.region()?.plan?.crop;
    return c ? window.__presenter.captureRegion(c.x, c.y, c.w, c.h) : null;
  });
  saveDataUrl(path.join(dir, 'region-boundary-viewer.png'), overshootCrop);
  saveDataUrl(path.join(dir, 'region-boundary-presenter-preview.png'), overshootPresCrop);

  // ---- 6. viewer switches back to full screen: cleanup must be complete ---
  // Sample the region sender's bytesSent before and after the drop. A sender
  // that merely *looks* detached can still emit retransmits; the counter
  // proves whether bytes actually stopped. The before-drop delta is the
  // control: it shows the m-line *was* flowing, so a zero delta afterwards
  // means the drop stopped it rather than that it never carried anything.
  const preDropBytes = await readRegionSenderBytes(pres.page);
  await sleep(2500);
  const preDropBytes2 = await readRegionSenderBytes(pres.page);
  const drop = await view.page.evaluate(() => window.__viewer.requestRegion(false));
  await sleep(1500);
  const postDropDebug = await pres.page.evaluate(() => window.__presenter.regionDebug());
  const dropRegion = await pres.page.evaluate(() => window.__presenter.region());
  const b1 = await readRegionSenderBytes(pres.page);
  await sleep(3000);
  const b2 = await readRegionSenderBytes(pres.page);
  await sleep(3000);
  const b3 = await readRegionSenderBytes(pres.page);
  const dropView = await view.page.evaluate(() => window.__viewer.regionSummary());
  const regionBytes = (x) => x?.region?.bytesSent ?? null;
  const fullBytes = (x) => x?.full?.bytesSent ?? null;
  const regionDelta = (a, b) =>
    regionBytes(a) != null && regionBytes(b) != null ? regionBytes(b) - regionBytes(a) : null;
  // ---- 7. rapid re-selection must not leak an old stream -----------------
  await view.page.evaluate(() => window.__viewer.requestRegion(true));
  await sleep(1500);
  const rapid = [];
  for (const r of [
    { x: tr.x, y: tr.y, w: 600, h: 300 },
    { x: tr.x + 300, y: tr.y + 120, w: 800, h: 420 },
    { x: tr.x, y: tr.y, w: 720, h: 380 },
  ]) {
    rapid.push(
      await pres.page.evaluate(
        (rr) => window.__presenter.setRegionPixels(rr),
        { x: r.x * csx, y: r.y * csy, w: r.w * csx, h: r.h * csy },
      ),
    );
    await sleep(350);
  }
  const rapidDbg = await pres.page.evaluate(() => window.__presenter.regionDebug());
  const rapidTrack = await pres.page.evaluate(() => window.__presenter.regionTrack());
  await sleep(2500);
  const rapidView = await view.page.evaluate(() => window.__viewer.regionSummary());
  const rapidPresCrop = await pres.page.evaluate(() => {
    const c = window.__presenter.region()?.plan?.crop;
    return c ? window.__presenter.captureRegion(c.x, c.y, c.w, c.h) : null;
  });
  const rapidViewCrop = await view.page.evaluate(() => window.__viewer.captureRegionFrame());
  saveDataUrl(path.join(dir, 'region-reselected-viewer.png'), rapidViewCrop);
  // Only one region m-line may exist, and only one region sender may have a
  // track. Two would mean the earlier selection left a stream running.
  const mids = await pres.page.evaluate(() => window.__presenter.regionDebug());
  const decoderCount = await view.page.evaluate(() => {
    const s = window.__viewer.summary();
    return { videoMid: s.video?.mid ?? null, hasRegion: !!window.__viewer.regionSummary().hasTrack };
  });

  // ---- 8. source close while region mode is active -----------------------
  const closeBefore = await pres.page.evaluate(() => window.__presenter.summary());
  await pres.page.evaluate(() => window.__presenter.simulateTrackEnd());
  await sleep(2000);
  const closeAfter = {
    presenter: await pres.page.evaluate(() => window.__presenter.summary()),
    viewer: await view.page.evaluate(() => window.__viewer.summary()),
    viewerRegion: await view.page.evaluate(() => window.__viewer.regionSummary()),
    debug: await pres.page.evaluate(() => window.__presenter.regionDebug()),
  };
  await unshape();

  const result = {
    scenario: 'region',
    room,
    baselineRung,
    capture: cap,
    geometry: { geom, textRegion: tr, regionScreen, regionCapture },
    cost: {
      fullOnly,
      bothModes,
    },
    correctness: {
      plan,
      presenter: presRegion,
      viewer: viewRegion,
      sample: selSummary,
    },
    correspondence: {
      expected: markerExpected,
      inRegion: markerInRegion,
      inPreview: markerInPreview,
      outsideMarkRect: outsideRect,
      outsideInRegion,
      // Centroid distance in normalized crop coordinates. The marker is a
      // solid block spanning ~3% of the crop, so anything under that is the
      // same block, not a coincidental patch of colour.
      dRegion:
        markerInRegion && markerExpected
          ? Math.hypot(markerInRegion.x - markerExpected.x, markerInRegion.y - markerExpected.y)
          : null,
      dPreview:
        markerInPreview && markerExpected
          ? Math.hypot(markerInPreview.x - markerExpected.x, markerInPreview.y - markerExpected.y)
          : null,
    },
    highDensity: {
      zoom,
      // The ladder's label is not the encoded size: under a hard budget the
      // encoder can deliver well below the rung it names. Record what the
      // outbound stream actually reported.
      constrainedRung: zoomRung,
      constrainedEncoded: zoomRows.fullEncoded,
      restoredRung,
      rows: zoomRows,
      region: zoomRegion,
      sharpness: zoomSharp,
      // Linear pixel density of the region crop versus the same content in the
      // full stream at the constrained rung. This is a capability comparison,
      // not an upscaling claim: the region pixels are native, the full-stream
      // allocation is what that content gets inside a downscaled frame.
      regionSharpness: zoomSharp.region?.detail ?? null,
      fullSharpness: zoomSharp.fullSameCrop?.detail ?? null,
      sharpnessRatio:
        zoomSharp.region?.detail && zoomSharp.fullSameCrop?.detail
          ? Number((zoomSharp.region.detail / zoomSharp.fullSameCrop.detail).toFixed(2))
          : null,
    },
    resize: {
      captureBefore: resizeCapBefore,
      captureAfter: resizeCapAfter,
      restoredCapture: restoredCap,
      before: beforeResize,
      after: afterResize,
      track: resizeTrack,
      viewer: resizeView,
    },
    contentLost: {
      moved,
      before: beforeMove,
      after: afterMove,
      beforeMoveBytes,
      moveBytes: [moveBytes1, moveBytes2],
      regionByteDeltaAfterPause:
        moveBytes1?.region?.bytesSent != null && moveBytes2?.region?.bytesSent != null
          ? moveBytes2.region.bytesSent - moveBytes1.region.bytesSent
          : null,
      viewer: moveViewer,
      restored: afterRestore,
      restoredViewer: restoreViewer,
      restoredRegionByteDelta:
        restoreBytes1?.region?.bytesSent != null && restoreBytes2?.region?.bytesSent != null
          ? restoreBytes2.region.bytesSent - restoreBytes1.region.bytesSent
          : null,
    },
    boundary: {
      plan: overshoot,
      debug: overshootDbg,
    },
    viewerFullscreen: {
      request: drop,
      regionOnPresenter: dropRegion,
      debug: postDropDebug,
      viewer: dropView,
      bytes: {
        preDrop: preDropBytes,
        preDropLater: preDropBytes2,
        immediatelyAfter: b1,
        after3s: b2,
        after6s: b3,
        regionDeltaBeforeDrop: regionDelta(preDropBytes, preDropBytes2),
        regionDeltaFirst3s: regionDelta(b1, b2),
        regionDeltaLast3s: regionDelta(b2, b3),
        fullDeltaLast3s:
          fullBytes(b2) != null && fullBytes(b3) != null ? fullBytes(b3) - fullBytes(b2) : null,
      },
    },
    rapidReselect: {
      stepped: rapid,
      debug: rapidDbg,
      track: rapidTrack,
      viewer: rapidView,
      mids,
      decoderCount,
    },
    sourceClose: {
      before: closeBefore.state,
      presenter: closeAfter.presenter.state,
      viewer: closeAfter.viewer.state,
      viewerVideo: closeAfter.viewer.video,
      viewerRegion: closeAfter.viewerRegion,
      regionDebug: closeAfter.debug,
    },
  };
  const pick = (m) => m ?? null;
  result.conclusion = {
    regionEncoded: `${presRegion.measured?.encodedWidth ?? '?'}x${presRegion.measured?.encodedHeight ?? '?'}`,
    fullAtSameContent: presRegion.fullAllocation
      ? `${presRegion.fullAllocation.w}x${presRegion.fullAllocation.h}`
      : null,
    // The full stream's own encoded size during that same window. Without it
    // the allocation above is ambiguous: 901x430 means "native" when the full
    // stream is at 1920x1080 and "downscaled" when it is at 1280x720.
    fullEncodedAtSample: bothModes.fullEncoded,
    linearGain: presRegion.comparison?.linearGain ?? null,
    // Measured bandwidth of each m-line while both were live.
    measuredKbps: {
      fullOnly: pick(bothModes.fullMedianKbps),
      full: pick(bothModes.fullMedianKbps),
      region: pick(bothModes.regionMedianKbps),
      total: pick(bothModes.totalMedianKbps),
    },
    costRatio: bothModes.totalMedianKbps && bothModes.fullOnlyMedianKbps
      ? Number((bothModes.totalMedianKbps / bothModes.fullOnlyMedianKbps).toFixed(2))
      : null,
    correspondenceOk:
      result.correspondence.dRegion != null && result.correspondence.dRegion < 0.05,
    // The block 60 px to the right of the selection must NOT be in the crop.
    outsideExcluded: result.correspondence.outsideInRegion == null,
    viewerDroppedTrack:
      !dropView.want && !dropView.hasTrack && !postDropDebug?.regionSenderHasTrack,
    cleanupStoppedBytes:
      result.viewerFullscreen.bytes.regionDeltaLast3s != null
        ? result.viewerFullscreen.bytes.regionDeltaLast3s === 0
        : null,
    // The control that makes the zero meaningful: the same m-line demonstrably
    // carried bytes immediately before the drop.
    regionWasFlowing:
      (result.viewerFullscreen.bytes.regionDeltaBeforeDrop ?? 0) > 0,
    resizeRecomputed:
      resizeCapAfter?.width > 0 && afterResize?.plan?.crop
        ? afterResize.plan.crop.w <= resizeCapAfter.width &&
          afterResize.plan.crop.h <= resizeCapAfter.height
        : null,
    // The watchdog must actually stop the stream when the framed content goes
    // away, and must resume when it comes back.
    contentLostPaused: afterMove.region?.paused === true,
    contentLostStoppedBytes: result.contentLost.regionByteDeltaAfterPause === 0,
    contentRestoredResumed:
      afterRestore.region?.paused === false &&
      (result.contentLost.restoredRegionByteDelta ?? 0) > 0,
    singleRegionSender:
      mids?.regionMid != null && decoderCount?.hasRegion === true,
    sourceCloseClean:
      closeAfter.presenter.state === 'ended' &&
      !closeAfter.debug?.regionSenderHasTrack,
  };
  await saveRun(runName || 'region', result);
  await closeBrowser(browser);
  return result;
}

// Sample both ends for `ms` and reduce the region-relevant rates to medians.
// Medians, not means: the first samples after a mode change still describe the
// previous setup.
async function measureBoth(presPage, viewPage, ms) {
  const rows = await record(presPage, viewPage, ms, 1000);
  const nonZero = (xs) => xs.filter((x) => Number.isFinite(x) && x > 0);
  const medianOf = (xs) => {
    const v = nonZero(xs).sort((a, b) => a - b);
    return v.length ? v[(v.length - 1) >> 1] : null;
  };
  const fullKbps = rows.map((r) => r.presenter.sender?.bytesSentKbps ?? null);
  // `sample.region` is the published stats object: region rates are top-level
  // there, while the full snapshot nests them under `measured`.
  const regionKbps = rows.map(
    (r) => r.presenter.region?.kbps ?? r.presenter.region?.measured?.kbps ?? null,
  );
  const viewRegionKbps = rows.map((r) => r.viewer.region?.stats?.kbps ?? null);
  const total = rows.map((r) => {
    const f = r.presenter.sender?.bytesSentKbps;
    const g = r.presenter.region?.kbps ?? r.presenter.region?.measured?.kbps;
    return Number.isFinite(f) && Number.isFinite(g) ? f + g : null;
  });
  return {
    rows,
    fullOnlyMedianKbps: medianOf(fullKbps),
    fullMedianKbps: medianOf(fullKbps),
    regionMedianKbps: medianOf(regionKbps),
    regionViewerMedianKbps: medianOf(viewRegionKbps),
    totalMedianKbps: regionKbps.some((x) => Number.isFinite(x))
      ? medianOf(total)
      : medianOf(fullKbps),
    regionBpp: medianOf(
      rows.map((r) => r.presenter.region?.bpp ?? r.presenter.region?.measured?.bpp ?? null),
    ),
    regionEncodeFps: medianOf(
      rows.map(
        (r) => r.presenter.region?.encodeFps ?? r.presenter.region?.measured?.encodeFps ?? null,
      ),
    ),
    regionEncoded: (() => {
      const r = rows[rows.length - 1]?.presenter.region;
      const m = r?.measured ?? r;
      return m?.encodedWidth ? `${m.encodedWidth}x${m.encodedHeight}` : null;
    })(),
    fullEncoded: (() => {
      const s = rows[rows.length - 1]?.presenter.sender;
      return s ? `${s.encodedWidth}x${s.encodedHeight}` : null;
    })(),
    fullAllocation: (() => {
      // Median across the window, not the last tick: the full stream's rung
      // can change mid-window, and the last tick alone would then describe a
      // transient rather than the measured period.
      const a = rows
        .map((r) => r.presenter.region?.fullAllocation)
        .filter((x) => x && x.w > 0 && x.h > 0);
      if (!a.length) return null;
      const w = medianOf(a.map((x) => x.w));
      const h = medianOf(a.map((x) => x.h));
      return `${w}x${h}`;
    })(),
    viewerRegionDecoded: (() => {
      const r = rows[rows.length - 1]?.viewer.region?.stats;
      return r?.width ? `${r.width}x${r.height} @ ${r.decodeFps}fps` : null;
    })(),
  };
}

// Move the kiosk window on the captured desktop. This changes what is under a
// fixed screen-space selection without changing the selection at all, which is
// exactly the case the presenter must detect.
async function moveFixtureWindow(fix, bounds) {
  const cdp = await fix.page.context().newCDPSession(fix.page);
  const win = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId: win.windowId,
    bounds: { windowState: 'normal' },
  });
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds });
  await sleep(1200);
  const at = await fix.page.evaluate(() => ({
    x: screenX,
    y: screenY,
    w: innerWidth,
    h: innerHeight,
    viewport: window.__fixture.state().viewport,
  }));
  return { requested: bounds, at, cdp, windowId: win.windowId };
}

// Put the kiosk window back where the fixture expects it: fullscreen with the
// top edge just above the screen so Chrome's "for testing" infobar is hidden.
async function restoreFixtureWindow(moved) {
  const { cdp, windowId } = moved || {};
  if (!cdp) return;
  try {
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 0, top: -36, width: 1920, height: 1116 },
    });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'fullscreen' },
    });
  } catch (err) {
    console.log(`  (window restore failed: ${err.message})`);
  }
  await sleep(1200);
  try { await cdp.detach(); } catch { /* page may be gone */ }
}

async function readRegionSenderBytes(page) {
  const counters = await page.evaluate(() => window.__presenter.outboundCounters());
  if (!counters) return null;
  return {
    region: counters.region ? { ...counters.region } : null,
    full: counters.full ? { ...counters.full } : null,
  };
}

// ---------------------------------------------------------------------------
async function main() {
  ensureDir(OUT_DIR);
  const fix = await connectFixture();
  const manifest = { startedAt: new Date().toISOString(), scenarios: {} };
  console.log(`evidence dir: ${OUT_DIR}`);

  const wanted = SCENARIO === 'all'
    ? ['baseline', 'motion', 'congestion', 'states', 'floor', 'region']
    : SCENARIO.split(',');

  const runners = {
    baseline: scenarioBaseline,
    motion: scenarioMotion,
    congestion: scenarioCongestion,
    states: scenarioStates,
    floor: scenarioFloor,
    region: scenarioRegion,
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
        if (name === 'region' && res.conclusion) {
          const c = res.conclusion;
          console.log(`  region ${c.regionEncoded} vs full ${c.fullAtSameContent} ` +
            `(${c.linearGain ?? '?'}x linear; full stream encoded ${c.fullEncodedAtSample ?? '?'})`);
          console.log(`  measured kbps: full-only=${c.measuredKbps.fullOnly} ` +
            `full=${c.measuredKbps.full} region=${c.measuredKbps.region} ` +
            `total=${c.measuredKbps.total} (${c.costRatio ?? '?'}x)`);
          const hd = res.highDensity;
          if (hd?.sharpnessRatio != null) {
            console.log(`  high-density @${hd.constrainedRung} ` +
              `(encoded ${hd.constrainedEncoded ?? '?'}): ` +
              `detail(region)=${hd.sharpness.region.detail.toFixed(2)} ` +
              `vs detail(full same area)=${hd.sharpness.fullSameCrop.detail.toFixed(2)} ` +
              `(${hd.sharpnessRatio}x at ${hd.sharpness.region.compared})`);
          }
          console.log(`  correspondence=${c.correspondenceOk} ` +
            `outsideExcluded=${c.outsideExcluded} ` +
            `viewerDropped=${c.viewerDroppedTrack} bytesStopped=${c.cleanupStoppedBytes}`);
          console.log(`  resize=${c.resizeRecomputed} contentLostPaused=${c.contentLostPaused} ` +
            `stoppedBytes=${c.contentLostStoppedBytes} resumed=${c.contentRestoredResumed}`);
          console.log(`  sourceClose=${c.sourceCloseClean} singleRegionSender=${c.singleRegionSender}`);
        }
      } catch (err) {
        console.error(`  FAILED: ${err.stack || err}`);
        manifest.scenarios[name] = { ok: false, error: String(err) };
      }
    }
  } finally {
    manifest.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // A scenario that throws leaves its launched browser running; the node
    // process would then never exit. The browsers are this process's children
    // (the fixture kiosk is not), so reap them here.
    killChildBrowsers(process.pid);
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
