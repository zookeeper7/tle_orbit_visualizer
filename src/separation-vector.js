/**
 * Separation Vector → TLE generator
 *
 * Converts a launch separation state vector (ECEF position + velocity at UTC)
 * into a TLE that can be used by SGP4-based propagation.
 *
 * Coordinate frames:
 *  - Input: ECEF (Earth-Centered, Earth-Fixed) position [m] and Earth-relative velocity [m/s]
 *  - Internal: converted to TEME-like ECI for Keplerian element extraction
 *  - Output: TLE string compatible with satellite.js / SGP4
 *
 * Notes:
 *  - The generated TLE uses osculating Keplerian elements as approximations of
 *    SGP4 mean elements. For short propagation windows (~ days) this is accurate
 *    to ~km level, sufficient for visualization.
 *  - For sub-km accuracy or long-term propagation, perform an osculating-to-mean
 *    conversion (Brouwer-Lyddane) — outside the scope here.
 */

import * as satellite from 'satellite.js';
import { alpha5Encode } from './gp.js';

const MU_EARTH = 398600.4418;     // km^3 / s^2
const EARTH_OMEGA = 7.2921159e-5;  // rad/s

/**
 * Convert ECEF position+velocity (Earth-relative) at a given UTC time
 * into ECI (TEME) position+velocity (inertial).
 *
 * @param {[number,number,number]} posEcefM - position in meters, ECEF frame
 * @param {[number,number,number]} velEcefMs - velocity in m/s, Earth-relative ECEF frame
 * @param {Date} utcDate - the UTC time at which the state vector is valid
 * @returns {{ posEciKm: [number,number,number], velEciKmS: [number,number,number] }}
 */
export function ecefStateToEci(posEcefM, velEcefMs, utcDate) {
  const gmst = satellite.gstime(utcDate);

  // Position: ECEF -> ECI (rotation about z-axis by GMST)
  // satellite.js provides ecfToEci which returns ECI position given ECEF
  const posEcfKm = { x: posEcefM[0] / 1000, y: posEcefM[1] / 1000, z: posEcefM[2] / 1000 };
  const posEciKmObj = satellite.ecfToEci(posEcfKm, gmst);
  const posEciKm = [posEciKmObj.x, posEciKmObj.y, posEciKmObj.z];

  // Velocity: rotate ECEF velocity vector to ECI components, then add Earth rotation contribution
  // v_eci_inertial = R(theta) * v_ecef + omega x r_eci
  const velEcfKmS = { x: velEcefMs[0] / 1000, y: velEcefMs[1] / 1000, z: velEcefMs[2] / 1000 };
  const velRotKmSObj = satellite.ecfToEci(velEcfKmS, gmst);
  // omega x r_eci where omega = (0, 0, OMEGA_E)
  const velEciKm = [
    velRotKmSObj.x - EARTH_OMEGA * posEciKm[1],
    velRotKmSObj.y + EARTH_OMEGA * posEciKm[0],
    velRotKmSObj.z,
  ];

  return { posEciKm, velEciKmS: velEciKm };
}

/**
 * Compute classical (osculating) Keplerian orbital elements from ECI state vector.
 *
 * @param {[number,number,number]} rKm - position in km (ECI)
 * @param {[number,number,number]} vKmS - velocity in km/s (ECI)
 * @returns {{
 *   a: number,         // semi-major axis (km)
 *   e: number,         // eccentricity
 *   i: number,         // inclination (rad)
 *   raan: number,      // right ascension of ascending node (rad)
 *   argp: number,      // argument of perigee (rad)
 *   trueAnomaly: number, // true anomaly (rad)
 *   meanAnomaly: number, // mean anomaly (rad)
 *   meanMotionRevPerDay: number, // n in rev/day
 *   periodMin: number, // orbital period (min)
 * }}
 */
export function stateVectorToKeplerian(rKm, vKmS) {
  const [rx, ry, rz] = rKm;
  const [vx, vy, vz] = vKmS;
  const r = Math.hypot(rx, ry, rz);
  const v = Math.hypot(vx, vy, vz);

  // Specific angular momentum h = r x v
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h = Math.hypot(hx, hy, hz);

  // Node vector n = z_hat x h = (-hy, hx, 0)
  const nx = -hy;
  const ny = hx;
  const nz = 0;
  const n = Math.hypot(nx, ny, nz);

  // Eccentricity vector e = (1/mu) * ((v^2 - mu/r) r - (r dot v) v)
  const rDotV = rx * vx + ry * vy + rz * vz;
  const coeff1 = (v * v - MU_EARTH / r) / MU_EARTH;
  const coeff2 = rDotV / MU_EARTH;
  const ex = coeff1 * rx - coeff2 * vx;
  const ey = coeff1 * ry - coeff2 * vy;
  const ez = coeff1 * rz - coeff2 * vz;
  const e = Math.hypot(ex, ey, ez);

  // Specific orbital energy & semi-major axis
  const energy = v * v / 2 - MU_EARTH / r;
  const a = -MU_EARTH / (2 * energy);

  // Inclination
  const i = Math.acos(clamp(hz / h, -1, 1));

  // RAAN
  let raan = 0;
  if (n > 1e-10) {
    raan = Math.acos(clamp(nx / n, -1, 1));
    if (ny < 0) raan = 2 * Math.PI - raan;
  }

  // Argument of perigee
  let argp = 0;
  if (n > 1e-10 && e > 1e-10) {
    argp = Math.acos(clamp((nx * ex + ny * ey + nz * ez) / (n * e), -1, 1));
    if (ez < 0) argp = 2 * Math.PI - argp;
  } else if (e > 1e-10) {
    // Equatorial non-circular orbit: argp = longitude of perigee
    argp = Math.atan2(ey, ex);
    if (argp < 0) argp += 2 * Math.PI;
  }

  // True anomaly
  let trueAnomaly = 0;
  if (e > 1e-10) {
    trueAnomaly = Math.acos(clamp((ex * rx + ey * ry + ez * rz) / (e * r), -1, 1));
    if (rDotV < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
  } else {
    // Circular orbit: use argument of latitude
    if (n > 1e-10) {
      trueAnomaly = Math.acos(clamp((nx * rx + ny * ry + nz * rz) / (n * r), -1, 1));
      if (rz < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
    } else {
      trueAnomaly = Math.atan2(ry, rx);
      if (trueAnomaly < 0) trueAnomaly += 2 * Math.PI;
    }
  }

  // Eccentric & mean anomaly
  const E = 2 * Math.atan2(
    Math.sqrt(1 - e) * Math.sin(trueAnomaly / 2),
    Math.sqrt(1 + e) * Math.cos(trueAnomaly / 2),
  );
  let meanAnomaly = E - e * Math.sin(E);
  if (meanAnomaly < 0) meanAnomaly += 2 * Math.PI;

  // Mean motion
  const meanMotionRadPerSec = Math.sqrt(MU_EARTH / (a * a * a));
  const meanMotionRevPerDay = meanMotionRadPerSec * 86400 / (2 * Math.PI);
  const periodMin = 2 * Math.PI / meanMotionRadPerSec / 60;

  return {
    a,
    e,
    i,
    raan,
    argp,
    trueAnomaly,
    meanAnomaly,
    meanMotionRevPerDay,
    periodMin,
  };
}

/**
 * Generate a TLE string from Keplerian elements at a given UTC epoch.
 *
 * @param {Object} elements - output of stateVectorToKeplerian
 * @param {Date} utcDate - epoch UTC
 * @param {Object} options - { name, noradId, intlDesignator, bstar }
 * @returns {{ name: string, line1: string, line2: string, threeLine: string }}
 */
export function keplerianToTLE(elements, utcDate, options = {}) {
  const {
    name = 'GENERATED-SAT',
    noradId = 99999,
    intlDesignator = '99999A  ',
    bstar = 0,
  } = options;

  // Epoch: YYDDD.dddddddd
  const year = utcDate.getUTCFullYear();
  const yearTwoDigit = year % 100;
  const startOfYear = Date.UTC(year, 0, 1);
  const dayOfYear = (utcDate.getTime() - startOfYear) / 86400000 + 1;
  const epochStr = `${pad2(yearTwoDigit)}${dayOfYear.toFixed(8).padStart(12, '0')}`;

  // Alpha-5 encode so catalog numbers 100000–339999 fit the 5-char TLE field.
  const noradStr = alpha5Encode(noradId);
  const intlStr = (intlDesignator || '').padEnd(8).substring(0, 8);

  // Mean motion derivative (set to 0 — we don't model decay from a single state)
  const ndotStr = ' .00000000';
  const nddotStr = ' 00000+0';
  const bstarStr = formatExp(bstar);

  // Line 1
  let line1 = `1 ${noradStr}U ${intlStr} ${epochStr} ${ndotStr} ${nddotStr} ${bstarStr} 0  999`;
  line1 = line1.substring(0, 68);
  line1 = line1 + tleChecksum(line1);

  // Convert angles to degrees
  const inclDeg = rad2deg(elements.i);
  const raanDeg = rad2deg(elements.raan);
  const argpDeg = rad2deg(elements.argp);
  const maDeg = rad2deg(elements.meanAnomaly);
  const eccStr = (elements.e * 1e7).toFixed(0).padStart(7, '0').substring(0, 7);
  const mmStr = elements.meanMotionRevPerDay.toFixed(8);

  // Line 2
  let line2 = `2 ${noradStr} ${pad8(inclDeg, 4)} ${pad8(raanDeg, 4)} ${eccStr} ${pad8(argpDeg, 4)} ${pad8(maDeg, 4)} ${pad11(mmStr)}    1`;
  line2 = line2.substring(0, 68);
  line2 = line2 + tleChecksum(line2);

  return {
    name,
    line1,
    line2,
    threeLine: `${name}\n${line1}\n${line2}`,
  };
}

/**
 * High-level: convert ECEF separation vector at UTC into a TLE.
 *
 * @param {Object} input
 * @param {[number,number,number]} input.posEcefM
 * @param {[number,number,number]} input.velEcefMs
 * @param {Date} input.utcDate
 * @param {Object} input.options - passed to keplerianToTLE
 * @returns {{ tle: ReturnType<typeof keplerianToTLE>, elements: ReturnType<typeof stateVectorToKeplerian> }}
 */
export function separationVectorToTLE({ posEcefM, velEcefMs, utcDate, options = {} }) {
  const { posEciKm, velEciKmS } = ecefStateToEci(posEcefM, velEcefMs, utcDate);
  const elements = stateVectorToKeplerian(posEciKm, velEciKmS);
  const tle = keplerianToTLE(elements, utcDate, options);
  return { tle, elements };
}

/**
 * Convert the 6 classical orbital elements directly into a TLE.
 * Angles are accepted in **degrees**, semi-major axis in **km**.
 *
 * @param {Object} input
 * @param {number} input.aKm           - semi-major axis (km), must be > Earth radius
 * @param {number} input.e             - eccentricity, in [0, 1)
 * @param {number} input.iDeg          - inclination (deg), 0..180
 * @param {number} input.raanDeg       - right ascension of ascending node (deg), 0..360
 * @param {number} input.argpDeg       - argument of perigee (deg), 0..360
 * @param {number} input.trueAnomalyDeg- true anomaly at epoch (deg), 0..360
 * @param {Date}   input.utcDate       - epoch (UTC)
 * @param {Object} [input.options]     - passed to keplerianToTLE (name, noradId, intlDesignator, bstar)
 * @returns {{ tle: ReturnType<typeof keplerianToTLE>, elements: ReturnType<typeof stateVectorToKeplerian> }}
 */
export function classicalElementsToTLE({ aKm, e, iDeg, raanDeg, argpDeg, trueAnomalyDeg, utcDate, options = {} }) {
  // Validate
  if (!(aKm > 0) || !Number.isFinite(aKm)) throw new Error('Semi-major axis must be a positive number (km).');
  if (!(e >= 0 && e < 1) || !Number.isFinite(e)) throw new Error('Eccentricity must be in [0, 1).');
  if (!Number.isFinite(iDeg)) throw new Error('Inclination must be a number (deg).');
  if (!Number.isFinite(raanDeg)) throw new Error('RAAN must be a number (deg).');
  if (!Number.isFinite(argpDeg)) throw new Error('Argument of perigee must be a number (deg).');
  if (!Number.isFinite(trueAnomalyDeg)) throw new Error('True anomaly must be a number (deg).');
  if (!(utcDate instanceof Date) || Number.isNaN(utcDate.getTime())) throw new Error('Invalid epoch date.');

  // Wrap angles to [0, 360) where appropriate
  const wrap360 = (x) => ((x % 360) + 360) % 360;
  const iWrapped = ((iDeg % 360) + 360) % 360; // inclination typically 0..180, allow input range freely
  const raanW = wrap360(raanDeg);
  const argpW = wrap360(argpDeg);
  const nuW   = wrap360(trueAnomalyDeg);

  const DEG2RAD = Math.PI / 180;
  const i = iWrapped * DEG2RAD;
  const raan = raanW * DEG2RAD;
  const argp = argpW * DEG2RAD;
  const trueAnomaly = nuW * DEG2RAD;

  // True anomaly -> eccentric anomaly -> mean anomaly
  const sqrtRatio = Math.sqrt(Math.max(0, 1 - e) / Math.max(1e-12, 1 + e));
  const E = 2 * Math.atan2(
    sqrtRatio * Math.sin(trueAnomaly / 2),
    Math.cos(trueAnomaly / 2),
  );
  let meanAnomaly = E - e * Math.sin(E);
  // normalize meanAnomaly to [0, 2pi)
  meanAnomaly = ((meanAnomaly % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  // Mean motion from semi-major axis
  const meanMotionRadPerSec = Math.sqrt(MU_EARTH / (aKm * aKm * aKm));
  const meanMotionRevPerDay = meanMotionRadPerSec * 86400 / (2 * Math.PI);
  const periodMin = 2 * Math.PI / meanMotionRadPerSec / 60;

  const elements = {
    a: aKm,
    e,
    i,
    raan,
    argp,
    trueAnomaly,
    meanAnomaly,
    meanMotionRevPerDay,
    periodMin,
  };

  const tle = keplerianToTLE(elements, utcDate, options);
  return { tle, elements };
}

// ── helpers ──

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function rad2deg(r) { return r * 180 / Math.PI; }
function pad2(n) { return String(n).padStart(2, '0'); }

function pad8(value, decimals) {
  const s = value.toFixed(decimals);
  return s.padStart(8, ' ');
}

function pad11(s) {
  return s.padStart(11, ' ');
}

function formatExp(value) {
  if (value === 0 || !Number.isFinite(value)) return ' 00000+0';
  const sign = value < 0 ? '-' : ' ';
  const abs = Math.abs(value);
  let exp = Math.floor(Math.log10(abs));
  let mantissa = abs / Math.pow(10, exp);
  // Want format: SXXXXX±E where mantissa has 5 implied decimal digits
  const mantStr = Math.round(mantissa * 10000).toString().padStart(5, '0').substring(0, 5);
  exp += 1;
  const expSign = exp < 0 ? '-' : '+';
  return `${sign}${mantStr}${expSign}${Math.abs(exp)}`;
}

function tleChecksum(line) {
  let sum = 0;
  for (let i = 0; i < line.length && i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += parseInt(c, 10);
    else if (c === '-') sum += 1;
  }
  return String(sum % 10);
}
