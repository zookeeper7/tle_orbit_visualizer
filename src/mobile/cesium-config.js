/**
 * Mobile-tuned Cesium Viewer configuration.
 *
 * Pure functions — no `cesium` import here, so the unit tests stay light
 * (jsdom + no WebGL). The numeric constants below mirror Cesium's enums so
 * the produced options object slots directly into `new Cesium.Viewer(...)`.
 *
 * Settings rationale comes from the CesiumJS mobile best-practices survey:
 *   - 2D default avoids the 3D globe tessellation cost on phone GPUs.
 *   - useBrowserRecommendedResolution=true caps internal canvas at the
 *     browser's DPR; we then dial it down further via resolutionScale.
 *   - requestRenderMode + maximumRenderTimeChange=1/30 caps the render
 *     loop at ~30 FPS, which is the single biggest battery/heat win.
 *   - MSAA 1 on low-end / 2 on mid-range (Firefox always 1 — known
 *     vite-plugin-cesium / Firefox MSAA artifact).
 *   - powerPreference 'low-power' hints the integrated GPU.
 *   - preserveDrawingBuffer=false (mobile has no recording feature).
 *   - All built-in Cesium UI chrome disabled — saves DOM cost.
 */

// Numeric enums — match Cesium 1.139 source.
//   Cesium.SceneMode.SCENE2D = 2
//   Cesium.MapMode2D.ROTATE  = 1 (single-Earth, no infinite scroll)
const SCENE_MODE_2D = 2;
const MAP_MODE_2D_ROTATE = 1;

/**
 * Pick a resolutionScale based on the device's CPU cores and pixel density.
 * Lower scale = fewer rendered pixels = lower GPU/battery.
 *
 * Rationale for the DPR branch first: a DPR of 1 means we're either on a
 * desktop monitor (incl. DevTools mobile emulation) or a very old phone.
 * In either case there is no "free" DPR multiplier on top of the
 * resolutionScale, so dialing scale below 1.0 just makes the canvas look
 * pixelated for no real perf win. Phones with DPR ≥ 2 then fall through
 * to the cores/DPR matrix that picks 0.75 / 1.0.
 *
 * The mid-range (>4 cores, DPR=2) tier renders at the native browser
 * resolution because requestRenderMode caps the average GPU duty cycle
 * to whatever the playback rate demands, so the perf headroom is in the
 * MSAA / globe-detail knobs rather than in undersampling the canvas.
 *
 * @param {{ hardwareConcurrency?: number, devicePixelRatio?: number }} [input]
 * @returns {number} 0.75 / 1.0
 */
export function pickResolutionScale({ hardwareConcurrency, devicePixelRatio } = {}) {
  const cores = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 6;
  const dpr = Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;

  if (dpr <= 1) return 1.0;                    // desktop / DevTools mobile mode
  if (cores <= 4) return 0.75;                 // low-end mobile (was 0.5)
  return 1.0;                                  // mid-range and high-end mobile
}

/**
 * Pick scene.msaaSamples. Firefox has a long-standing MSAA artifact with
 * Cesium so it is always forced to 1 there.
 *
 * @param {{ hardwareConcurrency?: number, userAgent?: string }} [input]
 * @returns {number} 1 / 2 / 4
 */
export function pickMsaaSamples({ hardwareConcurrency, userAgent } = {}) {
  const ua = userAgent || '';
  if (/firefox/i.test(ua)) return 1;
  const cores = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 6;
  if (cores <= 4) return 2;                    // low-end mobile (was 1)
  return 4;                                    // mid-range and up (was 2)
}

/**
 * Build the full options object for `new Cesium.Viewer(container, options)`.
 *
 * `resolutionScale` and `msaaSamples` are NOT in the Viewer constructor —
 * the caller applies them post-construction (see mobile-main.js).
 *
 * @param {{ hardwareConcurrency?: number, devicePixelRatio?: number, userAgent?: string }} [_input]
 * @returns {object} A plain object suitable to spread into the Viewer ctor.
 */
export function buildMobileViewerOptions(_input = {}) {
  return {
    // Camera mode
    sceneMode: SCENE_MODE_2D,
    mapMode2D: MAP_MODE_2D_ROTATE,
    scene3DOnly: false,

    // Resolution — never disable on mobile
    useBrowserRecommendedResolution: true,

    // Strip every built-in widget; mobile has its own top bar + sheet
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    navigationHelpButton: false,
    navigationInstructionsInitiallyVisible: false,

    // Clock — animate by default for orbit playback
    shouldAnimate: true,

    // Render mode — caller pins maximumRenderTimeChange to 1/30 post-init
    requestRenderMode: true,
    maximumRenderTimeChange: 1 / 30,

    // Shadows are very expensive on mobile GPUs — always off
    shadows: false,

    // WebGL context hints
    contextOptions: {
      webgl: {
        powerPreference: 'low-power',
        antialias: false,                // we use scene.msaaSamples instead
        preserveDrawingBuffer: false,    // no recording on mobile
      },
    },
  };
}

/**
 * Apply post-construction Viewer tweaks that aren't constructor options.
 * Idempotent — safe to call multiple times.
 *
 * @param {object} viewer - Cesium.Viewer instance
 * @param {{ resolutionScale: number, msaaSamples: number }} [overrides]
 */
export function applyMobileViewerTweaks(viewer, { resolutionScale, msaaSamples } = {}) {
  if (!viewer || !viewer.scene) return;

  if (Number.isFinite(resolutionScale)) {
    viewer.resolutionScale = resolutionScale;
  }
  if (Number.isFinite(msaaSamples) && typeof viewer.scene.msaaSamples === 'number') {
    viewer.scene.msaaSamples = msaaSamples;
  }
  if (viewer.scene.postProcessStages?.fxaa) {
    viewer.scene.postProcessStages.fxaa.enabled = false;
  }

  // Globe — tighter screen-space error and a larger tile cache give a
  // noticeably crisper map at typical phone pinch-zoom distances; both
  // costs are bounded by requestRenderMode + the global resolutionScale.
  const g = viewer.scene.globe;
  if (g) {
    g.maximumScreenSpaceError = 2;             // was 4 — half the tile coarseness
    g.tileCacheSize = 100;                     // was 50 — fewer re-loads on pan
    g.preloadSiblings = false;
    g.preloadAncestors = true;
    g.enableLighting = false;
    g.showGroundAtmosphere = false;
  }

  // Atmosphere / fog / lights / HDR — none of these earn their cost on mobile
  if (viewer.scene.fog) {
    viewer.scene.fog.enabled = false;
    if ('renderable' in viewer.scene.fog) viewer.scene.fog.renderable = false;
  }
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
  if ('highDynamicRange' in viewer.scene) viewer.scene.highDynamicRange = false;
  if (viewer.scene.sun) viewer.scene.sun.show = false;
  if (viewer.scene.moon) viewer.scene.moon.show = false;

  // Camera controller — disable free-look (confusing on touch)
  const sscc = viewer.scene.screenSpaceCameraController;
  if (sscc) {
    sscc.enableLook = false;
    if (Number.isFinite(sscc.minimumZoomDistance) || 'minimumZoomDistance' in sscc) {
      sscc.minimumZoomDistance = 1000;
    }
  }
}
