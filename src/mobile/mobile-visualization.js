/**
 * Mobile-only Cesium entity helpers.
 *
 * Satellite rendering is now done with the desktop renderer
 * (`src/visualization.js`) so the orbit trail behaves the same on both
 * builds. The only thing the mobile build still owns is the ground-station
 * marker — desktop draws a coverage ellipse around each station which
 * clutters a small viewport, so on mobile we render only the point + label.
 *
 * The mobile ground-station entity registry is kept in this module's own
 * scope so that desktop's `clearVisualization` / `clearGroundStations`
 * never touch it (and vice versa).
 */

import * as Cesium from 'cesium';

const LABEL_OUTLINE = new Cesium.Color(0.02, 0.02, 0.06, 0.9);

/** Ground-station marker entities (one per station). */
let _gsEntities = [];

/**
 * Add minimal ground-station markers — point + label only, no coverage ellipse.
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
    try { viewer.entities.remove(e); } catch (_) { /* viewer may be torn down */ }
  }
  _gsEntities = [];
}
