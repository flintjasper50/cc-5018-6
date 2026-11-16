// Focus-region geometry and clarity policy.
//
// The presenter stores a selection as *normalized* coordinates (fractions of
// the captured frame), never as pixels. A display-scale change or a source
// resize then re-projects the same content automatically instead of leaving a
// stale pixel rectangle behind. Everything that touches the actual capture is
// clamped to the frame bounds: a crop can only ever be computed from pixels
// that exist.

export const REGION_LIMITS = {
  // A selection thinner than this has no room for a legible glyph column.
  minSidePx: 96,
  // Above this the encoder is asked to scale down. Even then the region keeps
  // far more pixels per glyph than the full-screen ladder rung does.
  maxEncodeWidth: 1920,
  maxEncodeHeight: 1200,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function normalizeSelection(rect) {
  const x0 = clamp(Math.min(rect.x, rect.x + rect.w), 0, 1);
  const y0 = clamp(Math.min(rect.y, rect.y + rect.h), 0, 1);
  const x1 = clamp(Math.max(rect.x, rect.x + rect.w), 0, 1);
  const y1 = clamp(Math.max(rect.y, rect.y + rect.h), 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function selectionFromPoints(a, b, frameW, frameH) {
  if (!(frameW > 0) || !(frameH > 0)) return null;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  return normalizeSelection({
    x: x0 / frameW,
    y: y0 / frameH,
    w: (x1 - x0) / frameW,
    h: (y1 - y0) / frameH,
  });
}

export function rectPixels(norm, frameW, frameH) {
  return {
    x: norm.x * frameW,
    y: norm.y * frameH,
    w: norm.w * frameW,
    h: norm.h * frameH,
  };
}

/**
 * Intersection of `rect` with the frame, rounded to integers. Returns null when
 * nothing remains - the caller must stop the region track rather than send a
 * crop padded with pixels that are not part of the source.
 */
export function clampRectToFrame(rect, frameW, frameH) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(frameW, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(frameH, Math.ceil(rect.y + rect.h));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function area(r) {
  return r ? Math.max(0, r.w) * Math.max(0, r.h) : 0;
}

/**
 * Resolve a normalized selection against the *current* capture size.
 *
 * `coverage` is the share of the requested selection that lies inside the
 * frame. Below 1 the UI must say so; at 0 the region cannot be sent at all.
 */
export function planRegion(norm, frameW, frameH, limits = REGION_LIMITS) {
  if (!norm || !(frameW > 0) || !(frameH > 0)) return null;
  const want = rectPixels(norm, frameW, frameH);
  const crop = clampRectToFrame(want, frameW, frameH);
  if (!crop) {
    return {
      want,
      crop: null,
      coverage: 0,
      clipped: true,
      scale: 0,
      encW: 0,
      encH: 0,
      nativePixels: 0,
      encodedPixels: 0,
    };
  }
  // Integer rounding of the crop can make it a pixel wider than the requested
  // rectangle, which would read as >100% coverage. Clamp: coverage is a share
  // of the selection that is inside the source, and it cannot exceed all of it.
  const coverage = area(want) > 0 ? Math.min(1, area(crop) / area(want)) : 0;
  // Clarity-first: encode the crop at its native pixel size. Only a selection
  // larger than the encoder cap is scaled down, and that scale is reported so
  // the UI can never imply 1:1 when it is not.
  const scale = Math.min(
    1,
    limits.maxEncodeWidth / crop.w,
    limits.maxEncodeHeight / crop.h,
  );
  const encW = even(crop.w * scale);
  const encH = even(crop.h * scale);
  return {
    want,
    crop,
    coverage,
    clipped: coverage < 0.999,
    scale,
    encW,
    encH,
    nativePixels: crop.w * crop.h,
    encodedPixels: encW * encH,
  };
}

/**
 * Pixels the same physical rectangle gets in the full-screen stream at its
 * current encoded size. This is the comparison that matters: the full stream
 * still carries the whole desktop, so the region occupies only this share.
 */
export function fullStreamAllocation(crop, frameW, frameH, fullEncW, fullEncH) {
  if (!crop || !(frameW > 0) || !(frameH > 0) || !(fullEncW > 0) || !(fullEncH > 0)) {
    return null;
  }
  const w = Math.max(2, Math.round((crop.w * fullEncW) / frameW));
  const h = Math.max(2, Math.round((crop.h * fullEncH) / frameH));
  return { w, h, pixels: w * h };
}

export function detailComparison({ plan, fullAlloc }) {
  if (!plan || !plan.crop || !fullAlloc) return null;
  const regionPixels = plan.encW * plan.encH;
  return {
    regionPixels,
    fullPixels: fullAlloc.pixels,
    // Area ratio; the square root is the linear pixel-density ratio a glyph
    // actually experiences.
    pixelGain: fullAlloc.pixels > 0 ? regionPixels / fullAlloc.pixels : 0,
    linearGain: fullAlloc.pixels > 0 ? Math.sqrt(regionPixels / fullAlloc.pixels) : 0,
    nativeFill: plan.nativePixels > 0 ? Math.min(1, regionPixels / plan.nativePixels) : 0,
  };
}

/**
 * Clarity-first bitrate policy for the region track.
 *
 * The region gets its own bits-per-pixel target rather than a slice of the
 * full-screen ceiling. The returned value is a ceiling, not a claim: what is
 * actually sent is read back from outbound-rtp and reported separately.
 */
export function regionBitrateCeiling({ encW, encH, fps, bpp = 0.14, minKbps = 350, maxKbps = 6000 }) {
  const px = Math.max(1, encW * encH);
  const want = Math.round((px * Math.max(1, fps) * bpp) / 1000);
  return clamp(want, minKbps, maxKbps);
}

export function bitsPerPixel({ kbps, fps, width, height }) {
  if (!(kbps > 0) || !(fps > 0) || !(width > 0) || !(height > 0)) return null;
  return (kbps * 1000) / (fps * width * height);
}

/**
 * Derive the anomalies the screen-live panel must surface. Pure so the
 * experiment/report can assert on exactly what the presenter displayed.
 */
export function regionAnomalies({
  mode,
  hasSelection,
  plan,
  region,
  full,
  estimateKbps,
  wantViewers,
  anchorLost,
  thresholds = {},
}) {
  const t = {
    minSidePx: REGION_LIMITS.minSidePx,
    queueMs: 160,
    linkUse: 0.98,
    encodedFloor: 0.9,
    ...thresholds,
  };
  const out = [];
  if (mode !== 'region') return out;

  if (!hasSelection) {
    out.push({ code: 'no-selection', level: 'warn', text: '重点区域模式已开启，但尚未框选区域。' });
    return out;
  }
  if (!plan || !plan.crop) {
    out.push({
      code: 'region-outside-source',
      level: 'bad',
      text: '框选区域已完全落在共享源之外，区域轨道已停止发送。请重新框选。',
    });
    return out;
  }
  if (plan.clipped) {
    out.push({
      code: 'region-clipped',
      level: 'warn',
      text:
        `选区有 ${((1 - plan.coverage) * 100).toFixed(0)}% 落在共享源之外，已按 ` +
        `${plan.crop.w}x${plan.crop.h} 裁剪；不会采集范围外内容。`,
    });
  }
  if (plan.crop.w < t.minSidePx || plan.crop.h < t.minSidePx) {
    out.push({
      code: 'region-too-small',
      level: 'warn',
      text: `区域裁剪后仅 ${plan.crop.w}x${plan.crop.h}，低于 ${t.minSidePx}px 的可读下限。`,
    });
  }
  if (anchorLost) {
    out.push({
      code: 'region-content-lost',
      level: 'bad',
      text: '区域内容已失去细节（可能已移出选区或来源空白），已暂停区域轨道，避免继续发送无关画面。',
    });
  }
  if (wantViewers > 0 && !anchorLost && (!region || !region.framesEncoded)) {
    out.push({
      code: 'region-stalled',
      level: 'bad',
      text: `有 ${wantViewers} 位观看者请求重点区域，但没有区域帧被编码；检查裁剪管线。`,
    });
  }
  if (region) {
    if (region.qualityLimitation === 'bandwidth') {
      out.push({
        code: 'region-bandwidth-limited',
        level: 'bad',
        text: `区域编码受带宽限制（${region.kbps ?? 0} kbps，目标 ${region.targetKbps ?? 0} kbps）。`,
      });
    }
    if (
      region.encodedWidth > 0 &&
      plan.encW > 0 &&
      region.encodedWidth < plan.encW * t.encodedFloor
    ) {
      out.push({
        code: 'region-downscaled',
        level: 'warn',
        text:
          `区域实际编码 ${region.encodedWidth}x${region.encodedHeight}，低于原生裁剪 ` +
          `${plan.encW}x${plan.encH}，清晰度已打折。`,
      });
    }
    if ((region.queueDelayMs ?? 0) > t.queueMs) {
      out.push({
        code: 'region-queue',
        level: 'warn',
        text: `区域发送队列延迟 ${Math.round(region.queueDelayMs)} ms，编码器可能跟不上。`,
      });
    }
  }
  if (full && region && estimateKbps > 0) {
    const totalKbps = (full.kbps ?? 0) + (region.kbps ?? 0);
    if (totalKbps > estimateKbps * t.linkUse) {
      out.push({
        code: 'total-over-estimate',
        level: 'warn',
        text:
          `整屏 + 区域合计 ${Math.round(totalKbps)} kbps，已接近可用带宽估计 ` +
          `${Math.round(estimateKbps)} kbps。整屏档位可能因此下调。`,
      });
    }
  }
  return out;
}
