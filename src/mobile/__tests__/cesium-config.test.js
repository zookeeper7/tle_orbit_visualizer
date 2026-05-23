import { describe, it, expect } from 'vitest';
import { pickResolutionScale, pickMsaaSamples, buildMobileViewerOptions } from '../cesium-config.js';

describe('pickResolutionScale', () => {
  // Desktop / DevTools mobile (DPR=1) — always full
  it('DPR=1 with 8 cores (desktop or DevTools mobile mode) → 1.0', () => {
    expect(pickResolutionScale({ hardwareConcurrency: 8, devicePixelRatio: 1 })).toBe(1.0);
  });

  it('DPR=1 with 2 cores → 1.0 (no DPR multiplier to hide low-res)', () => {
    expect(pickResolutionScale({ hardwareConcurrency: 2, devicePixelRatio: 1 })).toBe(1.0);
  });

  // Low-end mobile: DPR≥2 + ≤4 cores
  it('low-end (2 cores, DPR 2) → 0.75', () => {
    expect(pickResolutionScale({ hardwareConcurrency: 2, devicePixelRatio: 2 })).toBe(0.75);
  });

  it('low-end (4 cores, DPR 3) → 0.75', () => {
    expect(pickResolutionScale({ hardwareConcurrency: 4, devicePixelRatio: 3 })).toBe(0.75);
  });

  // Mid-range: >4 cores, DPR=2
  it('mid-range (6 cores, DPR 2) → 1.0', () => {
    expect(pickResolutionScale({ hardwareConcurrency: 6, devicePixelRatio: 2 })).toBe(1.0);
  });

  it('mid-range (8 cores, DPR 2) → 1.0', () => {
    expect(pickResolutionScale({ hardwareConcurrency: 8, devicePixelRatio: 2 })).toBe(1.0);
  });

  // High-end: >4 cores, DPR=3
  it('high-end (8 cores, DPR 3) → 1.0', () => {
    expect(pickResolutionScale({ hardwareConcurrency: 8, devicePixelRatio: 3 })).toBe(1.0);
  });

  // Defaults
  it('missing hardwareConcurrency, DPR=2 → mid-range 1.0', () => {
    expect(pickResolutionScale({ devicePixelRatio: 2 })).toBe(1.0);
  });

  it('missing devicePixelRatio (defaults to 1) → 1.0', () => {
    expect(pickResolutionScale({ hardwareConcurrency: 8 })).toBe(1.0);
  });

  it('no input → DPR=1 fallback → 1.0', () => {
    expect(pickResolutionScale()).toBe(1.0);
  });
});

describe('pickMsaaSamples', () => {
  it('low-end (2 cores) → 2', () => {
    expect(pickMsaaSamples({ hardwareConcurrency: 2 })).toBe(2);
  });

  it('mid-range (8 cores) → 4', () => {
    expect(pickMsaaSamples({ hardwareConcurrency: 8 })).toBe(4);
  });

  it('Firefox UA forces 1 regardless of cores', () => {
    expect(pickMsaaSamples({ hardwareConcurrency: 8, userAgent: 'Mozilla/5.0 Firefox/120.0' })).toBe(1);
  });

  it('no input → mid-range default (4)', () => {
    expect(pickMsaaSamples()).toBe(4);
  });
});

describe('buildMobileViewerOptions', () => {
  it('returns expected mobile-tuned viewer options shape', () => {
    const opts = buildMobileViewerOptions({ hardwareConcurrency: 8, devicePixelRatio: 2 });

    // sceneMode is a numeric enum from Cesium (SCENE2D === 2). Don't import
    // cesium here to keep the test pure; just assert the numeric value
    // matches Cesium.SceneMode.SCENE2D.
    expect(opts.sceneMode).toBe(2);

    expect(opts.useBrowserRecommendedResolution).toBe(true);
    expect(opts.shadows).toBe(false);
    expect(opts.animation).toBe(false);
    expect(opts.baseLayerPicker).toBe(false);
    expect(opts.fullscreenButton).toBe(false);
    expect(opts.geocoder).toBe(false);
    expect(opts.homeButton).toBe(false);
    expect(opts.infoBox).toBe(false);
    expect(opts.sceneModePicker).toBe(false);
    expect(opts.selectionIndicator).toBe(false);
    expect(opts.timeline).toBe(false);
    expect(opts.navigationHelpButton).toBe(false);

    expect(opts.contextOptions.webgl.powerPreference).toBe('low-power');
    expect(opts.contextOptions.webgl.antialias).toBe(false);
    expect(opts.contextOptions.webgl.preserveDrawingBuffer).toBe(false);

    // mapMode2D === MapMode2D.ROTATE (numeric enum 1)
    expect(opts.mapMode2D).toBe(1);
  });
});
