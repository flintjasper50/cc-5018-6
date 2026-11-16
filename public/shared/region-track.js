// Controlled crop encoding for the focus-region track.
//
// This is not a CSS zoom or an upscaled preview. The source capture track is
// read through MediaStreamTrackProcessor, each VideoFrame is cropped at its
// native pixel rectangle, and the crop is drawn 1:1 into a canvas whose
// captureStream(0) track is the one actually sent over a dedicated RTP m-line.
// The canvas is only pushed when a region frame is due, so a static document
// costs almost nothing.
//
// If MediaStreamTrackProcessor is unavailable the class falls back to cropping
// frames out of the preview video element. Both paths send the same pixels;
// `mode` reports which one is in use so the UI can state it instead of
// claiming a capability the browser lacks.

import { planRegion } from './region.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export class RegionTrack {
  constructor(sourceTrack, options = {}) {
    this.sourceTrack = sourceTrack;
    this.previewVideo = options.previewVideo ?? null;
    this.onTrackChanged = options.onTrackChanged ?? (() => {});
    this.onUpdate = options.onUpdate ?? (() => {});
    this.onError = options.onError ?? (() => {});
    this.targetFps = options.fps ?? 15;
    this.norm = options.normalized ?? null;
    this.mstpSupported =
      typeof MediaStreamTrackProcessor !== 'undefined' &&
      typeof VideoFrame !== 'undefined';

    this.mode = 'idle'; // 'mstp' | 'draw' | 'stopped'
    this.running = false;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2;
    this.canvas.height = 2;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.stream = null;
    this.track = null;
    this.reader = null;
    this.generation = 0;
    this.timer = null;
    this.lastDrawAt = 0;
    this.lastFrameAt = 0;
    this.framesDrawn = 0;
    this.framesSkipped = 0;
    this.restarts = 0;
    this.lastError = null;
    this.frameW = 0;
    this.frameH = 0;
    this.plan = null;
    this.outside = false;
    // No viewer is asking for the region right now. Keep the pipeline and the
    // canvas track alive (so a re-request is instant) but stop drawing: an
    // unattached region stream must not keep costing CPU or encoder work.
    this.demand = true;
    this.destroyed = false;
  }

  get encodeSize() {
    return this.plan ? { w: this.plan.encW, h: this.plan.encH } : null;
  }

  setNormalized(norm) {
    this.norm = norm;
    this.recompute();
  }

  setFps(fps) {
    this.targetFps = Math.max(1, Math.min(60, Math.round(fps) || 1));
  }

  setDemand(on) {
    this.demand = !!on;
  }

  _recomputePlan(frameW, frameH) {
    const planned = planRegion(this.norm, frameW, frameH);
    if (!planned) {
      this.plan = null;
      this.outside = true;
      return null;
    }
    const sizeChanged =
      !this.plan ||
      this.plan.encW !== planned.encW ||
      this.plan.encH !== planned.encH;
    this.plan = planned;
    this.outside = !planned.crop;
    if (sizeChanged && !this.outside) this._resizeOutput(planned.encW, planned.encH);
    return planned;
  }

  recompute() {
    if (!this.frameW || !this.frameH) return this.plan;
    const before = this.plan ? `${this.plan.encW}x${this.plan.encH}` : 'none';
    const planned = this._recomputePlan(this.frameW, this.frameH);
    const after = planned ? `${planned.encW}x${planned.encH}` : 'none';
    if (before !== after) this.onUpdate(this.snapshot());
    return planned;
  }

  _resizeOutput(w, h) {
    const width = even(w);
    const height = even(h);
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    // captureStream(0) is a live track whose format follows the canvas; when
    // the canvas is resized the encoder picks the new size up on the next
    // requested frame. Nothing outside the crop rectangle is ever drawn, so
    // the padding of a larger canvas cannot leak into the image.
    if (this.track) this.track.contentHint = 'detail';
    this.onUpdate(this.snapshot());
  }

  start(frameW, frameH) {
    if (this.running) return this.track;
    this.frameW = frameW || this.frameW;
    this.frameH = frameH || this.frameH;
    this.destroyed = false;
    this.recompute();
    if (!this.plan || !this.plan.crop) {
      this.outside = true;
      this.onUpdate(this.snapshot());
      return null;
    }
    this._resizeOutput(this.plan.encW, this.plan.encH);
    this.stream = this.canvas.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];
    this.track.contentHint = 'detail';
    this.running = true;
    this.lastDrawAt = 0;
    this.lastError = null;
    if (this.mstpSupported) {
      this.mode = 'mstp';
      this._startProcessor();
    } else {
      this.mode = 'draw';
      this._startDrawLoop();
    }
    this.onTrackChanged(this.track);
    this.onUpdate(this.snapshot());
    return this.track;
  }

  _startProcessor() {
    const gen = ++this.generation;
    let processor;
    try {
      processor = new MediaStreamTrackProcessor({ track: this.sourceTrack });
    } catch (err) {
      this._fallback(`MediaStreamTrackProcessor: ${err.name}: ${err.message}`);
      return;
    }
    this.reader = processor.readable.getReader();
    const pump = async () => {
      while (this.running && gen === this.generation) {
        let result;
        try {
          result = await this.reader.read();
        } catch (err) {
          if (this.running && gen === this.generation) this.lastError = `read: ${err.message}`;
          return;
        }
        if (result.done || !this.running || gen !== this.generation) {
          result.value?.close?.();
          return;
        }
        const frame = result.value;
        try {
          this._consumeFrame(frame, gen);
        } finally {
          frame.close();
        }
      }
    };
    pump();
  }

  _consumeFrame(frame, gen) {
    const fw = frame.codedWidth;
    const fh = frame.codedHeight;
    const dimsChanged = fw !== this.frameW || fh !== this.frameH;
    this.frameW = fw;
    this.frameH = fh;
    if (dimsChanged) {
      this._recomputePlan(fw, fh);
    } else if (!this.plan) {
      this._recomputePlan(fw, fh);
    }
    if (!this.running || gen !== this.generation) return;
    if (!this.plan || !this.plan.crop) {
      this.outside = true;
      return;
    }
    this.outside = false;
    if (!this.demand) return;
    const now = performance.now();
    const gap = 1000 / this.targetFps;
    if (this.lastDrawAt && now - this.lastDrawAt < gap) {
      this.framesSkipped++;
      return;
    }
    this.lastDrawAt = now;
    const crop = this.plan.crop;
    // Crop with an explicit source rectangle on drawImage. Constructing
    // `new VideoFrame(frame, {rect})` looks tempting but that init member does
    // not exist in WebCodecs (it is `visibleRect`), and Chromium silently
    // ignores unknown dictionary members - the "cropped" frame is then the
    // whole screen, which encodes the top-left corner at the requested size.
    // A source-rect draw is unambiguous and keeps the native pixels.
    try {
      if (
        crop.x + crop.w > fw ||
        crop.y + crop.h > fh ||
        crop.x < 0 ||
        crop.y < 0
      ) {
        return;
      }
      this._draw(frame, crop.x, crop.y, crop.w, crop.h, this.plan.encW, this.plan.encH);
    } catch (err) {
      this.lastError = `crop: ${err.name}: ${err.message}`;
      this.onError(err);
    }
  }

  _draw(source, sx, sy, sw, sh, dw, dh) {
    if (sx === 0 && sy === 0 && sw === dw && sh === dh) {
      this.ctx.drawImage(source, 0, 0, dw, dh);
    } else {
      this.ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
    }
    this.framesDrawn++;
    this.lastFrameAt = performance.now();
    this.track?.requestFrame?.();
  }

  _startDrawLoop() {
    const gen = ++this.generation;
    const tick = () => {
      if (!this.running || gen !== this.generation) return;
      const v = this.previewVideo;
      if (!v || !v.videoWidth) {
        this.timer = setTimeout(tick, 50);
        return;
      }
      if (v.videoWidth !== this.frameW || v.videoHeight !== this.frameH) {
        this.frameW = v.videoWidth;
        this.frameH = v.videoHeight;
        this._recomputePlan(this.frameW, this.frameH);
      }
      if (!this.plan || !this.plan.crop) {
        this.outside = true;
        this.timer = setTimeout(tick, 200);
        return;
      }
      this.outside = false;
      if (!this.demand) {
        this.timer = setTimeout(tick, 200);
        return;
      }
      const crop = this.plan.crop;
      this._draw(v, crop.x, crop.y, crop.w, crop.h, this.plan.encW, this.plan.encH);
      this.timer = setTimeout(tick, 1000 / this.targetFps);
    };
    this.timer = setTimeout(tick, 0);
  }

  _fallback(reason) {
    this.lastError = reason;
    this.mode = 'draw';
    this._startDrawLoop();
    this.onTrackChanged(this.track);
    this.onUpdate(this.snapshot());
  }

  stop() {
    this.destroyed = true;
    this.running = false;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const reader = this.reader;
    this.reader = null;
    reader?.cancel?.().catch(() => {});
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try { t.stop(); } catch { /* already stopped */ }
      }
    }
    this.stream = null;
    this.track = null;
    this.mode = 'stopped';
    this.lastDrawAt = 0;
  }

  restart(frameW, frameH) {
    this.restarts++;
    this.stop();
    this.destroyed = false;
    return this.start(frameW, frameH);
  }

  /**
   * Share of the last cropped frame that is "ink" (pixels meaningfully darker
   * or lighter than the crop's own paper tone). A code/chart region keeps well
   * above one percent; a selection that now covers empty desktop or a blank
   * page falls to nearly zero. Used to notice that the content the presenter
   * framed has moved out from under the selection.
   */
  detailScore() {
    if (!this.running || !this.plan?.crop) return null;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return null;
    let data;
    try {
      data = this.ctx.getImageData(0, 0, w, h).data;
    } catch {
      return null;
    }
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
    const lum = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      }
    }
    if (!lum.length) return null;
    const sorted = lum.slice().sort((a, b) => a - b);
    const paper = sorted[(sorted.length * 0.9) | 0];
    let ink = 0;
    for (const v of lum) if (Math.abs(v - paper) > 28) ink++;
    return ink / lum.length;
  }

  snapshot() {
    const s = this.track?.getSettings?.() ?? {};
    return {
      mode: this.mode,
      mstpSupported: this.mstpSupported,
      running: this.running,
      frameW: this.frameW,
      frameH: this.frameH,
      outside: this.outside,
      targetFps: this.targetFps,
      demand: this.demand,
      framesDrawn: this.framesDrawn,
      framesSkipped: this.framesSkipped,
      restarts: this.restarts,
      lastFrameAt: this.lastFrameAt,
      lastError: this.lastError,
      canvas: { w: this.canvas.width, h: this.canvas.height },
      trackSettings: {
        width: s.width ?? null,
        height: s.height ?? null,
        frameRate: s.frameRate ?? null,
      },
      plan: this.plan
        ? {
            crop: this.plan.crop,
            coverage: Number(this.plan.coverage.toFixed(4)),
            clipped: this.plan.clipped,
            scale: Number(this.plan.scale.toFixed(4)),
            encW: this.plan.encW,
            encH: this.plan.encH,
            nativePixels: this.plan.nativePixels,
            encodedPixels: this.plan.encodedPixels,
          }
        : null,
    };
  }
}
