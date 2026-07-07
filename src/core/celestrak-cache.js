/**
 * Client-side GP (OMM) fetch cache.
 *
 * CelesTrak only recomputes GP data about once every 2 hours and now enforces
 * hard rate limits (repeated downloads within an update window return HTTP 403
 * and can get an IP firewalled). This cache makes the app respect that cadence:
 * even if the Auto-Refresh timer fires every 30 min / 1 h, an actual network
 * request only happens when the cached record for that catalog number is
 * >= 2 h old.
 *
 * Entries are keyed by canonical NORAD catalog number (as a string) — NOT by
 * app satellite id — so the same object shared across tabs/entries reuses one
 * fetch. The cache stores the raw OMM record (the source of truth); the TLE is
 * derived on read via ommToTLE. Manual TLE edits do NOT touch this cache.
 *
 * Browser-only (localStorage). In non-browser contexts (Node server) it no-ops
 * and every lookup misses, which is safe — the server has its own guard.
 */

const CACHE_KEY = 'tle-viz:gp-cache';

/** CelesTrak GP update cadence — do not re-fetch a catalog number faster than this. */
export const GP_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function getStore() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readAll() {
  const store = getStore();
  if (!store) return {};
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  const store = getStore();
  if (!store) return;
  try {
    store.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
    /* quota exceeded or storage disabled — cache is best-effort */
  }
}

function keyFor(noradId) {
  return String(noradId == null ? '' : noradId).trim();
}

/**
 * Return the cached OMM for a catalog number if it is fresh (younger than the
 * TTL), else null. `opts.now` / `opts.ttlMs` are injectable for testing.
 * @param {number|string} noradId
 * @param {{ now?: number, ttlMs?: number }} [opts]
 * @returns {Record<string, unknown>|null}
 */
export function getCachedGP(noradId, opts = {}) {
  const key = keyFor(noradId);
  if (!key) return null;
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : GP_CACHE_TTL_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const entry = readAll()[key];
  if (!entry || !entry.omm || !Number.isFinite(entry.fetchedAt)) return null;
  if (now - entry.fetchedAt >= ttl) return null; // stale
  return entry.omm;
}

/**
 * Age (ms) of the cached record for a catalog number, or null if none.
 * @param {number|string} noradId
 * @param {{ now?: number }} [opts]
 * @returns {number|null}
 */
export function getCacheAgeMs(noradId, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const entry = readAll()[keyFor(noradId)];
  if (!entry || !Number.isFinite(entry.fetchedAt)) return null;
  return now - entry.fetchedAt;
}

/**
 * Store an OMM record for a catalog number, stamping it with the fetch time.
 * Also prunes entries older than 4× the TTL to bound growth.
 * @param {number|string} noradId
 * @param {Record<string, unknown>} omm
 * @param {{ now?: number }} [opts]
 */
export function setCachedGP(noradId, omm, opts = {}) {
  const key = keyFor(noradId);
  if (!key || !omm || typeof omm !== 'object') return;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const map = readAll();
  map[key] = { fetchedAt: now, omm };
  const cutoff = now - 4 * GP_CACHE_TTL_MS;
  for (const k of Object.keys(map)) {
    if (k === key) continue;
    const at = map[k]?.fetchedAt;
    if (!Number.isFinite(at) || at < cutoff) delete map[k];
  }
  writeAll(map);
}

/**
 * Clear the cache for one catalog number, or the whole cache when called with
 * no argument.
 * @param {number|string} [noradId]
 */
export function clearGPCache(noradId) {
  if (noradId == null) {
    const store = getStore();
    if (store) {
      try { store.removeItem(CACHE_KEY); } catch { /* ignore */ }
    }
    return;
  }
  const map = readAll();
  delete map[keyFor(noradId)];
  writeAll(map);
}
