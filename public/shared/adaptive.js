// Adaptive capture/encode controller for a screen-share presenter.
//
// Two independent control loops:
//   1. Frame rate: driven by measured *content motion* and by the encode queue.
//      Static slides drop to a trickle of frames; fast animation gets more.
//   2. Resolution + bitrate ceiling: driven by a smoothed bandwidth estimate
//      with asymmetric response (drop fast, raise slowly) plus a hold-down
//      timer so a brief recovery cannot immediately re-saturate the link.
//
// Deliberate design choices:
//  - We never touch the DOM/CSS preview size. Quality decisions are applied to
//    getDisplayMedia constraints (capture size), track frameRate, and the
//    RTCRtpSender encodings, i.e. what is actually transmitted.
//  - The bandwidth estimate comes from transport-wide congestion control
//    (availableOutgoingBitrate) when present, else from REMB/GOOG estimates.
//    It is run through a median filter followed by an EWMA *and* a slope
//    limiter, so a single spike cannot command a 3x jump.
//  - Probing upward requires: estimate above the current ceiling by a margin,
//    a quiet send queue, low frame-drop rate, and the cooldown expired. The
//    ceiling then steps by at most one rung per interval.
//  - There is a hard floor (MIN_LADDER_INDEX). If even the floor cannot be
//    sustained the presenter reports `degraded-low-quality` instead of
//    silently sending mush.

export const LADDER = [
  { width: 3840, height: 2160, maxKbps: 12000, label: '2160p' },
  { width: 2560, height: 1440, maxKbps: 8000, label: '1440p' },
  { width: 1920, height: 1080, maxKbps: 5000, label: '1080p' },
  { width: 1600, height: 900, maxKbps: 3200, label: '900p' },
  { width: 1280, height: 720, maxKbps: 2200, label: '720p' },
  { width: 1024, height: 576, maxKbps: 1400, label: '576p' },
  { width: 896, height: 504, maxKbps: 900, label: '504p' },
  { width: 768, height: 432, maxKbps: 620, label: '432p' },
  { width: 640, height: 360, maxKbps: 420, label: '360p' },
];

// Text must stay legible; do not go below 640x360 for a desktop share.
export const MIN_LADDER_INDEX = LADDER.length - 1;
export const MAX_LADDER_INDEX = 0;

export const FPS_STATIC = 2;
export const FPS_SLOW = 15;
export const FPS_MOTION = 30;
export const FPS_MAX = 60;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

export class AdaptiveController {
  constructor(options = {}) {
    this.onApply = options.onApply ?? (() => {});
    this.onNotice = options.onNotice ?? (() => {});
    this.onMetrics = options.onMetrics ?? (() => {});

    this.ladderIndex = options.startIndex ?? 2; // 1080p
    this.minIndex = options.minIndex ?? MIN_LADDER_INDEX;
    this.maxIndex = options.maxIndex ?? MAX_LADDER_INDEX;
    this.floorIndex = Math.min(this.minIndex, LADDER.length - 1);
    // Highest rung the *source* can actually fill. The capture is often smaller
    // than the top rungs; claiming 1440p from a 1080p capture would only raise a
    // bitrate ceiling the encoder cannot use, and would make probes fail for a
    // reason that has nothing to do with the network.
    this.captureMaxIndex = this.maxIndex;

    this.fps = FPS_SLOW;
    this.targetFps = FPS_SLOW;
    this.fpsBand = 1;

    this.rawEstimateKbps = 0;
    this.estimateWindow = [];
    this.smoothedEstimateKbps = 0;
    this.estimateSlopeKbpsPerSec = 0;
    this.lastEstimateAt = 0;

    this.lastUpgradeAt = 0;
    this.lastDowngradeAt = 0;
    this.upgradeIntervalMs = options.upgradeIntervalMs ?? 7000;
    this.downgradeIntervalMs = options.downgradeIntervalMs ?? 1200;
    this.upgradeMargin = options.upgradeMargin ?? 1.45;
    this.downgradeMargin = options.downgradeMargin ?? 0.85;
    this.probeHoldMs = options.probeHoldMs ?? 4000;

    this.motionScore = 0;
    this.frameCounter = 0;
    this.encodeQueueDelayMs = 0;
    this.encodeFps = 0;
    this.dropRate = 0;
    this.retransmitRatio = 0;
    this.lossRate = 0;
    this.rttMs = 0;
    this.availableKbps = 0;
    this.qualityLimitation = null;
    this.bytesSentKbps = 0;

    this.state = 'idle';
    this.notices = [];
    this.history = [];
    this.pendingFloorNotify = false;
    this.startedAt = performance.now();
    this.warmupMs = options.warmupMs ?? 6000;

    // Congestion control can only estimate the bandwidth it actually sees. If
    // the encoder is capped at the floor, the estimate stays pinned near that
    // cap and the ladder can never rise again - a deadlock. The probe breaks it
    // by briefly raising the send ceiling, then either committing the upgrade
    // or reverting with a backoff.
    this.probe = null;
    this.probeWindowMs = options.probeWindowMs ?? 8000;
    this.probeIntervalMs = options.probeIntervalMs ?? 10000;
    this.lastProbeAt = 0;
    this.probeMaxBackoffMs = options.probeMaxBackoffMs ?? 60000;
    this.probeFailures = 0;
    this.lastProbeEstimateKbps = 0;
  }

  // --- motion estimation -------------------------------------------------
  // Called with the fraction (0..1) of a 16x9 grid of capture cells whose
  // pixels changed meaningfully since a ~750ms-old reference frame. Cheap and
  // robust for documents, where only part of the frame is usually in motion.
  noteMotion(delta) {
    this.frameCounter++;
    this.motionScore = this.motionScore * 0.72 + clamp(delta, 0, 1) * 0.28;
    // `motionScore` is the fraction of the frame that is meaningfully changing.
    // A document at rest still changes a few percent of its area (clock, cursor,
    // calibration strip), so the static threshold sits above that noise floor;
    // scrolling turns most of the frame over at once.
    //
    // Up and down thresholds differ per band. Without that gap a scroll whose
    // changing area hovers on a boundary flips the request every second, which
    // shows up as a target frame rate oscillating between two rungs.
    const motion = this.motionScore;
    const FPS_BANDS = [FPS_STATIC, FPS_SLOW, FPS_MOTION, FPS_MAX];
    const UP = [0.12, 0.42, 0.70];
    const DOWN = [0.09, 0.34, 0.58];
    let idx = this.fpsBand ?? 1;
    while (idx < FPS_BANDS.length - 1 && motion > UP[idx]) idx++;
    while (idx > 0 && motion < DOWN[idx - 1]) idx--;
    this.fpsBand = idx;
    let want = FPS_BANDS[idx];

    // Degrade fps when the encoder is behind, but never below the static floor
    // so a frozen-looking stream is not mistaken for a healthy one. Require two
    // consecutive slow samples: a single second with a stall otherwise halves
    // the request and then immediately restores it, which reads as flicker.
    const behind =
      this.encodeQueueDelayMs > 120 ||
      (this.encodeFps > 0 && this.targetFps > 0 && this.encodeFps < this.targetFps * 0.55);
    this.behindStreak = behind ? (this.behindStreak ?? 0) + 1 : 0;
    if (this.behindStreak >= 2) {
      want = Math.max(FPS_STATIC, Math.round(want * 0.5));
    }
    if (want !== this.targetFps) {
      this.targetFps = want;
      this.apply({ frameRate: want });
    }
  }

  // Called whenever the capture size changes (share start, source switch).
  noteCaptureSize(width, height) {
    if (!(height > 0)) return;
    const idx = LADDER.findIndex((r) => r.height <= height);
    this.captureMaxIndex = idx >= 0 ? idx : this.floorIndex;
    if (this.ladderIndex < this.captureMaxIndex) {
      this.ladderIndex = this.captureMaxIndex;
    }
  }

  get effectiveMaxIndex() {
    return Math.max(this.maxIndex, this.captureMaxIndex);
  }

  // --- bandwidth feedback -------------------------------------------------
  noteSenderStats(stats) {
    if (!stats) return;
    const now = performance.now();
    // The first few seconds of a call carry a poor congestion-control estimate
    // (the transport is still probing). Acting on it drives the ladder to the
    // floor before the link has been measured at all, so hold off until the
    // estimate has had a moment to stabilise. The timer re-arms on reset.

    const candidate =
      stats.availableOutgoingBitrateKbps ||
      stats.rembKbps ||
      stats.googTargetKbps ||
      0;
    if (candidate > 0) {
      this.rawEstimateKbps = candidate;
      this.estimateWindow.push(candidate);
      if (this.estimateWindow.length > 7) this.estimateWindow.shift();
      const robust = median(this.estimateWindow);
      const prev = this.smoothedEstimateKbps;
      const alpha = candidate < prev ? 0.5 : 0.18; // react fast to drops
      this.smoothedEstimateKbps = prev
        ? prev * (1 - alpha) + robust * alpha
        : robust;
      if (this.lastEstimateAt) {
        const dtSec = Math.max(0.001, (now - this.lastEstimateAt) / 1000);
        const slope =
          (this.smoothedEstimateKbps - prev) / dtSec;
        this.estimateSlopeKbpsPerSec =
          this.estimateSlopeKbpsPerSec * 0.6 + slope * 0.4;
      }
      this.lastEstimateAt = now;
    }

    this.availableKbps = this.smoothedEstimateKbps;
    this.rttMs = stats.rttMs ?? this.rttMs;
    this.encodeQueueDelayMs = stats.encodeQueueMs ?? this.encodeQueueDelayMs;
    this.encodeFps = stats.encodeFps ?? this.encodeFps;
    this.dropRate = stats.dropRate ?? this.dropRate;
    this.retransmitRatio = stats.retransmitRatio ?? this.retransmitRatio;
    this.lossRate = stats.lossRate ?? this.lossRate;
    this.qualityLimitation = stats.qualityLimitation ?? this.qualityLimitation;
    this.bytesSentKbps = stats.bytesSentKbps ?? this.bytesSentKbps;

    // Still show the estimate while warming up, but do not act on it: the
    // transport has not measured the path yet and reacting would slam the
    // ladder to the floor for no reason.
    if (now - this.startedAt < this.warmupMs) return;
    if (this.probe) {
      this.evaluateProbe(now);
      return;
    }
    this.evaluate(now);
  }

  evaluateProbe(now) {
    const { targetIndex, startedAt } = this.probe;
    const target = LADDER[targetIndex];
    // During a probe the encoder is deliberately asked for more than the last
    // sustained rate, so a short queue spike is expected. Only persistent,
    // transport-level trouble should abort it.
    const congested =
      this.encodeQueueDelayMs > 400 ||
      this.dropRate > 0.08 ||
      this.lossRate > 0.10 ||
      this.qualityLimitation === 'bandwidth';

    // A probe that produces congestion is a failed probe: revert the ceiling
    // immediately and hold down for longer than a normal downgrade.
    if (congested) {
      this.endProbe(false, now, 'congested');
      return;
    }
    if (now - startedAt < this.probeWindowMs) return;

    // Success means the link can carry this rung, not that it can already carry
    // the rung above it; the normal upgrade path handles the next step.
    const ok = this.smoothedEstimateKbps > target.maxKbps * 0.95;
    this.endProbe(ok, now, ok ? 'estimate-rose' : 'estimate-flat');
  }

  startProbe(now, targetIndex) {
    const target = LADDER[targetIndex];
    this.probe = { targetIndex, startedAt: now };
    this.lastProbeAt = now;
    this.lastProbeEstimateKbps = this.smoothedEstimateKbps;
    // Raising only the bitrate ceiling does nothing while the current rung's
    // content fits well below it: the encoder never asks for more, so the
    // transport never measures more and the estimate cannot rise. The probe has
    // to encode at the target rung for the path to be genuinely exercised.
    this.apply({
      width: target.width,
      height: target.height,
      maxBitrateKbps: target.maxKbps,
      probe: true,
    });
    this.notice(
      'probe',
      `试探升档：临时按 ${target.label}/${target.maxKbps} kbps 发送，观察链路是否承受`,
    );
  }

  endProbe(ok, now, reason) {
    const { targetIndex } = this.probe;
    this.probe = null;
    if (ok) {
      this.probeFailures = 0;
      this.lastProbeAt = now;
      this.lastUpgradeAt = now;
      this.commitLadder(targetIndex, 'upgrade', now, {
        estimateKbps: Math.round(this.smoothedEstimateKbps),
        thresholdKbps: Math.round(LADDER[targetIndex].maxKbps * this.upgradeMargin * 0.8),
        probe: true,
        reason,
      });
      return;
    }
    // Revert to the conservative ceiling for the current rung.
    this.apply({
      maxBitrateKbps: LADDER[this.ladderIndex].maxKbps,
      width: LADDER[this.ladderIndex].width,
      height: LADDER[this.ladderIndex].height,
      probe: false,
    });
    this.probeFailures++;
    // Back off geometrically so a genuinely narrow link is not hammered with
    // probes. The cooldown is computed at the next attempt, and an estimate
    // that has clearly risen since the failed probe cancels the backoff - that
    // is exactly the "bandwidth came back" case the probe exists for.
    const backoff = Math.min(
      this.probeMaxBackoffMs,
      this.probeIntervalMs * 2 ** Math.min(this.probeFailures, 3),
    );
    this.lastDowngradeAt = now;
    this.notice(
      'probe-failed',
      reason === 'congested'
        ? `试探升档引发拥塞，已回退（第 ${this.probeFailures} 次，${Math.round(backoff / 1000)} 秒后再试）`
        : `试探后带宽未上升（估计 ${Math.round(this.smoothedEstimateKbps)} kbps），维持当前清晰度`,
    );
  }

  evaluate(now) {
    const est = this.smoothedEstimateKbps;
    if (!est) return;

    const current = LADDER[this.ladderIndex];
    const congested =
      this.encodeQueueDelayMs > 180 ||
      this.dropRate > 0.04 ||
      this.lossRate > 0.08 ||
      this.qualityLimitation === 'bandwidth';

    // ---- downgrade: fast, hysteretic ----
    const downThreshold = current.maxKbps * this.downgradeMargin;
    if (
      (est < downThreshold || congested) &&
      this.ladderIndex < this.floorIndex &&
      now - this.lastDowngradeAt > this.downgradeIntervalMs
    ) {
      let nextIndex = this.ladderIndex + 1;
      // Severe congestion skips a rung, but only one, to keep state churn low.
      if ((est < current.maxKbps * 0.45 || this.encodeQueueDelayMs > 400) && nextIndex < this.floorIndex) {
        nextIndex++;
      }
      // Never fall below what the estimate can actually carry.
      while (
        nextIndex < this.floorIndex &&
        LADDER[nextIndex].maxKbps > est * 0.8
      ) {
        nextIndex++;
      }
      this.commitLadder(nextIndex, 'downgrade', now, {
        estimateKbps: Math.round(est),
        thresholdKbps: Math.round(downThreshold),
        congested,
      });
      return;
    }

    // ---- upgrade: slow, margin + hold-down + slope gate ----
    const targetIndex = this.ladderIndex - 1;
    // At the top usable rung there is nothing to step up to; skip the attempt
    // but still fall through to the floor-health check below.
    const canStepUp = targetIndex >= this.effectiveMaxIndex;
    const target = LADDER[Math.max(targetIndex, 0)];
    // "Quiet" here means the *sender* is not backlogged. Retransmissions are a
    // normal consequence of recovery on a lossy path and must not be read as a
    // reason to stay pinned at the floor - that would make recovery impossible.
    const quiet = this.encodeQueueDelayMs < 60 && this.dropRate < 0.02;
    const heldDown = now - this.lastDowngradeAt > this.probeHoldMs;
    const cooled = now - this.lastUpgradeAt > this.upgradeIntervalMs;
    const scaled = target.maxKbps * this.upgradeMargin;
    const slopeOk = this.estimateSlopeKbpsPerSec > -50;

    if (canStepUp && est > scaled && quiet && heldDown && cooled && slopeOk) {
      this.commitLadder(targetIndex, 'upgrade', now, {
        estimateKbps: Math.round(est),
        thresholdKbps: Math.round(scaled),
      });
      return;
    }

    // ---- probe: escape the estimate deadlock ----
    // Only when the link looks quiet and we have waited out the normal
    // intervals; the probe itself is bounded by a short window and reverts.
    // A failed probe makes the next attempt wait longer; a clear rise in the
    // estimate since that failure clears the penalty immediately.
    const estimateRecovered =
      this.smoothedEstimateKbps > this.lastProbeEstimateKbps * 1.6;
    if (estimateRecovered && this.probeFailures > 0) this.probeFailures = 0;
    // Note: a *low* estimate is not a reason to refuse a probe - that is the
    // deadlock the probe exists to break, since the transport can only estimate
    // the traffic the encoder is already producing. Actual congestion signals
    // are covered by `quiet`, and a probe that turns congested aborts itself.
    const probeCooldown =
      this.probeIntervalMs * 2 ** Math.min(this.probeFailures, 3);
    const canProbe =
      quiet &&
      heldDown &&
      slopeOk &&
      now - this.lastProbeAt > Math.min(this.probeMaxBackoffMs, probeCooldown) &&
      targetIndex >= this.effectiveMaxIndex;
    if (canProbe) {
      this.startProbe(now, targetIndex);
      return;
    }

    // ---- floor health ----
    if (this.ladderIndex === this.floorIndex) {
      const unusable =
        est < LADDER[this.floorIndex].maxKbps * 0.6 ||
        this.encodeQueueDelayMs > 500 ||
        this.dropRate > 0.15;
      if (unusable && !this.pendingFloorNotify) {
        this.pendingFloorNotify = true;
        this.notice(
          'degraded',
          `可用带宽约 ${Math.round(est)} kbps，已到最低清晰度 ${LADDER[this.floorIndex].label}，文字可能难以辨认`,
        );
      } else if (!unusable && this.pendingFloorNotify && est > LADDER[this.floorIndex].maxKbps * 0.9) {
        this.pendingFloorNotify = false;
        this.notice('recovered', `最低档已可维持，等待链路稳定后再提升清晰度`);
      }
    }
  }

  commitLadder(index, direction, now, detail) {
    const from = this.ladderIndex;
    this.ladderIndex = clamp(index, this.effectiveMaxIndex, this.floorIndex);
    if (direction === 'upgrade') this.lastUpgradeAt = now;
    else this.lastDowngradeAt = now;

    if (this.ladderIndex === 0) this.lastUpgradeAt = now + this.upgradeIntervalMs;

    this.apply({
      width: LADDER[this.ladderIndex].width,
      height: LADDER[this.ladderIndex].height,
      maxBitrateKbps: LADDER[this.ladderIndex].maxKbps,
      ladderIndex: this.ladderIndex,
    });

    const rec = {
      at: Date.now(),
      direction,
      from: LADDER[from].label,
      to: LADDER[this.ladderIndex].label,
      ...detail,
    };
    this.history.push(rec);
    if (this.history.length > 200) this.history.shift();
    this.onMetrics(rec);

    if (direction === 'downgrade' && this.ladderIndex >= this.floorIndex) {
      this.notice(
        'floor',
        `已降到最低清晰度 ${LADDER[this.ladderIndex].label}，仍可继续接收但文字较小`,
      );
    } else if (direction === 'downgrade') {
      this.notice(
        'downgrade',
        `带宽不足，清晰度降至 ${LADDER[this.ladderIndex].label}`,
      );
    } else if (direction === 'upgrade') {
      this.notice(
        'upgrade',
        `链路稳定，清晰度提升至 ${LADDER[this.ladderIndex].label}`,
      );
    }
  }

  reset() {
    this.startedAt = performance.now();
    this.fpsBand = 1;
    this.targetFps = FPS_SLOW;
    this.motionScore = 0;
    this.behindStreak = 0;
    this.lastUpgradeAt = 0;
    this.lastDowngradeAt = 0;
    this.pendingFloorNotify = false;
    this.estimateWindow = [];
    this.smoothedEstimateKbps = 0;
    this.estimateSlopeKbpsPerSec = 0;
    this.probe = null;
    this.lastProbeAt = 0;
    this.probeFailures = 0;
  }

  apply(patch) {
    this.onApply(patch);
  }

  notice(level, message) {
    const n = { at: Date.now(), level, message };
    this.notices.push(n);
    if (this.notices.length > 60) this.notices.shift();
    this.onNotice(n);
  }

  snapshot() {
    return {
      state: this.state,
      ladderIndex: this.ladderIndex,
      resolution: LADDER[this.ladderIndex].label,
      maxKbps: LADDER[this.ladderIndex].maxKbps,
      floorResolution: LADDER[this.floorIndex].label,
      captureMaxResolution: LADDER[this.captureMaxIndex].label,
      targetFps: this.targetFps,
      motionScore: this.motionScore,
      estimateKbps: Math.round(this.smoothedEstimateKbps),
      rawEstimateKbps: Math.round(this.rawEstimateKbps),
      estimateSlopeKbpsPerSec: Math.round(this.estimateSlopeKbpsPerSec),
      availableKbps: Math.round(this.availableKbps),
      encodeQueueDelayMs: Math.round(this.encodeQueueDelayMs),
      encodeFps: Math.round(this.encodeFps),
      dropRate: this.dropRate,
      retransmitRatio: this.retransmitRatio,
      lossRate: this.lossRate,
      rttMs: Math.round(this.rttMs),
      qualityLimitation: this.qualityLimitation,
      bytesSentKbps: Math.round(this.bytesSentKbps),
      probing: !!this.probe,
      probeTarget: this.probe ? LADDER[this.probe.targetIndex].label : null,
      probeFailures: this.probeFailures,
      lastProbeEstimateKbps: Math.round(this.lastProbeEstimateKbps),
      history: this.history.slice(-12),
      notices: this.notices.slice(-8),
    };
  }
}
