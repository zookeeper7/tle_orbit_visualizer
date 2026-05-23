/**
 * Mobile-only Cesium entity helpers.
 *
 * Satellite rendering is now done with the desktop renderer
 * (`src/visualization.js`) so the orbit trail behaves the same on both
 * builds. The only mobile-specific concern is that desktop's
 * `clearVisualization` / `clearGroundStations` walk their own entity
 * registry, so the mobile ground-station entities are tracked in this
 * module's own scope to avoid cross-pollution.
 *
 * Coverage circles use the same `computeCoverageRadiusKm` formula as
 * desktop (`createGroundStationVisuals`) and the same yellow palette,
 * just with a slightly thinner outline (2 px instead of 3) so they read
 * cleanly on a small viewport.
 */

import * as Cesium from 'cesium';
import { computeCoverageRadiusKm } from '../ground-stations.js';

const LABEL_OUTLINE = new Cesium.Color(0.02, 0.02, 0.06, 0.9);
const COVERAGE_COLOR = Cesium.Color.fromCssColorString('#facc15');

/** Ground-station marker entities (one per station + optional coverage). */
let _gsEntities = [];

/**
 * Add ground-station markers: point + label, plus a coverage ellipse when
 * an average satellite altitude is available.
 *
 * @param {Cesium.Viewer} viewer
 * @param {Array<{id: string, name: string, lat: number, lon: number, minElevDeg?: number}>} stations
 * @param {number|null} [avgAltKm] Mean satellite altitude in km. When null
 *   or non-positive (e.g. before any satellite is visualized) coverage
 *   ellipses are skipped and only the point + label are drawn.
 */
export function addMobileGroundStations(viewer, stations, avgAltKm = null) {
  if (!viewer || !Array.isArray(stations)) return;
  clearMobileGroundStations(viewer);

  const drawCoverage = Number.isFinite(avgAltKm) && avgAltKm > 0;

  for (const s of stations) {
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;

    if (drawCoverage) {
      const minElev = Number.isFinite(s.minElevDeg) ? s.minElevDeg : 5;
      const radiusKm = computeCoverageRadiusKm(avgAltKm, minElev);
      const radiusM = radiusKm * 1000;
      if (radiusM > 0) {
        const coverage = viewer.entities.add({
          id: `m-gs-${s.id}-coverage`,
          name: `${s.name || s.id} — Coverage`,
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
          ellipse: {
            semiMajorAxis: radiusM,
            semiMinorAxis: radiusM,
            material: COVERAGE_COLOR.withAlpha(0.06),
            outline: true,
            outlineColor: COVERAGE_COLOR.withAlpha(0.9),
            outlineWidth: 2,
            height: 0,
          },
        });
        _gsEntities.push(coverage);
      }
    }

    const marker = viewer.entities.add({
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
        // Texture stays at the bumped 44 px font (sharper than the
        // original 30 px) but the sprite scale drops back down to 0.32
        // so the label reads small on screen — the user wants the
        // glyphs crisp, not large. The remaining net change vs. the
        // original (30 px / 0.28 ≈ 8.4 px on-canvas) is a slightly
        // larger on-canvas footprint (44 × 0.32 ≈ 14 px) painted with
        // a higher-resolution texture, so the same letters are both
        // legible and noticeably sharper.
        text: s.name || s.id,
        font: '600 44px "Segoe UI", system-ui, sans-serif',
        scale: 0.32,
        fillColor: Cesium.Color.fromCssColorString('#34d399'),
        outlineColor: LABEL_OUTLINE,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(12, -8),
      },
    });
    _gsEntities.push(marker);
  }
}

export function clearMobileGroundStations(viewer) {
  if (!viewer) return;
  for (const e of _gsEntities) {
    try { viewer.entities.remove(e); } catch (_) { /* viewer may be torn down */ }
  }
  _gsEntities = [];
}
