import { describe, it, expect, vi } from 'vitest';
import {
  pickConnDotState,
  formatBatchLabel,
  formatBatchPercent,
  diffSatelliteTles,
  runWithConcurrency,
} from '../conn-tle-helpers.js';

// ─── pickConnDotState ─────────────────────────────────────────────────────

describe('pickConnDotState', () => {
  it('idle → idle', () => {
    expect(pickConnDotState('idle')).toBe('idle');
  });
  it('online → idle (hidden when normal)', () => {
    expect(pickConnDotState('online')).toBe('idle');
  });
  it('checking → checking', () => {
    expect(pickConnDotState('checking')).toBe('checking');
  });
  it('offline → offline', () => {
    expect(pickConnDotState('offline')).toBe('offline');
  });
  it('fetching → fetching', () => {
    expect(pickConnDotState('fetching')).toBe('fetching');
  });
  it('unknown → idle (defensive)', () => {
    expect(pickConnDotState('garbage')).toBe('idle');
    expect(pickConnDotState(undefined)).toBe('idle');
    expect(pickConnDotState(null)).toBe('idle');
  });
});

// ─── formatBatchLabel ─────────────────────────────────────────────────────

describe('formatBatchLabel', () => {
  it('0 / 0', () => { expect(formatBatchLabel(0, 0)).toBe('0 / 0'); });
  it('0 / 11', () => { expect(formatBatchLabel(0, 11)).toBe('0 / 11'); });
  it('3 / 11', () => { expect(formatBatchLabel(3, 11)).toBe('3 / 11'); });
  it('11 / 11', () => { expect(formatBatchLabel(11, 11)).toBe('11 / 11'); });
  it('clamps negative done to 0', () => { expect(formatBatchLabel(-3, 11)).toBe('0 / 11'); });
  it('clamps overflow done to total', () => { expect(formatBatchLabel(15, 11)).toBe('11 / 11'); });
  it('clamps negative total to 0', () => { expect(formatBatchLabel(0, -5)).toBe('0 / 0'); });
});

// ─── formatBatchPercent ───────────────────────────────────────────────────

describe('formatBatchPercent', () => {
  it('0 of 11 → 0', () => { expect(formatBatchPercent(0, 11)).toBe(0); });
  it('5 of 10 → 50', () => { expect(formatBatchPercent(5, 10)).toBe(50); });
  it('11 of 11 → 100', () => { expect(formatBatchPercent(11, 11)).toBe(100); });
  it('zero total → 0 (no NaN)', () => { expect(formatBatchPercent(3, 0)).toBe(0); });
  it('overflow done → 100', () => { expect(formatBatchPercent(20, 11)).toBe(100); });
});

// ─── diffSatelliteTles ────────────────────────────────────────────────────

describe('diffSatelliteTles', () => {
  it('no change → empty array', () => {
    const a = new Map([['iss', 'X'], ['hubble', 'Y']]);
    const b = new Map([['iss', 'X'], ['hubble', 'Y']]);
    expect(diffSatelliteTles(a, b)).toEqual([]);
  });
  it('one changed TLE → that id', () => {
    const a = new Map([['iss', 'X'], ['hubble', 'Y']]);
    const b = new Map([['iss', 'X-FRESH'], ['hubble', 'Y']]);
    expect(diffSatelliteTles(a, b)).toEqual(['iss']);
  });
  it('one added satellite → that id', () => {
    const a = new Map([['iss', 'X']]);
    const b = new Map([['iss', 'X'], ['noaa19', 'Z']]);
    expect(diffSatelliteTles(a, b)).toEqual(['noaa19']);
  });
  it('one removed satellite → that id', () => {
    const a = new Map([['iss', 'X'], ['hubble', 'Y']]);
    const b = new Map([['iss', 'X']]);
    expect(diffSatelliteTles(a, b)).toEqual(['hubble']);
  });
  it('multiple changes → sorted unique ids', () => {
    const a = new Map([['iss', 'X'], ['hubble', 'Y'], ['noaa19', 'Z']]);
    const b = new Map([['iss', 'X-NEW'], ['css', 'W'], ['noaa19', 'Z-NEW']]);
    // iss changed, hubble removed, css added, noaa19 changed
    expect(diffSatelliteTles(a, b)).toEqual(['css', 'hubble', 'iss', 'noaa19']);
  });
});

// ─── runWithConcurrency ───────────────────────────────────────────────────

describe('runWithConcurrency', () => {
  it('sequential (limit=1) preserves order of resolution', async () => {
    const items = [1, 2, 3, 4, 5];
    const order = [];
    const worker = async (n) => {
      // Quick microtask completion
      order.push(n);
      return n * 10;
    };
    const results = await runWithConcurrency(items, 1, worker);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((r) => r.value)).toEqual([10, 20, 30, 40, 50]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('limit=3 runs at most 3 concurrent', async () => {
    let active = 0;
    let maxActive = 0;
    const worker = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 8));
      active -= 1;
      return 'ok';
    };
    const items = new Array(11).fill(0);
    const results = await runWithConcurrency(items, 3, worker);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThanOrEqual(2); // at least 2 ran in parallel given 11 items
    expect(results.length).toBe(11);
    expect(results.every((r) => r.status === 'fulfilled' && r.value === 'ok')).toBe(true);
  });

  it('rejected worker is captured as { status: "rejected", reason }', async () => {
    const worker = async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    };
    const results = await runWithConcurrency([1, 2, 3], 1, worker);
    expect(results.length).toBe(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1].status).toBe('rejected');
    expect(results[1].reason).toBeInstanceOf(Error);
    expect(results[1].reason.message).toBe('boom');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('AbortSignal aborts pending items, lets in-flight items complete', async () => {
    const controller = new AbortController();
    const started = [];
    const worker = vi.fn(async (n) => {
      started.push(n);
      // Item 1 starts immediately, item 2 starts a tick later. Abort happens
      // before item 3 has a chance to start.
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 15));
        return 'done-1';
      }
      return `done-${n}`;
    });
    const promise = runWithConcurrency([1, 2, 3, 4, 5], 1, worker, { signal: controller.signal });
    // Abort after the first item starts but before it resolves.
    setTimeout(() => controller.abort(), 4);
    const results = await promise;
    // First item should be in `started`; later items should NOT have started.
    expect(started).toContain(1);
    expect(started).not.toContain(3);
    expect(started).not.toContain(4);
    expect(started).not.toContain(5);
    expect(results.length).toBe(5);
    // First item resolved fulfilled OR rejected (timing-dependent), but
    // items 3..5 must be rejected with an AbortError-ish reason.
    expect(results[2].status).toBe('rejected');
    expect(results[3].status).toBe('rejected');
    expect(results[4].status).toBe('rejected');
  });
});
