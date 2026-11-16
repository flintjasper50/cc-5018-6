#!/usr/bin/env node
// Turn the raw evidence JSON into the tables used by the weak-network report.
//
// Run after experiments:
//   node scripts/report.mjs evidence/final
//
// Latency and text readability are reported per phase, separately, and never
// collapsed into a single average bitrate: the two answer different questions
// and move in opposite directions as the link degrades.

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { luma } from '../public/shared/calib.js';

const dir = process.argv[2] || 'evidence/final';

const read = (name) => {
  const p = path.join(dir, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[(v.length - 1) >> 1];
};

const fmt = (x, d = 0) => (x == null ? '—' : Number(x).toFixed(d));

// Metrics of a saved text crop. The crops cover the same physical region at
// both ends, so these compare text legibility directly. The live sampler is
// deliberately NOT used here: it averages a trailing window, and during a
// resolution switch that window mixes 1080p readings with 360p ones - which
// can make the low rung look *sharper*. A saved crop is attributable to one
// frame size, so it cannot lie that way.
//
// Two resolution-sensitive measures are reported side by side. The presenter's
// crop and the viewer's crop are captured a moment apart and the content keeps
// scrolling, so they cannot be compared pixel-for-pixel; comparing each crop
// against its own paper colour avoids depending on that alignment.
//  - stroke coverage: share of pixels meaningfully darker than the paper. Blur
//    spreads a stroke over more pixels, so this can RISE as sharpness drops; it
//    says the ink is still present, not that it is legible.
//  - contrast: Weber contrast (paper - 2nd percentile) / paper, computed within
//    the crop. This falls as fine strokes are washed into the paper colour.
//  - glyph: the 12px code font scaled into the viewer's pixels. Below ~5px a
//    glyph has no room for its strokes regardless of bitrate.
const TEXT_REGION_W = 820; // screen pixels, set by scripts/experiment.mjs
const TEXT_PX = 12; // fixture code font size, screen pixels
const SCREEN_W = 1920; // captured desktop width
function cropMetrics(file) {
  if (!fs.existsSync(file)) return null;
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width, height, data } = png;
  const n = width * height;
  const lum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = luma(data[p], data[p + 1], data[p + 2]);
  }
  // Typed arrays sort numerically by default; a plain Array would sort as
  // strings and silently return nonsense percentiles.
  const sorted = Float64Array.from(lum).sort();
  const q = (x) => sorted[Math.floor(x * (sorted.length - 1))];
  const paper = q(0.5);
  let stroke = 0;
  for (const v of sorted) if (v < paper - 25) stroke++;
  const weber = paper > 0 ? (paper - q(0.02)) / paper : 0;
  const scale = width / TEXT_REGION_W;
  // The crop is scaled from the receiving frame: cropW / regionW == frameW /
  // screenW. Printing the implied frame width makes the crop unambiguous - a
  // 273px crop is a 640px frame, not a 273px stream. Round to the encoder's
  // even width so 1599px reads as the 1600px rung it actually was.
  const impliedVideoW = Math.round((SCREEN_W * scale) / 2) * 2;
  return {
    w: width,
    h: height,
    paper,
    strokePct: (stroke / n) * 100,
    inkPct: (sorted.filter((v) => v < 128).length / n) * 100,
    weber,
    glyphPx: TEXT_PX * scale,
    impliedVideoW,
  };
}

// --- baseline -------------------------------------------------------------
// Latency/fps come from the live 1 Hz sampler. Legibility comes from the saved
// crop, not the live window: the crop is one frame at one resolution, so it
// cannot average across a resolution change.
const baseline = read('baseline');
if (baseline) {
  const rows = baseline.samples;
  const lat = rows
    .map((r) => r.viewer.latencyRecent)
    .filter((l) => l && l.n && l.p50 != null);
  const decodes = rows.map((r) => r.viewer.read?.decodeOk).filter(Number.isFinite);
  const encs = rows
    .map((r) => r.presenter.sender)
    .filter(Boolean)
    .map((s) => [s.encodedWidth, s.encodedHeight]);
  const crop = cropMetrics(path.join(dir, 'baseline-text-viewer.png'));
  console.log('## baseline (no impairment)');
  console.log(
    `  frames/s: ${fmt(median(rows.map((r) => r.presenter.sender?.encodeFps)), 1)}` +
      `   encoded: ${[...new Set(encs.map((e) => e.join('x')))].join(', ')}`,
  );
  console.log(
    `  latency p50: ${fmt(median(lat.map((l) => l.p50)))} ms` +
      `   p95: ${fmt(median(lat.map((l) => l.p95)))} ms`,
  );
  console.log(
    `  text crop: ${crop ? `${crop.w}x${crop.h}  glyph ${crop.glyphPx.toFixed(1)}px` +
      `  contrast ${crop.weber.toFixed(2)}  stroke ${crop.strokePct.toFixed(1)}%` : '—'}` +
      `   strip decode: ${fmt(median(decodes) * 100)}%`,
  );
}

// --- motion ---------------------------------------------------------------
const motion = read('motion');
if (motion) {
  console.log('\n## motion policy');
  console.log(
    `  static text: ${fmt(motion.conclusion.staticMeanFps, 1)} fps` +
      `   fast scroll+charts: ${fmt(motion.conclusion.fastMeanFps, 1)} fps`,
  );
}

// --- congestion -----------------------------------------------------------
// Latency uses `latencyRecent` (the viewer's last 5 s of samples), not the
// session-wide distribution. The session distribution carries every sample
// since the call started, so a healthy phase that follows a 300 kbps collapse
// still reports the collapse's p95. The first rows of a phase are skipped
// because their 5 s window still reaches back into the previous phase.
const WINDOW_SKIP_MS = 6000;
const phaseLatency = (rows) => {
  const from = rows[0].at + WINDOW_SKIP_MS;
  return rows
    .filter((r) => r.at >= from)
    .map((r) => r.viewer.latencyRecent)
    .filter((l) => l && l.n && l.p50 != null);
};

const cong = read('congestion');
if (cong) {
  const t0 = cong.phases[0].samples[0].at;
  console.log('\n## weak network');
  console.log(
    '  phase           ladder                 encoded sizes                  ' +
      'lat p50/p95     fps',
  );
  for (const p of cong.phases) {
    const rows = p.samples;
    const lat = phaseLatency(rows);
    const encs = [...new Set(
      rows.map((r) => r.presenter.sender).filter(Boolean)
        .map((s) => `${s.encodedWidth}x${s.encodedHeight}`),
    )];
    const fps = median(rows.map((r) => r.presenter.sender?.encodeFps));
    console.log(
      `  ${p.name.padEnd(14)} ${(p.resolutionStart + ' -> ' + p.resolutionEnd).padEnd(21)} ` +
        `${encs.join(' ').padEnd(30)} ` +
        `${fmt(median(lat.map((l) => l.p50)))}/${fmt(median(lat.map((l) => l.p95)))} ms`.padEnd(16) +
        ` ${fmt(fps, 1).padStart(5)}`,
    );
  }
  console.log(
    '  lat = median of per-second 5 s trailing windows, first 6 s of each phase\n' +
      '  skipped so the window does not reach into the previous phase. Legibility\n' +
      '  is not in this table on purpose: the viewer\'s live sharpness average spans\n' +
      '  resolution switches, so it can read *higher* at the low rung; see the\n' +
      '  same-region crop table below for the per-phase answer.',
  );
  console.log('\n  rung changes (deduped):');
  for (const u of cong.upgradesDuringRecovery || []) {
    const dt = ((u.at - t0) / 1000).toFixed(0);
    console.log(
      `    +${dt.padStart(3)}s  ${u.from} -> ${u.to}` +
        `  est=${u.estimateKbps} kbps  ` +
        `${u.probe ? 'probe' : 'direct'}${u.reason ? ` (${u.reason})` : ''}`,
    );
  }
  console.log('\n  notices:');
  for (const n of cong.notices || []) {
    console.log(`    +${((n.at - t0) / 1000).toFixed(0).padStart(3)}s  [${n.level}] ${n.message}`);
  }
}

// --- floor ----------------------------------------------------------------
const floor = read('floor');
if (floor) {
  console.log('\n## floor');
  console.log(
    `  min encoded height: ${floor.minEncodedHeight} (floor ${floor.floorHeight})` +
      `   respected: ${floor.floorRespected}`,
  );
  const v = floor.viewer;
  const recent = floor.samples
    .slice(-6)
    .map((r) => r.viewer.latencyRecent)
    .filter((l) => l && l.n && l.p50 != null);
  const lat = median(recent.map((l) => l.p50));
  const lat95 = median(recent.map((l) => l.p95));
  console.log(
    `  viewer: ${v.state}  decode ${v.video.width}x${v.video.height}` +
      `  latency p50 ${fmt(lat)} p95 ${fmt(lat95)} (last 5s window)`,
  );
}

// --- comparable crops -----------------------------------------------------
// The authoritative legibility comparison: the same physical text region at
// both ends, each crop saved from one frame at one resolution.
const cropFiles = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('-text-viewer.png')).sort()
  : [];
if (cropFiles.length) {
  console.log('\n## same-region text crops');
  console.log(
    '  label              frame   viewer crop  glyph  stroke%   contrast  presenter contrast',
  );
  for (const f of cropFiles) {
    const c = cropMetrics(path.join(dir, f));
    if (!c) continue;
    const label = f.replace('-text-viewer.png', '');
    const p = cropMetrics(path.join(dir, `${label}-text-presenter.png`));
    console.log(
      `  ${label.padEnd(18)} ${String(c.impliedVideoW).padStart(5)}px ${`${c.w}x${c.h}`.padEnd(12)}` +
        ` ${c.glyphPx.toFixed(1).padStart(4)}px` +
        ` ${c.strokePct.toFixed(1).padStart(8)}%` +
        ` ${c.weber.toFixed(2).padStart(9)}` +
        (p ? ` ${p.weber.toFixed(2).padStart(18)}` : '                   —'),
    );
  }
  console.log(
    '  frame = width the crop implies for the received video. glyph = 12px code\n' +
      '  font scaled into those pixels. contrast is Weber contrast within each\n' +
      '  crop. The two crops are captured moments apart with the text still\n' +
      '  scrolling, so they are not aligned pixels; compare each contrast to its\n' +
      '  own side, not to the other side\'s.',
  );
}

// --- focus region ---------------------------------------------------------
// The region mode has two claims that must be measured, not asserted:
//  1. it costs more bandwidth than the full-screen strategy (how much);
//  2. it delivers materially more detail for the selected content.
// Both numbers below come from the run's recorded samples and received crops.
const region = read('region');
if (region) {
  const c = region.conclusion || {};
  const plan = region.correctness?.presenter?.plan;
  const cmp = region.correctness?.presenter?.comparison;
  console.log('\n## focus region (重点区域)');
  console.log(
    `  selection ${plan ? `${plan.crop.w}x${plan.crop.h} → encoded ${plan.encW}x${plan.encH}` : '—'}` +
      `   coverage ${plan ? (plan.coverage * 100).toFixed(0) + '%' : '—'}` +
      `   engine ${region.correctness?.presenter?.engine ?? '—'}`,
  );
  console.log(
    `  same content in full stream: ${c.fullAtSameContent ?? '—'}` +
      `   (full stream encoded ${c.fullEncodedAtSample ?? '—'})` +
      `   linear gain ${fmt(c.linearGain, 2)}×` +
      `   native fill ${cmp ? (cmp.nativeFill * 100).toFixed(0) + '%' : '—'}`,
  );
  console.log(
    `  measured kbps: full-only ${fmt(c.measuredKbps?.fullOnly)}` +
      `   full ${fmt(c.measuredKbps?.full)}` +
      `   region ${fmt(c.measuredKbps?.region)}` +
      `   total ${fmt(c.measuredKbps?.total)}` +
      `   cost ×${fmt(c.costRatio, 2)}`,
  );
  const rd = region.highDensity?.region?.measured;
  if (rd) {
    console.log(
      `  region encode @1400kbps cap: ${rd.encodedWidth}x${rd.encodedHeight} @ ${fmt(rd.encodeFps, 1)} fps` +
        `   ${fmt(rd.kbps)} kbps  bpp ${fmt(rd.bpp, 3)}` +
        `   queue ${fmt(rd.queueDelayMs, 1)} ms  limit ${rd.qualityLimitation ?? '—'}`,
    );
  }
  const sharp = region.highDensity?.sharpness;
  if (sharp?.region && sharp?.fullSameCrop) {
    console.log(
      `  high-density source: full rung ${region.highDensity.constrainedRung ?? '—'}` +
        ` (encoded ${region.highDensity.constrainedEncoded ?? '—'})` +
        `   detail(region)=${fmt(sharp.region.detail, 2)}` +
        ` vs detail(full, same area)=${fmt(sharp.fullSameCrop.detail, 2)}` +
        `   → ×${fmt(region.highDensity.sharpnessRatio, 2)}` +
        ` (both compared at ${sharp.region.compared})`,
    );
  }
  const corr = region.correspondence || {};
  console.log(
    `  marker in received region: ${corr.inRegion ? 'found' : 'MISSING'}` +
      `   offset ${corr.dRegion == null ? '—' : fmt(corr.dRegion, 3) + ' of crop'}` +
      `   outside-selection marker: ${corr.outsideInRegion ? 'LEAKED' : 'excluded'}`,
  );
  const rf = region.viewerFullscreen || {};
  console.log(
    `  viewer → full screen: dropped=${c.viewerDroppedTrack}` +
      `   flowing before drop=${c.regionWasFlowing}` +
      `   region bytes before ${fmt(rf.bytes?.regionDeltaBeforeDrop)}` +
      ` → after ${fmt(rf.bytes?.regionDeltaLast3s)} (3 s windows)` +
      `   full stream still ${fmt(rf.bytes?.fullDeltaLast3s)}`,
  );
  const cl = region.contentLost || {};
  console.log(
    `  content moved out: paused=${c.contentLostPaused}` +
      `   region bytes after pause ${fmt(cl.regionByteDeltaAfterPause)}` +
      `   resumed on return=${c.contentRestoredResumed}`,
  );
  const rs = region.resize || {};
  console.log(
    `  capture resize: ${rs.captureBefore?.width}x${rs.captureBefore?.height}` +
      ` → ${rs.captureAfter?.width}x${rs.captureAfter?.height}` +
      `   crop ${rs.before?.plan?.crop ? `${rs.before.plan.crop.w}x${rs.before.plan.crop.h}` : '—'}` +
      ` → ${rs.after?.plan?.crop ? `${rs.after.plan.crop.w}x${rs.after.plan.crop.h}` : '—'}` +
      `   re-projected=${c.resizeRecomputed}`,
  );
  const bd = region.boundary || {};
  console.log(
    `  selection past the edge: requested ${bd.plan?.normalized ? `${Math.round(bd.plan.normalized.w * 100)}% wide` : '—'}` +
      `   sent ${bd.plan?.plan?.crop ? `${bd.plan.plan.crop.w}x${bd.plan.plan.crop.h}` : '—'}` +
      `   anomalies ${(bd.plan?.anomalies ?? []).map((a) => a.code).join(', ') || 'none'}`,
  );
  const rr = region.rapidReselect || {};
  console.log(
    `  rapid re-selection: one region m-line=${c.singleRegionSender}` +
      `   region mid ${rr.debug?.regionMid ?? '—'}` +
      `   final crop ${rr.track?.plan?.crop ? `${rr.track.plan.crop.w}x${rr.track.plan.crop.h}` : '—'}`,
  );
  const sc = region.sourceClose || {};
  console.log(
    `  source closed: presenter ${sc.presenter}` +
      `   viewer ${sc.viewer}` +
      `   region track detached=${!sc.regionDebug?.regionSenderHasTrack}` +
      `   frames stop=${c.sourceCloseClean}`,
  );
  console.log(
    '  kbps are measured from outbound-rtp bytesSent on each m-line, not from\n' +
      '  the encoder ceiling. detail() resamples both received crops to the same\n' +
      '  output width before measuring edge energy, so a larger region cannot win\n' +
      '  just by having more pixels; the full-stream figure is the same physical\n' +
      '  area cut out of the received full frame.',
  );
}

// --- states ---------------------------------------------------------------
const states = read('states');
if (states) {
  console.log('\n## lifecycle states');
  console.log(
    `  permission denied: presenter=${states.permissionDenied.presenterState}` +
      `  stream=${states.permissionDenied.hasStream}`,
  );
  const te = states.trackEnded;
  console.log(
    `  track ended:       presenter=${te.presenterStateAfter}` +
      `  viewer=${te.viewerStateAfter}` +
      `  stream=${te.viewerVideoAfter.hasStream}` +
      `  overlay="${te.viewerVideoAfter.overlayTitle}"`,
  );
  const sl = states.signalingLost;
  console.log(
    `  signaling lost:    viewer=${sl.viewerStateAfter}` +
      `  stream=${sl.viewerVideoAfter.hasStream}` +
      `  overlay="${sl.viewerVideoAfter.overlayTitle}"`,
  );
}
