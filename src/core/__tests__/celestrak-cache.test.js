import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedGP,
  setCachedGP,
  getCacheAgeMs,
  clearGPCache,
  GP_CACHE_TTL_MS,
} from '../celestrak-cache.js';

const OMM = { NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)' };

beforeEach(() => {
  clearGPCache();
  localStorage.clear();
});

describe('celestrak-cache', () => {
  it('is 2 hours by default', () => {
    expect(GP_CACHE_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('returns null on a miss', () => {
    expect(getCachedGP(25544)).toBeNull();
    expect(getCacheAgeMs(25544)).toBeNull();
  });

  it('stores and returns a fresh entry, with age', () => {
    const t0 = 1_000_000;
    setCachedGP(25544, OMM, { now: t0 });
    expect(getCachedGP(25544, { now: t0 + 1000 })).toEqual(OMM);
    expect(getCacheAgeMs(25544, { now: t0 + 1000 })).toBe(1000);
  });

  it('expires entries at/after the TTL (fresh just before)', () => {
    const t0 = 1_000_000;
    setCachedGP(25544, OMM, { now: t0 });
    expect(getCachedGP(25544, { now: t0 + GP_CACHE_TTL_MS - 1 })).toEqual(OMM);
    expect(getCachedGP(25544, { now: t0 + GP_CACHE_TTL_MS })).toBeNull();
  });

  it('keys by catalog number (string/number equivalent)', () => {
    setCachedGP(25544, OMM, { now: 5 });
    expect(getCachedGP('25544', { now: 5 })).toEqual(OMM);
  });

  it('supports 6-digit catalog numbers as keys', () => {
    const big = { NORAD_CAT_ID: 148493, OBJECT_NAME: 'FUTURE' };
    setCachedGP(148493, big, { now: 5 });
    expect(getCachedGP(148493, { now: 5 })).toEqual(big);
  });

  it('clears a single entry and the whole cache', () => {
    setCachedGP(25544, OMM, { now: 5 });
    setCachedGP(20580, { NORAD_CAT_ID: 20580 }, { now: 5 });
    clearGPCache(25544);
    expect(getCachedGP(25544, { now: 5 })).toBeNull();
    expect(getCachedGP(20580, { now: 5 })).toBeTruthy();
    clearGPCache();
    expect(getCachedGP(20580, { now: 5 })).toBeNull();
  });

  it('persists to localStorage', () => {
    setCachedGP(25544, OMM, { now: 5 });
    expect(getCachedGP(25544, { now: 15 })).toEqual(OMM);
    expect(localStorage.getItem('tle-viz:gp-cache')).toContain('25544');
  });
});
