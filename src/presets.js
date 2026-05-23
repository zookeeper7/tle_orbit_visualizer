/**
 * Preset TLE data for common satellites.
 *
 * The NORAD IDs and international designators below are the REAL ones for
 * each satellite, so "Fetch Latest TLE" (which calls CelesTrak with
 * `satellite.noradId`) works out of the box on every preset. The orbital
 * elements in line 2 (inclination, RAAN, mean motion, …) are still
 * synthetic placeholders chosen to look plausible for the satellite's
 * known orbit — they are NOT operational and a CelesTrak fetch is the
 * right way to get real elements.
 *
 * Default seed: 4 General + 7 Sentinel satellites. Other groups (e.g. for
 * mission-specific constellations) are created by the user via the
 * Configuration → Groups CRUD UI.
 *
 * The TLE epoch is regenerated at module-load time (i.e. on every page
 * load) so the placeholders always propagate cleanly with SGP4 even if
 * the source code hasn't been touched in months. A static epoch goes
 * numerically unstable a few weeks past its date and the propagation
 * starts returning NaN x/y/z, which used to crash the renderer; see
 * orbit.js for the downstream NaN-guard. satellite.js does not verify TLE
 * checksums so we can mutate the epoch substring in place without
 * recomputing the trailing checksum digit.
 */

function epochStringNow() {
  // TLE line-1 epoch occupies 14 characters at column index 18..31 (0-based):
  //   YY  (2 chars, last two digits of year)
  //   DDD.DDDDDDDD (12 chars, day-of-year with 8-decimal fractional day,
  //                 1-indexed so Jan 1 00:00 UTC = "001.00000000")
  const now = new Date();
  const year2 = now.getUTCFullYear() % 100;
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  const dayOfYear = (now.getTime() - startOfYear) / 86_400_000 + 1;
  const yy = String(year2).padStart(2, '0');
  const ddd = dayOfYear.toFixed(8).padStart(12, '0');
  return yy + ddd;
}

function withFreshEpoch(tleLine1) {
  return tleLine1.substring(0, 18) + epochStringNow() + tleLine1.substring(32);
}

export const PRESETS = {
  // ─── General ───
  iss: {
    name: 'ISS (ZARYA)',
    group: 'general',
    noradId: 25544,
    tle: [
      'ISS (ZARYA)',
      withFreshEpoch('1 25544U 98067A   00000.00000000  .00000000  00000+0  00000-0 0  9996'),
      '2 25544  51.6000   0.0000 0001000   0.0000   0.0000 15.50000000    05',
    ].join('\n'),
  },
  hubble: {
    name: 'Hubble Space Telescope',
    group: 'general',
    noradId: 20580,
    tle: [
      'HST',
      withFreshEpoch('1 20580U 90037B   00000.00000000  .00000000  00000+0  00000-0 0  9998'),
      '2 20580  28.5000  30.0000 0003000  60.0000   0.0000 15.10000000    06',
    ].join('\n'),
  },
  noaa19: {
    name: 'NOAA 19',
    group: 'general',
    noradId: 33591,
    tle: [
      'NOAA 19',
      withFreshEpoch('1 33591U 09005A   00000.00000000  .00000000  00000+0  00000-0 0  9990'),
      '2 33591  99.2000  60.0000 0014000  30.0000   0.0000 14.10000000    03',
    ].join('\n'),
  },
  css: {
    name: 'CSS (TIANHE)',
    group: 'general',
    noradId: 48274,
    tle: [
      'CSS (TIANHE)',
      withFreshEpoch('1 48274U 21035A   00000.00000000  .00000000  00000+0  00000-0 0  9992'),
      '2 48274  41.5000  90.0000 0005000  80.0000   0.0000 15.60000000    08',
    ].join('\n'),
  },

  // ─── Sentinel (ESA Earth Observation) ───
  sentinel1a: {
    name: 'Sentinel-1A',
    group: 'sentinel',
    noradId: 39634,
    tle: [
      'SENTINEL-1A',
      withFreshEpoch('1 39634U 14016A   00000.00000000  .00000000  00000+0  00000-0 0  9998'),
      '2 39634  98.1800 100.0000 0001000  90.0000   0.0000 15.18000000    01',
    ].join('\n'),
  },
  sentinel2a: {
    name: 'Sentinel-2A',
    group: 'sentinel',
    noradId: 40697,
    tle: [
      'SENTINEL-2A',
      withFreshEpoch('1 40697U 15028A   00000.00000000  .00000000  00000+0  00000-0 0  9990'),
      '2 40697  98.6200 130.0000 0001000  90.0000   0.0000 14.31000000    02',
    ].join('\n'),
  },
  sentinel2b: {
    name: 'Sentinel-2B',
    group: 'sentinel',
    noradId: 42063,
    tle: [
      'SENTINEL-2B',
      withFreshEpoch('1 42063U 17013A   00000.00000000  .00000000  00000+0  00000-0 0  9992'),
      '2 42063  98.6200 310.0000 0001000  90.0000   0.0000 14.31000000    03',
    ].join('\n'),
  },
  sentinel3a: {
    name: 'Sentinel-3A',
    group: 'sentinel',
    noradId: 41335,
    tle: [
      'SENTINEL-3A',
      withFreshEpoch('1 41335U 16011A   00000.00000000  .00000000  00000+0  00000-0 0  9994'),
      '2 41335  98.6500 200.0000 0001000   0.0000   0.0000 14.26000000    04',
    ].join('\n'),
  },
  sentinel3b: {
    name: 'Sentinel-3B',
    group: 'sentinel',
    noradId: 43437,
    tle: [
      'SENTINEL-3B',
      withFreshEpoch('1 43437U 18039A   00000.00000000  .00000000  00000+0  00000-0 0  9996'),
      '2 43437  98.6500  20.0000 0001000   0.0000   0.0000 14.26000000    05',
    ].join('\n'),
  },
  sentinel5p: {
    name: 'Sentinel-5P',
    group: 'sentinel',
    noradId: 42969,
    tle: [
      'SENTINEL-5P',
      withFreshEpoch('1 42969U 17064A   00000.00000000  .00000000  00000+0  00000-0 0  9998'),
      '2 42969  98.7400 270.0000 0001000  90.0000   0.0000 14.23000000    06',
    ].join('\n'),
  },
  sentinel6: {
    name: 'Sentinel-6 Michael Freilich',
    group: 'sentinel',
    noradId: 46984,
    tle: [
      'SENTINEL-6 MICHAEL FREILICH',
      withFreshEpoch('1 46984U 20086A   00000.00000000  .00000000  00000+0  00000-0 0  9990'),
      '2 46984  66.0400  60.0000 0001000  90.0000   0.0000 12.81000000    07',
    ].join('\n'),
  },
};
