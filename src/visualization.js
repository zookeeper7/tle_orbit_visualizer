import * as Cesium from 'cesium';
import { computeCoverageRadiusKm } from './ground-stations.js';

// ─── Design Tokens (mirrors CSS glassmorphism palette) ───
const ACCENT = Cesium.Color.fromCssColorString('#7dd3fc');          // sky-300
const ACCENT_DIM = Cesium.Color.fromCssColorString('#7dd3fc').withAlpha(0.35);
const GOLD = Cesium.Color.fromCssColorString('#fbbf24');            // amber-400
const GOLD_GLOW = Cesium.Color.fromCssColorString('#fbbf24').withAlpha(0.35);
const CORAL = Cesium.Color.fromCssColorString('#fb7185');           // rose-400
const GLASS_BG = new Cesium.Color(0.047, 0.055, 0.11, 0.7);       // rgba(12,14,28,0.7)
const LABEL_OUTLINE = new Cesium.Color(0.02, 0.02, 0.06, 0.9);    // deep navy

// ─── Tapered orbit configuration ───
// Each band radiates from the satellite's current position outward.
// Band 0 = closest to satellite (thickest), Band N-1 = furthest (thinnest).
// Widths went through: original → ½ → ¼ (too thin per user) → ⅓ here.
const TAPER_BANDS = 6;
const TAPER_WIDTHS_3D = [2.0, 1.6, 1.2, 0.9, 0.6, 0.3];
const TAPER_WIDTHS_2D = [1.5, 1.2, 0.9, 0.6, 0.4, 0.2];
const TAPER_ALPHAS    = [1.0, 0.72, 0.50, 0.32, 0.18, 0.08];
const TAPER_GLOWS     = [0.18, 0.14, 0.10, 0.07, 0.04, 0.02];

// Wall-time throttle (ms) for tapered-trail cache invalidation. At high clock
// multipliers (10× and above) the slice indices can change every few frames,
// which triggers 36 simultaneous GroundPolyline re-tessellations and stalls
// the frame. Capping invalidation at 100 ms wall time = 10 Hz trail update
// → visually the trail lags by at most 100 ms (a satellite at 7 km/s
// orbital speed moves ~700 m in 100 ms — invisible on the map).
const TAPER_REFRESH_MS = 100;

// ─── Entity tracking ───
let _satelliteEntity = null;
/** @type {Array<{satelliteEntity: Cesium.Entity, taper3d: Cesium.Entity[], taper2d: Cesium.Entity[], d3Only: Cesium.Entity[], groundTrack3d: Cesium.Entity[]}>} */
let _satelliteVisuals = [];
let _gsEntities = [];        // ground station markers + coverage

/**
 * Create the full orbit visualization on the Cesium viewer.
 * The orbit trail uses tapered polyline bands — thickest near
 * the satellite's current position, thinning toward past/future.
 *
 * @returns {Cesium.Entity} The satellite entity
 */
export function createOrbitVisualization(viewer, name, positions, orbitalInfo, options, color = '#7dd3fc') {
  clearVisualization(viewer);
  const entity = addSatelliteVisualization(viewer, name, positions, orbitalInfo, options, color);

  const startTime = Cesium.JulianDate.fromDate(positions[0].date);
  const stopTime = Cesium.JulianDate.fromDate(positions[positions.length - 1].date);
  viewer.clock.startTime = startTime.clone();
  viewer.clock.stopTime = stopTime.clone();
  viewer.clock.currentTime = Cesium.JulianDate.now();
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
  viewer.clock.multiplier = 1;
  viewer.clock.shouldAnimate = true;

  const avgAlt = orbitalInfo.semiMajorAxis;
  viewer.zoomTo(entity, new Cesium.HeadingPitchRange(
    0,
    Cesium.Math.toRadians(-35),
    avgAlt * 3000,
  ));

  applySceneMode(viewer);
  return entity;
}

export function addSatelliteVisualization(viewer, name, positions, orbitalInfo, options, color = '#7dd3fc') {
  const satColor = Cesium.Color.fromCssColorString(color);

  // Polyline arc type. Default GEODESIC (Cesium's own default) so desktop
  // keeps drawing great-circle arcs between samples. The mobile build
  // overrides this to ArcType.NONE to dodge a "RangeError: Invalid array
  // length" thrown inside generateCartesianArc — on low-power mobile
  // WebGL contexts starting in SCENE2D, the geodesic tessellation hits a
  // numerical edge case and stops the entire render loop. With NONE the
  // polyline is drawn as straight-line segments between samples; since
  // each propagation sample is ≤ 1 minute (≤ ~450 km) apart the visual
  // difference is invisible at typical zoom levels.
  const arcType = (options && options.arcType !== undefined) ? options.arcType : undefined;

  // Per-satellite label sprite scale. Mobile passes a larger value so the
  // text reads cleanly on a small, high-DPR phone screen where the
  // default 0.35 (matched to desktop's 1080p+ landscape viewport) ends up
  // tiny. The label texture itself is still rasterized at the same font
  // size, so a larger scale = the same crisp glyphs painted onto a bigger
  // sprite — no blur from up-scaling.
  const labelScale = (options && Number.isFinite(options.labelScale))
    ? options.labelScale
    : 0.35;
  const labelOutlineWidth = (options && Number.isFinite(options.labelOutlineWidth))
    ? options.labelOutlineWidth
    : 5;

  // --- Build SampledPositionProperty (at altitude) ---
  const sampledPosition = new Cesium.SampledPositionProperty();
  sampledPosition.setInterpolationOptions({
    interpolationDegree: 5,
    interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
  });

  // --- Build SampledPositionProperty (ground / nadir) ---
  const nadirPosition = new Cesium.SampledPositionProperty();
  nadirPosition.setInterpolationOptions({
    interpolationDegree: 5,
    interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
  });

  for (const pos of positions) {
    // Belt-and-suspenders: propagateOrbit already drops NaN samples, but
    // if a caller hands us hand-built positions we still refuse to feed
    // NaN into Cesium. A single NaN cartesian inside a
    // SampledPositionProperty propagates to the entity's BoundingSphere
    // and trips createPotentiallyVisibleSet with "Invalid array length".
    if (
      !pos
      || !Number.isFinite(pos.longitude)
      || !Number.isFinite(pos.latitude)
      || !Number.isFinite(pos.height)
    ) {
      continue;
    }
    const time = Cesium.JulianDate.fromDate(pos.date);
    sampledPosition.addSample(
      time,
      Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.height * 1000),
    );
    nadirPosition.addSample(
      time,
      Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, 0),
    );
  }

  const startTime = Cesium.JulianDate.fromDate(positions[0].date);
  const stopTime = Cesium.JulianDate.fromDate(positions[positions.length - 1].date);
  const availability = new Cesium.TimeIntervalCollection([
    new Cesium.TimeInterval({ start: startTime, stop: stopTime }),
  ]);

  const satelliteEntity = viewer.entities.add({
    name,
    position: sampledPosition,
    availability,
    point: {
      pixelSize: 14,
      color: satColor,
      outlineColor: satColor.withAlpha(0.35),
      outlineWidth: 3,
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 4e7, 0.8),
      translucencyByDistance: new Cesium.NearFarScalar(1e3, 1.0, 5e7, 0.7),
    },
    label: {
      text: name,
      font: '600 48px "Segoe UI", system-ui, sans-serif',
      scale: labelScale,
      fillColor: satColor,
      outlineColor: LABEL_OUTLINE,
      outlineWidth: labelOutlineWidth,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(18, -10),
      showBackground: true,
      backgroundColor: GLASS_BG,
      backgroundPadding: new Cesium.Cartesian2(20, 10),
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 4e7, 0.75),
      translucencyByDistance: new Cesium.NearFarScalar(1e3, 1.0, 5e7, 0.7),
    },
  });

  const d3Only = [];
  const taper3d = [];
  const taper2d = [];
  const groundTrack3d = [];

  const nadirMarker = viewer.entities.add({
    name: `${name} — Nadir`,
    position: nadirPosition,
    availability,
    point: {
      pixelSize: 8,
      color: CORAL,
      outlineColor: CORAL.withAlpha(0.3),
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.2, 4e7, 0.6),
      translucencyByDistance: new Cesium.NearFarScalar(1e3, 1.0, 4e7, 0.5),
    },
  });
  d3Only.push(nadirMarker);

  const nadirLine = viewer.entities.add({
    name: `${name} — Nadir Line`,
    availability,
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        const now = viewer.clock.currentTime;
        const satPos = sampledPosition.getValue(now);
        const gndPos = nadirPosition.getValue(now);
        if (!satPos || !gndPos) return [];
        return [satPos, gndPos];
      }, false),
      width: 1,
      material: new Cesium.PolylineDashMaterialProperty({
        color: CORAL.withAlpha(0.3),
        dashLength: 16,
      }),
      arcType,
    },
  });
  d3Only.push(nadirLine);

  for (let side = 0; side < 2; side++) {
    const isPast = side === 0;
    for (let b = 0; b < TAPER_BANDS; b++) {
      const e3d = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(makeTaperCB(viewer, positions, isPast, b, false), false),
          width: TAPER_WIDTHS_3D[b],
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: TAPER_GLOWS[b],
            color: satColor.withAlpha(TAPER_ALPHAS[b]),
          }),
          arcType,
        },
      });
      taper3d.push(e3d);

      const e2d = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(makeTaperCB(viewer, positions, isPast, b, true), false),
          width: TAPER_WIDTHS_2D[b],
          material: satColor.withAlpha(TAPER_ALPHAS[b] * 0.7),
          arcType,
          // clampToGround REMOVED: the taper2d bands are only ever shown in
          // SCENE2D, and makeTaperCB already returns Cartesian3 positions
          // with altitude 0 when isGround=true. In the 2D Mercator
          // projection, altitude-0 polylines render exactly on the imagery
          // plane — visually identical to clampToGround at altitude 0 —
          // but they go through the regular Polyline path (single draw
          // call, no GroundPolylinePrimitive tessellation). At 10× clock
          // multiplier the previous GroundPolyline tessellation was the
          // ~600 ms-per-cache-miss bottleneck that drove playback to ~1.5 fps;
          // the regular Polyline path makes the same operation ~10-20× cheaper.
        },
      });
      taper2d.push(e2d);
    }
  }

  // The ground-track polyline uses clampToGround: true → it's a
  // GroundPolyline whose great-circle tessellation goes through
  // generateCartesianArc. On the mobile viewer (SCENE2D default,
  // low-power WebGL, smaller tile cache) that path occasionally
  // crashes with "Invalid array length". Callers that prefer to skip
  // this affordance can pass options.drawGroundTrack = false.
  const drawGroundTrack = !options || options.drawGroundTrack !== false;
  if (drawGroundTrack) {
    const segments = splitAtAntimeridian(positions);
    for (const seg of segments) {
      const cartesians = seg.map(p => Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, 0));
      const gt3d = viewer.entities.add({
        polyline: {
          positions: cartesians,
          width: 1,
          material: new Cesium.PolylineDashMaterialProperty({
            color: satColor.withAlpha(0.12),
            dashLength: 16,
          }),
          clampToGround: true,
        },
      });
      groundTrack3d.push(gt3d);
    }
  }

  _satelliteEntity = satelliteEntity;
  _satelliteVisuals.push({ satelliteEntity, taper3d, taper2d, d3Only, groundTrack3d });
  applySceneMode(viewer);
  return satelliteEntity;
}

// ─────────────────────────────────────────────
// Tapered orbit helpers
// ─────────────────────────────────────────────

/**
 * Binary search for the index in _orbitPositions closest to targetMs.
 */
function findClosestIndex(arr, targetMs) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].date.getTime() < targetMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const dLo = Math.abs(arr[lo].date.getTime() - targetMs);
    const dPrev = Math.abs(arr[lo - 1].date.getTime() - targetMs);
    if (dPrev < dLo) return lo - 1;
  }
  return lo;
}

/**
 * Create a CallbackProperty function for a single taper band.
 *
 * @param {Cesium.Viewer} viewer
 * @param {boolean} isPast - true for past bands, false for future
 * @param {number} bandIdx - 0 = nearest to satellite, TAPER_BANDS-1 = furthest
 * @param {boolean} isGround - true → height 0 (2D), false → actual altitude (3D)
 */
function makeTaperCB(viewer, orbitPositions, isPast, bandIdx, isGround) {
  // Per-band memoization cache. Each callback closure owns its own cache so
  // bands don't conflict. Cache invalidation has TWO gates:
  //   (a) wall-time throttle (TAPER_REFRESH_MS) — caps invalidation rate at
  //       10 Hz regardless of clock multiplier. Critical at 10×+ where ci
  //       changes every few frames and the un-throttled cache would trigger
  //       36 simultaneous GroundPolyline re-tessellations per ci change.
  //   (b) slice-index match (startIdx === cached && endIdx === cached) —
  //       returns the SAME array reference when the window hasn't moved,
  //       so Cesium's PolylineGeometryUpdater sees no change and skips
  //       re-tessellation entirely.
  const EMPTY = [];
  let cachedStartIdx = -1;
  let cachedEndIdx = -1;
  let cachedResult = EMPTY;
  let cachedWallMs = 0;

  return function () {
    // Short-circuit: bands hidden by the current scene mode still have their
    // CallbackProperty invoked every frame even though `entity.show=false`.
    // Return the same empty sentinel so Cesium sees no change.
    const is3DMode = viewer.scene.mode === Cesium.SceneMode.SCENE3D;
    if (isGround === is3DMode) return EMPTY;

    // Wall-time throttle. If less than TAPER_REFRESH_MS has elapsed since
    // the last cache refresh AND we have a cached result, return it without
    // any further work. This is the single biggest 10×/60×/360× win.
    const wallNow = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    if (cachedResult.length > 0 && wallNow - cachedWallMs < TAPER_REFRESH_MS) {
      return cachedResult;
    }

    const n = orbitPositions.length;
    if (n < 2) return EMPTY;

    const nowMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
    const ci = findClosestIndex(orbitPositions, nowMs); // current index

    let startIdx, endIdx;

    if (isPast) {
      const count = ci;
      if (count < 1) return EMPTY;
      const bandSize = Math.max(1, Math.ceil(count / TAPER_BANDS));
      // Band 0 ends AT ci (inclusive), band 1 ends at ci-bandSize, etc.
      const bandEnd = ci - bandIdx * bandSize;
      const bandStart = Math.max(0, bandEnd - bandSize);
      if (bandEnd <= bandStart) return EMPTY;
      startIdx = bandStart;
      endIdx = bandEnd + 1; // +1 because slice is exclusive; includes ci for band 0
    } else {
      const count = n - 1 - ci;
      if (count < 1) return EMPTY;
      const bandSize = Math.max(1, Math.ceil(count / TAPER_BANDS));
      // Band 0 starts AT ci (inclusive), band 1 starts at ci+bandSize, etc.
      const bandStart = ci + bandIdx * bandSize;
      const bandEnd = Math.min(n - 1, bandStart + bandSize);
      if (bandEnd <= bandStart) return EMPTY;
      startIdx = bandStart;
      endIdx = bandEnd + 1; // +1 for slice exclusivity
    }

    if (endIdx - startIdx < 2) return EMPTY;

    // Slice-index cache hit: window has not advanced — return the SAME
    // array reference. (Wall-time throttle above already handles the case
    // where indices DID change but not enough time has passed; this guard
    // catches the slow-multiplier case where ci genuinely hasn't moved.)
    if (startIdx === cachedStartIdx && endIdx === cachedEndIdx && cachedResult.length > 0) {
      cachedWallMs = wallNow; // refresh wall-time anchor so the throttle stays accurate
      return cachedResult;
    }

    cachedStartIdx = startIdx;
    cachedEndIdx = endIdx;
    cachedWallMs = wallNow;
    cachedResult = orbitPositions.slice(startIdx, endIdx).map(p =>
      Cesium.Cartesian3.fromDegrees(
        p.longitude, p.latitude,
        isGround ? 0 : p.height * 1000,
      ),
    );
    return cachedResult;
  };
}

// ─────────────────────────────────────────────
// Scene Mode Toggle (lightweight — no entity recreation)
// ─────────────────────────────────────────────

/**
 * Toggle entity visibility based on current scene mode.
 * Called once after creation, and again on every morphComplete event.
 */
export function applySceneMode(viewer) {
  const is3D = viewer.scene.mode === Cesium.SceneMode.SCENE3D;

  for (const sat of _satelliteVisuals) {
    for (const e of sat.taper3d) e.show = is3D;
    for (const e of sat.taper2d) e.show = !is3D;
    for (const e of sat.d3Only) e.show = is3D;
    for (const e of sat.groundTrack3d) e.show = is3D;
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Split positions into segments at antimeridian crossings.
 */
function splitAtAntimeridian(positions) {
  const segments = [];
  let current = [];

  for (let i = 0; i < positions.length; i++) {
    current.push(positions[i]);

    if (i < positions.length - 1) {
      const lonDiff = Math.abs(positions[i + 1].longitude - positions[i].longitude);
      if (lonDiff > 270) {
        if (current.length > 1) segments.push(current);
        current = [];
      }
    }
  }
  if (current.length > 1) segments.push(current);

  return segments;
}

// ─────────────────────────────────────────────
// Ground Station Visualization
// ─────────────────────────────────────────────

const GS_COLOR = Cesium.Color.fromCssColorString('#22c55e');

/**
 * Render ground station markers and coverage circles.
 */
export function createGroundStationVisuals(viewer, stations, avgAltKm) {
  clearGroundStations(viewer);

  for (const gs of stations) {
    // Coverage circle
    if (avgAltKm !== null && avgAltKm > 0) {
      const radiusKm = computeCoverageRadiusKm(avgAltKm, gs.minElevDeg);
      const radiusM = radiusKm * 1000;

      if (radiusM > 0) {
        const coverage = viewer.entities.add({
          name: `${gs.name} — Coverage`,
          position: Cesium.Cartesian3.fromDegrees(gs.lon, gs.lat),
          ellipse: {
            semiMajorAxis: radiusM,
            semiMinorAxis: radiusM,
            material: Cesium.Color.fromCssColorString('#facc15').withAlpha(0.06),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('#facc15').withAlpha(0.9),
            outlineWidth: 3,
            height: 0,
          },
        });
        _gsEntities.push(coverage);
      }
    }

    // Station marker
    const marker = viewer.entities.add({
      name: gs.name,
      position: Cesium.Cartesian3.fromDegrees(gs.lon, gs.lat, 0),
      point: {
        pixelSize: 10,
        color: GS_COLOR,
        outlineColor: GS_COLOR.withAlpha(0.3),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.3, 4e7, 0.7),
        translucencyByDistance: new Cesium.NearFarScalar(1e3, 1.0, 5e7, 0.7),
      },
      label: {
        text: gs.name,
        font: '600 44px "Segoe UI", system-ui, sans-serif',
        scale: 0.35,
        fillColor: GS_COLOR,
        outlineColor: LABEL_OUTLINE,
        outlineWidth: 5,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(15, -7),
        showBackground: true,
        backgroundColor: new Cesium.Color(0.02, 0.06, 0.03, 0.65),
        backgroundPadding: new Cesium.Cartesian2(16, 8),
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 4e7, 0.7),
        translucencyByDistance: new Cesium.NearFarScalar(1e3, 1.0, 5e7, 0.65),
      },
    });
    _gsEntities.push(marker);
  }
}

/**
 * Remove only ground-station entities.
 */
export function clearGroundStations(viewer) {
  for (const e of _gsEntities) {
    viewer.entities.remove(e);
  }
  _gsEntities = [];
}

/**
 * Remove all entities from the viewer.
 */
export function clearVisualization(viewer) {
  viewer.entities.removeAll();
  _satelliteEntity = null;
  _satelliteVisuals = [];
  _gsEntities = [];
}
