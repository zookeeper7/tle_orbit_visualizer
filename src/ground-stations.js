/**
 * Ground station management and coverage computation.
 *
 * Coverage radius is the Earth-surface distance from the station
 * within which a satellite at a given altitude is visible above
 * the minimum elevation angle.
 *
 * Geometry (Earth-center triangle):
 *   sin(η) = R · cos(ε) / (R + h)
 *   ρ      = π/2 − ε − η            (Earth central angle)
 *   radius = R · ρ                   (ground range, km)
 */

const EARTH_RADIUS_KM = 6371;

/**
 * Default ground stations for demonstration.
 *
 * These are **synthetic placeholders** so the demo runs out of the box.
 * Replace them at runtime via Configuration → Ground Stations for real
 * operational use.
 */
export const DEFAULT_STATIONS = [
  {
    id: 'station_a',
    name: 'Demo Station Alpha',
    lat: 25.3,
    lon: 51.5,
    minElevDeg: 5,
    antennas: [
      { id: 'station_a_ant1', name: 'Demo Antenna A1', type: 'primary' },
      { id: 'station_a_ant2', name: 'Demo Antenna A2', type: 'backup' },
    ],
  },
  {
    id: 'station_b',
    name: 'Demo Station Beta',
    lat: 60.0,
    lon: 10.0,
    minElevDeg: 5,
    antennas: [
      { id: 'station_b_ant1', name: 'Demo Antenna B1', type: 'primary' },
      { id: 'station_b_ant2', name: 'Demo Antenna B2', type: 'backup' },
    ],
  },
  {
    id: 'station_c',
    name: 'Demo Station Gamma',
    lat: -33.87,
    lon: 151.21,
    minElevDeg: 5,
    antennas: [
      { id: 'station_c_ant1', name: 'Demo Antenna C1', type: 'primary' },
    ],
  },
];

let _idCounter = 100;

/** Generate a unique station ID. */
export function nextStationId() {
  return `gs_${++_idCounter}`;
}

/**
 * Compute the ground-range radius of the coverage circle.
 * @param {number} altitudeKm - Satellite altitude above surface (km)
 * @param {number} minElevDeg - Minimum elevation angle (degrees)
 * @returns {number} Coverage radius on Earth surface (km)
 */
export function computeCoverageRadiusKm(altitudeKm, minElevDeg) {
  const R = EARTH_RADIUS_KM;
  const eps = (minElevDeg * Math.PI) / 180;
  const sinEta = (R * Math.cos(eps)) / (R + altitudeKm);

  if (sinEta >= 1) return 0; // satellite is below the horizon

  const eta = Math.asin(sinEta);
  const rho = Math.PI / 2 - eps - eta;

  return rho > 0 ? R * rho : 0;
}
