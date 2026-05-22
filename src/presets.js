/**
 * Preset TLE data for common satellites.
 *
 * NOTE: These are **synthetic placeholder TLEs** for demonstration purposes
 * only. They use generic orbital elements at a fixed epoch (day 1 of 2026)
 * and **must not** be used for operational pass prediction. To track real
 * satellites, replace them at runtime via Configuration → Add Satellite →
 * Search CelesTrak, or via the Auto Refresh / Fetch All TLEs buttons.
 *
 * Default seed: 4 General + 7 Sentinel satellites. Other groups (e.g. for
 * mission-specific constellations) are created by the user via the
 * Configuration → Groups CRUD UI.
 */
export const PRESETS = {
  // ─── General ───
  iss: {
    name: 'ISS (ZARYA)',
    group: 'general',
    noradId: 99001,
    tle: [
      'ISS (ZARYA)',
      '1 99001U 99001A   26001.00000000  .00000000  00000+0  00000-0 0  9996',
      '2 99001  51.6000   0.0000 0001000   0.0000   0.0000 15.50000000    05',
    ].join('\n'),
  },
  hubble: {
    name: 'Hubble Space Telescope',
    group: 'general',
    noradId: 99002,
    tle: [
      'HST',
      '1 99002U 99002A   26001.00000000  .00000000  00000+0  00000-0 0  9998',
      '2 99002  28.5000  30.0000 0003000  60.0000   0.0000 15.10000000    06',
    ].join('\n'),
  },
  noaa19: {
    name: 'NOAA 19',
    group: 'general',
    noradId: 99003,
    tle: [
      'NOAA 19',
      '1 99003U 99003A   26001.00000000  .00000000  00000+0  00000-0 0  9990',
      '2 99003  99.2000  60.0000 0014000  30.0000   0.0000 14.10000000    03',
    ].join('\n'),
  },
  css: {
    name: 'CSS (TIANHE)',
    group: 'general',
    noradId: 99004,
    tle: [
      'CSS (TIANHE)',
      '1 99004U 99004A   26001.00000000  .00000000  00000+0  00000-0 0  9992',
      '2 99004  41.5000  90.0000 0005000  80.0000   0.0000 15.60000000    08',
    ].join('\n'),
  },

  // ─── Sentinel (ESA Earth Observation) ───
  sentinel1a: {
    name: 'Sentinel-1A',
    group: 'sentinel',
    noradId: 99051,
    tle: [
      'SENTINEL-1A',
      '1 99051U 99051A   26001.00000000  .00000000  00000+0  00000-0 0  9998',
      '2 99051  98.1800 100.0000 0001000  90.0000   0.0000 15.18000000    01',
    ].join('\n'),
  },
  sentinel2a: {
    name: 'Sentinel-2A',
    group: 'sentinel',
    noradId: 99052,
    tle: [
      'SENTINEL-2A',
      '1 99052U 99052A   26001.00000000  .00000000  00000+0  00000-0 0  9990',
      '2 99052  98.6200 130.0000 0001000  90.0000   0.0000 14.31000000    02',
    ].join('\n'),
  },
  sentinel2b: {
    name: 'Sentinel-2B',
    group: 'sentinel',
    noradId: 99053,
    tle: [
      'SENTINEL-2B',
      '1 99053U 99053A   26001.00000000  .00000000  00000+0  00000-0 0  9992',
      '2 99053  98.6200 310.0000 0001000  90.0000   0.0000 14.31000000    03',
    ].join('\n'),
  },
  sentinel3a: {
    name: 'Sentinel-3A',
    group: 'sentinel',
    noradId: 99054,
    tle: [
      'SENTINEL-3A',
      '1 99054U 99054A   26001.00000000  .00000000  00000+0  00000-0 0  9994',
      '2 99054  98.6500 200.0000 0001000   0.0000   0.0000 14.26000000    04',
    ].join('\n'),
  },
  sentinel3b: {
    name: 'Sentinel-3B',
    group: 'sentinel',
    noradId: 99055,
    tle: [
      'SENTINEL-3B',
      '1 99055U 99055A   26001.00000000  .00000000  00000+0  00000-0 0  9996',
      '2 99055  98.6500  20.0000 0001000   0.0000   0.0000 14.26000000    05',
    ].join('\n'),
  },
  sentinel5p: {
    name: 'Sentinel-5P',
    group: 'sentinel',
    noradId: 99056,
    tle: [
      'SENTINEL-5P',
      '1 99056U 99056A   26001.00000000  .00000000  00000+0  00000-0 0  9998',
      '2 99056  98.7400 270.0000 0001000  90.0000   0.0000 14.23000000    06',
    ].join('\n'),
  },
  sentinel6: {
    name: 'Sentinel-6 Michael Freilich',
    group: 'sentinel',
    noradId: 99057,
    tle: [
      'SENTINEL-6 MICHAEL FREILICH',
      '1 99057U 99057A   26001.00000000  .00000000  00000+0  00000-0 0  9990',
      '2 99057  66.0400  60.0000 0001000  90.0000   0.0000 12.81000000    07',
    ].join('\n'),
  },
};
