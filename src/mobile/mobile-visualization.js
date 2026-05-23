/**
 * Mobile-only Cesium entity rendering.
 *
 * Independent of desktop `src/visualization.js` to keep regression risk
 * on the public repo to zero. Differences from desktop:
 *   - 3 taper bands instead of 6 (visual ≈, GPU ↓ ~50%)
 *   - No glow material (PolylineGlow is a separate post-process — skip on
 *     phones; the same colour with a thicker band reads almost identically)
 *   - No nadir marker / nadir line (purely 3D affordances; 2D default)
 *   - No coverage circle for ground stations (ellipse rasterisation is
 *     expensive and adds visual clutter at small viewports)
 *   - No background panel on labels (labels are smaller too)
 *
 * Per the user's "viewer only" scope this module exports only what the
 * mobile main needs.
 */

import * as Cesium from 'cesium';

const LABEL_OUTLINE = new Cesium.Color(0.02, 0.02, 0.06, 0.9);

// Three thin bands radiating outward from the satellite.
const TAPER_WIDTHS_2D = [1.6, 1.0, 0.5];
const TAPER_WIDTHS_3D = [2.0, 1.3, 0.7];
const TAPER_ALPHAS = [1.0, 0.55, 0.22];

// Wall-time throttle (ms) for tapered-trail cache invalidation.
const TAPER_REFRESH_MS = 100;

/** Per-satellite entity bundles. */
const _bundles = new Map();
/** Ground-station marker entities (one per station). */
let _gsEntities = [];

/**
 * Add one satellite to the mobile viewer.
 *
 * @param {Cesium.Viewer} viewer
 * @param {string} id - unique satellite id (e.g. 'iss'); also used as map key
 * @param {string} name - display label
 * @param {Array<{date: Date, longitude: number, latitude: number, height: number}>} positions
 * @param {string} color - css hex
 * @returns {Cesium.Entity} the satellite entity
 */
export function addMobileSatellite(viewer, id, name, positions, color = '#7dd3fc') {
  if (!viewer || !Array.isArray(positions) || positions.length < 2) return null;

  removeMobileSatellite(viewer, id);

  const satColor = Cesium.Color.fromCssColorString(color);

  const sampledPosition = new Cesium.SampledPositionProperty();
  sampledPosition.setInterpolationOptions({
    interpolationDegree: 5,
    interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
  });

  for (const pos of positions) {
    const t = Cesium.JulianDate.fromDate(pos.date);
    sampledPosition.addSample(
      t,
      Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.height * 1000),
    );
  }

  const startTime = Cesium.JulianDate.fromDate(positions[0].date);
  const stopTime = Cesium.JulianDate.fromDate(positions[positions.length - 1].date);
  const availability = new Cesium.TimeIntervalCollection([
    new Cesium.TimeInterval({ start: startTime, stop: stopTime }),
  ]);

  const sat = viewer.entities.add({
    id: `m-sat-${id}`,
    name,
    position: sampledPosition,
    availability,
    point: {
      pixelSize: 12,
      color: satColor,
      outlineColor: satColor.withAlpha(0.35),
      outlineWidth: 2,
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.3, 4e7, 0.7),
    },
    label: {
      text: name,
      font: '600 36px "Segoe UI", system-ui, sans-serif',
      scale: 0.3,
      fillColor: satColor,
      outlineColor: LABEL_OUTLINE,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(14, -8),
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 4e7, 0.7),
    },
  });

  const trailEntities = [];
  for (let side = 0; side < 2; side++) {
    const isPast = side === 0;
    for (let b = 0; b < TAPER_WIDTHS_2D.length; b++) {
      const trail = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(
            makeTrailCallback(viewer, positions, isPast, b),
            false,
          ),
          width: viewer.scene.mode === Cesium.SceneMode.SCENE2D ? TAPER_WIDTHS_2D[b] : TAPER_WIDTHS_3D[b],
          material: satColor.withAlpha(TAPER_ALPHAS[b]),
        },
      });
      trailEntities.push(trail);
    }
  }

  _bundles.set(id, { sat, trailEntities });
  return sat;
}

/**
 * Remove one satellite by id.
 */
export function removeMobileSatellite(viewer, id) {
  if (!viewer) return;
  const bundle = _bundles.get(id);
  if (!bundle) return;
  try {
    viewer.entities.remove(bundle.sat);
    for (const e of bundle.trailEntities) viewer.entities.remove(e);
  } catch (_) { /* viewer maybe torn down */ }
  _bundles.delete(id);
}

/**
 * Remove every satellite previously added by this module.
 */
export function clearMobileSatellites(viewer) {
  if (!viewer) return;
  for (const { sat, trailEntities } of _bundles.values()) {
    try {
      viewer.entities.remove(sat);
      for (const e of trailEntities) viewer.entities.remove(e);
    } catch (_) {}
  }
  _bundles.clear();
}

/**
 * Add minimal ground-station markers — no coverage ellipse on mobile.
 *
 * @param {Cesium.Viewer} viewer
 * @param {Array<{id: string, name: string, lat: number, lon: number}>} stations
 */
export function addMobileGroundStations(viewer, stations) {
  if (!viewer || !Array.isArray(stations)) return;
  clearMobileGroundStations(viewer);

  for (const s of stations) {
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const e = viewer.entities.add({
      id: `m-gs-${s.id}`,
      name: s.name || s.id,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString('#34d399'),
        outlineColor: Cesium.Color.fromCssColorString('#34d399').withAlpha(0.35),
        outlineWidth: 2,
      },
      label: {
        text: s.name || s.id,
        font: '600 30px "Segoe UI", system-ui, sans-serif',
        scale: 0.28,
        fillColor: Cesium.Color.fromCssColorString('#34d399'),
        outlineColor: LABEL_OUTLINE,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(12, -8),
      },
    });
    _gsEntities.push(e);
  }
}

export function clearMobileGroundStations(viewer) {
  if (!viewer) return;
  for (const e of _gsEntities) {
    try { viewer.entities.remove(e); } catch (_) {}
  }
  _gsEntities = [];
}

/**
 * Get currently focused satellite ids (returns a snapshot).
 */
export function getMobileSatelliteIds() {
  return Array.from(_bundles.keys());
}

// ─── internals ─────────────────────────────────────────────────────────────

/**
 * Build a memoised CallbackProperty that returns the polyline positions for
 * a single taper band. The slice indices update at most every TAPER_REFRESH_MS
 * to avoid re-tessellating every frame at high playback multipliers.
 */
function makeTrailCallback(viewer, positions, isPast, bandIdx) {
  let cachedSlice = null;
  let cachedIdx = -1;
  let cachedSide = -1;
  let lastUpdate = 0;

  return function trailCB(currentTime, _result) {
    if (!currentTime) return [];
    const nowMs = Date.now();

    const total = positions.length;
    const ratio = Cesium.JulianDate.secondsDifference(
      currentTime,
      Cesium.JulianDate.fromDate(positions[0].date),
    ) / Cesium.JulianDate.secondsDifference(
      Cesium.JulianDate.fromDate(positions[total - 1].date),
      Cesium.JulianDate.fromDate(positions[0].date),
    );
    const centerIdx = Math.max(0, Math.min(total - 1, Math.round(ratio * (total - 1))));

    // Band 0 = closest 1/3 of the side, band 2 = furthest 1/3
    const bandSize = Math.floor(total / 2 / TAPER_WIDTHS_2D.length);
    const offsetStart = bandIdx * bandSize;
    const offsetEnd = (bandIdx + 1) * bandSize;

    const startIdx = isPast
      ? Math.max(0, centerIdx - offsetEnd)
      : Math.min(total - 1, centerIdx + offsetStart);
    const endIdx = isPast
      ? Math.max(0, centerIdx - offsetStart)
      : Math.min(total - 1, centerIdx + offsetEnd);

    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);

    if (
      cachedSlice
      && cachedSide === (isPast ? 0 : 1)
      && cachedIdx === lo * 10000 + hi
      && nowMs - lastUpdate < TAPER_REFRESH_MS
    ) {
      return cachedSlice;
    }

    const slice = [];
    for (let i = lo; i <= hi; i++) {
      const p = positions[i];
      slice.push(Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.height * 1000));
    }

    cachedSlice = slice;
    cachedSide = isPast ? 0 : 1;
    cachedIdx = lo * 10000 + hi;
    lastUpdate = nowMs;
    return slice;
  };
}
