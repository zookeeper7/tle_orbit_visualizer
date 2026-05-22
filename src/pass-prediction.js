/**
 * Satellite pass prediction over ground stations.
 *
 * For each ground station, steps through the time window and detects when
 * the satellite's elevation angle crosses above/below the station's minimum
 * elevation threshold (AOS / LOS). Tracks max elevation per pass.
 *
 * Uses satellite.js look-angle computation:
 *   eciToLookAngles(observerGd, positionEci, gmst) → { elevation, azimuth, rangeSat }
 */

import * as satellite from 'satellite.js';
import { getMaskMinElev } from './core/azimuth-mask.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Compute all passes for a satellite over a set of ground stations.
 *
 * @param {object}  satrec    - SGP4 satellite record (from satellite.js)
 * @param {Array}   stations  - Ground station objects [{ id, name, lat, lon, minElevDeg }]
 * @param {Date}    startDate - Window start
 * @param {Date}    stopDate  - Window end
 * @param {number}  [stepSec=10] - Coarse scan step (seconds). Smaller = more accurate AOS/LOS.
 * @returns {Array} Sorted passes: [{ stationId, stationName, aos: Date, los: Date, durationSec, maxElDeg }]
 */
/**
 * @param {object}  satrec
 * @param {Array}   stations
 * @param {Date}    startDate
 * @param {Date}    stopDate
 * @param {number}  [stepSec=10]
 * @param {object}  [options]
 * @param {boolean} [options.perAntenna=true] - If false, compute one pass per station (ignore antenna masks).
 *                  Use false for Orbit Viewer (station-level view), true for Schedule Manager (antenna-level).
 */
export function computePasses(satrec, stations, startDate, stopDate, stepSec = 10, options = {}) {
  const perAntenna = options.perAntenna !== false;
  const passes = [];

  for (const gs of stations) {
    const observerGd = {
      longitude: gs.lon * DEG2RAD,
      latitude: gs.lat * DEG2RAD,
      height: 0, // km above ellipsoid
    };
    const stationMinElRad = (Number(gs.minElevDeg) || 0) * DEG2RAD;

    const basePasses = scanPasses({
      satrec,
      observerGd,
      startDate,
      stopDate,
      stepSec,
      isAboveThreshold: (lookAngles) => lookAngles.elevation >= stationMinElRad,
    });

    // Station-level mode: one pass per station, no antenna splitting
    if (!perAntenna) {
      for (const basePass of basePasses) {
        passes.push(formatPass({ gs, antennaId: null, pass: basePass }));
      }
      continue;
    }

    // Antenna-level mode: per-antenna mask splitting
    const stationTargets = buildStationTargets(gs);

    for (const target of stationTargets) {
      const maskEntries = Array.isArray(target.mask) ? target.mask : [];
      const hasMask = maskEntries.length > 0;

      if (!hasMask) {
        for (const basePass of basePasses) {
          passes.push(formatPass({
            gs,
            antennaId: target.antennaId,
            pass: basePass,
          }));
        }
        continue;
      }

      const maskedPasses = scanPasses({
        satrec,
        observerGd,
        startDate,
        stopDate,
        stepSec,
        isAboveThreshold: (lookAngles) => {
          const effectiveMinElRad = getEffectiveMinElRad({
            stationMinElRad,
            maskEntries,
            azimuthRad: lookAngles.azimuth,
          });
          return lookAngles.elevation >= effectiveMinElRad;
        },
      });

      const splitAnnotated = annotateSplitSubPasses({
        basePasses,
        maskedPasses,
        stationId: gs.id,
        antennaId: target.antennaId,
      });

      for (const pass of splitAnnotated) {
        passes.push(formatPass({
          gs,
          antennaId: target.antennaId,
          pass,
        }));
      }
    }
  }

  // Sort by AOS ascending
  passes.sort((a, b) => a.aos.getTime() - b.aos.getTime());

  return passes;
}

/**
 * Get satellite elevation angle (radians) from an observer at a given time.
 * Returns null if propagation fails.
 */
function getLookAngles(satrec, observerGd, date) {
  try {
    const pv = satellite.propagate(satrec, date);
    if (!pv.position || typeof pv.position === 'boolean') return null;

    const gmst = satellite.gstime(date);
    const lookAngles = satellite.ecfToLookAngles(
      observerGd,
      satellite.eciToEcf(pv.position, gmst),
    );

    return {
      elevation: lookAngles.elevation,
      azimuth: lookAngles.azimuth,
      rangeSat: lookAngles.rangeSat,
    };
  } catch {
    return null;
  }
}

/**
 * Binary-search refinement to find the exact transition time (to ~1 sec)
 * where elevation crosses the threshold.
 *
 * @param {boolean} rising - true for AOS (rising edge), false for LOS (falling edge)
 */
function refineTransition(satrec, observerGd, before, after, rising, isAboveThreshold) {
  let lo = before.getTime();
  let hi = after.getTime();

  // 12 iterations ≈ (stepSec*1000) / 2^12 ≈ sub-second precision
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const lookAngles = getLookAngles(satrec, observerGd, new Date(mid));

    if (lookAngles === null) {
      // Can't determine — take midpoint and stop
      break;
    }

    const aboveThreshold = isAboveThreshold(lookAngles);

    if (rising) {
      // Looking for low→high transition: lo is below, hi is above
      if (aboveThreshold) hi = mid;
      else lo = mid;
    } else {
      // Looking for high→low transition: lo is above, hi is below
      if (aboveThreshold) lo = mid;
      else hi = mid;
    }
  }

  return new Date(rising ? hi : lo);
}

function scanPasses({ satrec, observerGd, startDate, stopDate, stepSec, isAboveThreshold }) {
  /** @type {Array<{aos: Date, los: Date, durationSec: number, maxElDeg: number}>} */
  const found = [];

  let inPass = false;
  let aosDate = null;
  let maxElRad = 0;

  const startMs = startDate.getTime();
  const stopMs = stopDate.getTime();
  const stepMs = stepSec * 1000;

  for (let t = startMs; t <= stopMs; t += stepMs) {
    const date = new Date(t);
    const look = getLookAngles(satrec, observerGd, date);
    if (!look) continue;

    const above = isAboveThreshold(look);

    if (!inPass && above) {
      aosDate = refineTransition(
        satrec,
        observerGd,
        new Date(Math.max(startMs, t - stepMs)),
        date,
        true,
        isAboveThreshold,
      );
      maxElRad = look.elevation;
      inPass = true;
    } else if (inPass && above) {
      if (look.elevation > maxElRad) maxElRad = look.elevation;
    } else if (inPass && !above) {
      const losDate = refineTransition(
        satrec,
        observerGd,
        new Date(Math.max(startMs, t - stepMs)),
        date,
        false,
        isAboveThreshold,
      );
      const durationSec = (losDate.getTime() - aosDate.getTime()) / 1000;
      if (durationSec >= 0) {
        found.push({
          aos: aosDate,
          los: losDate,
          durationSec,
          maxElDeg: maxElRad * RAD2DEG,
        });
      }

      inPass = false;
      aosDate = null;
      maxElRad = 0;
    }
  }

  if (inPass && aosDate) {
    const durationSec = (stopDate.getTime() - aosDate.getTime()) / 1000;
    found.push({
      aos: aosDate,
      los: stopDate,
      durationSec,
      maxElDeg: maxElRad * RAD2DEG,
    });
  }

  return found;
}

function buildStationTargets(station) {
  const antennas = Array.isArray(station.antennas) ? station.antennas : [];
  if (antennas.length === 0) {
    return [{ antennaId: null, mask: [] }];
  }

  return antennas.map((antenna) => ({
    antennaId: antenna?.id || null,
    mask: Array.isArray(antenna?.mask) ? antenna.mask : [],
  }));
}

function getEffectiveMinElRad({ stationMinElRad, maskEntries, azimuthRad }) {
  const azDeg = normalizeAzimuthDeg(azimuthRad * RAD2DEG);
  const maskMinElDeg = getMaskMinElev(maskEntries, azDeg);
  return Math.max(stationMinElRad, maskMinElDeg * DEG2RAD);
}

function normalizeAzimuthDeg(azDeg) {
  return ((azDeg % 360) + 360) % 360;
}

function formatPass({ gs, antennaId, pass }) {
  return {
    stationId: gs.id,
    stationName: gs.name,
    antennaId: antennaId || null,
    parentPassId: pass.parentPassId || null,
    aos: pass.aos,
    los: pass.los,
    durationSec: pass.durationSec,
    maxElDeg: pass.maxElDeg,
  };
}

function annotateSplitSubPasses({ basePasses, maskedPasses, stationId, antennaId }) {
  const decorated = maskedPasses.map((p) => ({ ...p, parentPassId: null }));
  if (basePasses.length === 0 || decorated.length === 0) return decorated;

  /** @type {Map<number, Array<number>>} */
  const overlapsByBase = new Map();
  for (let i = 0; i < basePasses.length; i++) overlapsByBase.set(i, []);

  for (let m = 0; m < decorated.length; m++) {
    const seg = decorated[m];
    for (let b = 0; b < basePasses.length; b++) {
      const base = basePasses[b];
      if (intervalsOverlap(seg.aos, seg.los, base.aos, base.los)) {
        overlapsByBase.get(b).push(m);
      }
    }
  }

  for (let b = 0; b < basePasses.length; b++) {
    const overlapIndices = overlapsByBase.get(b) || [];
    if (overlapIndices.length <= 1) continue;

    const parentPassId = buildParentPassId({
      stationId,
      antennaId,
      aos: basePasses[b].aos,
    });

    for (const idx of overlapIndices) {
      decorated[idx].parentPassId = parentPassId;
    }
  }

  return decorated;
}

function intervalsOverlap(aosA, losA, aosB, losB) {
  return aosA.getTime() < losB.getTime() && aosB.getTime() < losA.getTime();
}

function buildParentPassId({ stationId, antennaId, aos }) {
  return `${stationId}_${antennaId || 'station'}_${Math.floor(aos.getTime() / 1000)}`;
}
