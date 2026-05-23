/**
 * Pure helpers for the mobile Connection & TLE UI.
 *
 * All exports are side-effect-free and DOM-free so they're trivially
 * unit-testable under jsdom + vitest. The mobile-main.js orchestrator
 * imports them and pairs them with DOM updates and Cesium calls.
 */

/**
 * Translate the connection state machine into the value the top-bar dot's
 * `data-state` attribute should carry. The dot is *hidden* when online or
 * idle (silence is the norm); only checking, fetching, and offline render.
 *
 * @param {'idle'|'checking'|'online'|'offline'|'fetching'} connState
 * @returns {'idle'|'checking'|'offline'|'fetching'}
 */
export function pickConnDotState(connState) {
  switch (connState) {
    case 'checking': return 'checking';
    case 'fetching': return 'fetching';
    case 'offline':  return 'offline';
    case 'online':   return 'idle'; // collapse: online means no badge
    case 'idle':
    default:         return 'idle';
  }
}

/**
 * Compose the "N / M" counter label for the batch-fetch progress bar.
 * Clamps both inputs defensively so a buggy caller can't render
 * "-3 / 11" or "15 / 11".
 *
 * @param {number} done
 * @param {number} total
 * @returns {string} e.g. "3 / 11"
 */
export function formatBatchLabel(done, total) {
  const t = Math.max(0, Number.isFinite(total) ? Math.trunc(total) : 0);
  const d = Math.max(0, Math.min(t, Number.isFinite(done) ? Math.trunc(done) : 0));
  return `${d} / ${t}`;
}

/**
 * Compose the percentage (0..100) the progress bar fill should occupy.
 * Returns 0 when total <= 0 (no NaN, no Infinity).
 *
 * @param {number} done
 * @param {number} total
 * @returns {number} integer 0..100
 */
export function formatBatchPercent(done, total) {
  const t = Number.isFinite(total) ? total : 0;
  if (t <= 0) return 0;
  const d = Number.isFinite(done) ? done : 0;
  if (d >= t) return 100;
  if (d <= 0) return 0;
  return Math.round((d / t) * 100);
}

/**
 * Diff two satellite TLE maps. Returns the sorted set of ids whose
 * TLE string changed (added, removed, or modified).
 *
 * @param {Map<string,string>} prev
 * @param {Map<string,string>} next
 * @returns {string[]} sorted array of changed satellite ids
 */
export function diffSatelliteTles(prev, next) {
  const changed = new Set();
  for (const [id, tle] of next) {
    if (prev.get(id) !== tle) changed.add(id);
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) changed.add(id);
  }
  return Array.from(changed).sort();
}

/**
 * Run an async worker over a list of items with a bounded concurrency
 * limit. Returns a Promise.allSettled-shaped result array (in input order).
 *
 * If `options.signal` is an AbortSignal that fires, items that have NOT
 * yet started are rejected immediately with the abort reason. In-flight
 * items are allowed to complete naturally; the helper does NOT cancel
 * them (the worker is free to honour the signal itself).
 *
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, idx: number) => Promise<R>} worker
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{status:'fulfilled', value:R} | {status:'rejected', reason:any}>>}
 */
export async function runWithConcurrency(items, limit, worker, options = {}) {
  const { signal } = options;
  const n = items.length;
  const results = new Array(n);
  const safeLimit = Math.max(1, Math.min(n, Number.isFinite(limit) ? Math.trunc(limit) : 1));
  let nextIdx = 0;

  function abortReason() {
    return signal && typeof signal.reason !== 'undefined'
      ? signal.reason
      : new Error('AbortError');
  }

  async function runOne() {
    while (true) {
      if (signal && signal.aborted) return;
      const i = nextIdx;
      if (i >= n) return;
      nextIdx += 1;
      try {
        const value = await worker(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < safeLimit; i += 1) {
    workers.push(runOne());
  }
  await Promise.all(workers);

  // Any slots that the abort skipped are filled with a rejected result so
  // the output array is dense and Promise.allSettled-shaped.
  if (signal && signal.aborted) {
    for (let i = 0; i < n; i += 1) {
      if (!results[i]) results[i] = { status: 'rejected', reason: abortReason() };
    }
  }

  return results;
}
