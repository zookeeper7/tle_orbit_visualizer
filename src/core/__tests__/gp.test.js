import { describe, it, expect } from 'vitest';
import { twoline2satrec, json2satrec, propagate } from 'satellite.js';
import { alpha5Encode, alpha5Decode, isTleRepresentable, ommToTLE, CelestrakError } from '../../gp.js';

// A real CelesTrak OMM record (gp.php?CATNR=25544&FORMAT=JSON) captured for ISS.
const ISS_OMM = {
  OBJECT_NAME: 'ISS (ZARYA)',
  OBJECT_ID: '1998-067A',
  EPOCH: '2026-07-07T04:27:30.183264',
  MEAN_MOTION: 15.48929707,
  ECCENTRICITY: 0.000669,
  INCLINATION: 51.6305,
  RA_OF_ASC_NODE: 201.1096,
  ARG_OF_PERICENTER: 265.7165,
  MEAN_ANOMALY: 94.3058,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 57485,
  BSTAR: 0.00011712,
  MEAN_MOTION_DOT: 5.994e-5,
  MEAN_MOTION_DDOT: 0,
};

const DEG = '\u00B0';
void DEG;

function tleChecksum(line) {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('alpha5Encode / alpha5Decode', () => {
  it('encodes classic 5-digit numbers with zero padding', () => {
    expect(alpha5Encode(25544)).toBe('25544');
    expect(alpha5Encode(964)).toBe('00964');
    expect(alpha5Encode(0)).toBe('00000');
    expect(alpha5Encode(99999)).toBe('99999');
  });

  it('encodes the Alpha-5 range (base 100000 -> A0000)', () => {
    expect(alpha5Encode(100000)).toBe('A0000');
    expect(alpha5Encode(100001)).toBe('A0001');
    expect(alpha5Encode(148493)).toBe('E8493'); // CelesTrak's canonical example
    expect(alpha5Encode(190000)).toBe('K0000'); // high=19 -> ALPHA5[9]='K'
    expect(alpha5Encode(200000)).toBe('L0000'); // high=20 -> ALPHA5[10]='L'
    expect(alpha5Encode(339999)).toBe('Z9999');
  });

  it('skips I and O in the alphabet', () => {
    // 180000 -> 'J' (18), NOT 'I'
    expect(alpha5Encode(180000)).toBe('J0000');
    // 230000 -> 'P' (23), NOT 'O'
    expect(alpha5Encode(230000)).toBe('P0000');
  });

  it('throws above the Alpha-5 ceiling', () => {
    expect(() => alpha5Encode(340000)).toThrow(CelestrakError);
    expect(() => alpha5Encode(799500000)).toThrow(/exceeds the Alpha-5 range/);
    try { alpha5Encode(340000); } catch (e) { expect(e.unsupported).toBe(true); }
  });

  it('rejects invalid input', () => {
    expect(() => alpha5Encode(-1)).toThrow(CelestrakError);
    expect(() => alpha5Encode(1.5)).toThrow(CelestrakError);
  });

  it('round-trips encode -> decode across the whole range', () => {
    for (const n of [0, 964, 25544, 99999, 100000, 100001, 148493, 180000, 230000, 339999]) {
      expect(alpha5Decode(alpha5Encode(n))).toBe(n);
    }
  });

  it('decodes both numeric and Alpha-5 fields, NaN on garbage', () => {
    expect(alpha5Decode('25544')).toBe(25544);
    expect(alpha5Decode('A0000')).toBe(100000);
    expect(alpha5Decode('Z9999')).toBe(339999);
    expect(Number.isNaN(alpha5Decode('I0000'))).toBe(true); // I not in alphabet
    expect(Number.isNaN(alpha5Decode(''))).toBe(true);
  });

  it('isTleRepresentable gates the ceiling', () => {
    expect(isTleRepresentable(25544)).toBe(true);
    expect(isTleRepresentable(339999)).toBe(true);
    expect(isTleRepresentable(340000)).toBe(false);
  });
});

describe('ommToTLE — structure & checksums', () => {
  const tle = ommToTLE(ISS_OMM);

  it('produces 69-character lines', () => {
    expect(tle.line1).toHaveLength(69);
    expect(tle.line2).toHaveLength(69);
  });

  it('starts lines with "1 " / "2 " and carries the name', () => {
    expect(tle.line1.startsWith('1 ')).toBe(true);
    expect(tle.line2.startsWith('2 ')).toBe(true);
    expect(tle.line0).toBe('ISS (ZARYA)');
    expect(tle.threeLine.split('\n')).toHaveLength(3);
  });

  it('places the catalog number and epoch in the right columns', () => {
    expect(tle.line1.substring(2, 7)).toBe('25544');
    expect(tle.line2.substring(2, 7)).toBe('25544');
    // epoch year 2026 -> "26", day-of-year ~188
    expect(tle.line1.substring(18, 20)).toBe('26');
  });

  it('has valid TLE checksums on both lines', () => {
    expect(Number(tle.line1[68])).toBe(tleChecksum(tle.line1));
    expect(Number(tle.line2[68])).toBe(tleChecksum(tle.line2));
  });
});

describe('ommToTLE — fidelity vs satellite.js json2satrec (THE round-trip gate)', () => {
  it('propagates within 100 m of json2satrec over 90 minutes', () => {
    const tle = ommToTLE(ISS_OMM);
    const fromTle = twoline2satrec(tle.line1, tle.line2);
    const fromOmm = json2satrec(ISS_OMM);

    const epoch = new Date(`${ISS_OMM.EPOCH}Z`);
    let maxKm = 0;
    for (let min = 0; min <= 90; min += 5) {
      const t = new Date(epoch.getTime() + min * 60000);
      const a = propagate(fromTle, t);
      const b = propagate(fromOmm, t);
      expect(a.position).toBeTruthy();
      expect(b.position).toBeTruthy();
      maxKm = Math.max(maxKm, dist(a.position, b.position));
    }
    // TLE truncation (8-decimal day/mean-motion) vs OMM's ms-precise epoch is
    // sub-meter here; assert a comfortable 100 m ceiling.
    expect(maxKm).toBeLessThan(0.1);
  });
});

describe('ommToTLE — Alpha-5 6-digit catalog numbers propagate', () => {
  it('generates an Alpha-5 TLE that satellite.js can parse and propagate', () => {
    const omm = { ...ISS_OMM, NORAD_CAT_ID: 148493, OBJECT_NAME: 'FUTURE-SAT' };
    const tle = ommToTLE(omm);
    expect(tle.line1.substring(2, 7)).toBe('E8493');
    expect(tle.line2.substring(2, 7)).toBe('E8493');

    const fromTle = twoline2satrec(tle.line1, tle.line2);
    const fromOmm = json2satrec(omm); // satnum "148493" as string
    const t = new Date(`${omm.EPOCH}Z`);
    const a = propagate(fromTle, t);
    const b = propagate(fromOmm, t);
    expect(a.position).toBeTruthy();
    expect(b.position).toBeTruthy();
    // satnum does not enter SGP4 math, so positions match regardless of Alpha-5.
    expect(dist(a.position, b.position)).toBeLessThan(0.1);
  });

  it('throws for catalog numbers a TLE cannot represent', () => {
    expect(() => ommToTLE({ ...ISS_OMM, NORAD_CAT_ID: 799500000 })).toThrow(/exceeds the Alpha-5 range/);
  });
});

describe('CelestrakError classification', () => {
  it('flags 403 as rate-limited and 404 as not-found', () => {
    const e403 = new CelestrakError('blocked', { status: 403 });
    expect(e403.isRateLimited).toBe(true);
    expect(e403.isNotFound).toBe(false);

    const e404 = new CelestrakError('missing', { status: 404 });
    expect(e404.isNotFound).toBe(true);
    expect(e404.isRateLimited).toBe(false);

    const generic = new CelestrakError('network');
    expect(generic.status).toBeNull();
    expect(generic.isRateLimited).toBe(false);
  });
});
