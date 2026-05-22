import * as satellite from 'satellite.js';

/**
 * Parse a TLE string (2 or 3 lines) into a satrec object.
 * @param {string} tleString - TLE data (name + line1 + line2, or line1 + line2)
 * @returns {{ satrec: object, name: string, line1: string, line2: string }}
 */
export function parseTLE(tleString) {
  const lines = tleString.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let name, line1, line2;

  if (lines.length >= 3) {
    name = lines[0];
    line1 = lines[1];
    line2 = lines[2];
  } else if (lines.length === 2) {
    name = 'Satellite';
    line1 = lines[0];
    line2 = lines[1];
  } else {
    throw new Error('Invalid TLE: need at least 2 lines (line1 + line2)');
  }

  if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) {
    throw new Error('Invalid TLE format: line1 must start with "1 " and line2 with "2 "');
  }

  const satrec = satellite.twoline2satrec(line1, line2);

  return { satrec, name, line1, line2 };
}

/**
 * Compute orbital elements from satrec.
 */
export function getOrbitalInfo(satrec) {
  const meanMotionRadPerMin = satrec.no; // rad/min (stored internally in satellite.js)
  const periodMinutes = (2 * Math.PI) / meanMotionRadPerMin;
  const inclinationDeg = satrec.inclo * (180 / Math.PI);
  const eccentricity = satrec.ecco;

  // Semi-major axis from mean motion
  const mu = 398600.4418; // km^3/s^2
  const nRadPerSec = meanMotionRadPerMin / 60;
  const semiMajorAxis = Math.pow(mu / (nRadPerSec * nRadPerSec), 1 / 3);

  const apogeeAlt = semiMajorAxis * (1 + eccentricity) - 6371;
  const perigeeAlt = semiMajorAxis * (1 - eccentricity) - 6371;

  return {
    periodMinutes,
    inclinationDeg,
    eccentricity,
    semiMajorAxis,
    apogeeAlt,
    perigeeAlt,
  };
}

/**
 * Propagate the orbit and return position samples.
 * @param {object} satrec - SGP4 satellite record
 * @param {object} options
 * @param {number} options.pastOrbits - Number of past orbits to compute (default 1)
 * @param {number} options.futureOrbits - Number of future orbits to compute (default 1.5)
 * @param {number} options.pointsPerOrbit - Sample points per orbit (default 120)
 * @returns {{ positions: Array, info: object }}
 */
export function propagateOrbit(satrec, options = {}) {
  const {
    pastOrbits = 1,
    futureOrbits = 1.5,
    pointsPerOrbit = 120,
    referenceDate = null,
  } = options;

  const info = getOrbitalInfo(satrec);
  const periodMs = info.periodMinutes * 60 * 1000;

  const pastMs = pastOrbits * periodMs;
  const futureMs = futureOrbits * periodMs;
  const totalMs = pastMs + futureMs;

  const totalPoints = Math.round(pointsPerOrbit * (pastOrbits + futureOrbits));
  const intervalMs = totalMs / totalPoints;

  const refMs = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
    ? referenceDate.getTime()
    : Date.now();
  const positions = [];

  for (let i = 0; i <= totalPoints; i++) {
    const msFromNow = -pastMs + i * intervalMs;
    const date = new Date(refMs + msFromNow);

    try {
      const pv = satellite.propagate(satrec, date);
      if (!pv.position || typeof pv.position === 'boolean') continue;

      const posEci = pv.position; // km, TEME
      const velEci = pv.velocity; // km/s, TEME
      const gmst = satellite.gstime(date);
      const geo = satellite.eciToGeodetic(posEci, gmst);

      let lonDeg = geo.longitude * (180 / Math.PI);
      const latDeg = geo.latitude * (180 / Math.PI);
      const heightKm = geo.height;

      // Wrap longitude to [-180, 180]
      while (lonDeg > 180) lonDeg -= 360;
      while (lonDeg < -180) lonDeg += 360;

      const speed = Math.sqrt(velEci.x ** 2 + velEci.y ** 2 + velEci.z ** 2);

      positions.push({
        date,
        msFromNow,
        longitude: lonDeg,
        latitude: latDeg,
        height: heightKm, // km
        speed, // km/s
      });
    } catch {
      // Skip propagation errors (satellite may have decayed)
      continue;
    }
  }

  if (positions.length === 0) {
    throw new Error('SGP4 propagation failed — TLE may be too old or invalid');
  }

  return { positions, info };
}

/**
 * Get current position of the satellite.
 */
export function getCurrentPosition(satrec) {
  const date = new Date();
  const pv = satellite.propagate(satrec, date);
  if (!pv.position || typeof pv.position === 'boolean') return null;

  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(pv.position, gmst);

  let lonDeg = geo.longitude * (180 / Math.PI);
  const latDeg = geo.latitude * (180 / Math.PI);
  while (lonDeg > 180) lonDeg -= 360;
  while (lonDeg < -180) lonDeg += 360;

  const speed = Math.sqrt(
    pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2
  );

  return {
    longitude: lonDeg,
    latitude: latDeg,
    height: geo.height,
    speed,
    date,
  };
}
