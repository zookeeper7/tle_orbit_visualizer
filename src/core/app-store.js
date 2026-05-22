/**
 * Centralized application state store.
 *
 * Single source of truth for all data. UI tabs, Cesium entities,
 * and computation modules are projections of this state.
 *
 * Usage:
 *   import { getState, patch, subscribe } from './core/app-store.js';
 *
 *   const s = getState();            // read-only snapshot
 *   patch('ui', { activeTab: 'schedule-manager' });  // merge into slice
 *   subscribe('ui', (uiState) => { ... });           // react to changes
 */

const state = {
  /** @type {Record<string, object>} */
  groups: {},

  /** @type {Record<string, import('../presets.js').Satellite>} */
  satellites: {},

  /** @type {Record<string, object>} */
  stations: {},

  /** @type {Record<string, object>} */
  antennas: {},

  /** @type {Array<object>} */
  antennaMappings: [],

  /** @type {Record<string, object>} */
  passes: {},

  /** @type {Array} */
  conflicts: [],

  /** @type {object} */
  ui: {
    activeTab: 'orbit-viewer',
    timeWindow: { start: null, end: null },
    selectedSatellites: [],
    selectedPasses: [],
  },
};

/** @type {Map<string, Set<Function>>} */
const subscribers = new Map();

/**
 * Get current state (read-only reference).
 * Do NOT mutate the returned object — use patch() instead.
 */
export function getState() {
  return state;
}

/**
 * Merge partial updates into a state slice and notify subscribers.
 *
 * @param {string} sliceName - Top-level key in state (e.g. 'ui', 'passes')
 * @param {object|Function} updater - Object to shallow-merge, or function(currentSlice) → partial
 */
export function patch(sliceName, updater) {
  if (!(sliceName in state)) {
    throw new Error(`Unknown state slice: "${sliceName}"`);
  }

  const current = state[sliceName];
  const partial = typeof updater === 'function' ? updater(current) : updater;

  if (Array.isArray(current)) {
    // For array slices, replace entirely
    state[sliceName] = partial;
  } else if (typeof current === 'object' && current !== null) {
    // For object slices, shallow merge
    Object.assign(current, partial);
  } else {
    state[sliceName] = partial;
  }

  // Notify subscribers
  const subs = subscribers.get(sliceName);
  if (subs) {
    for (const fn of subs) {
      try { fn(state[sliceName]); } catch (e) { console.error(`Store subscriber error [${sliceName}]:`, e); }
    }
  }
}

/**
 * Subscribe to changes on a state slice.
 *
 * @param {string} sliceName
 * @param {Function} callback - Called with the updated slice value
 * @returns {Function} Unsubscribe function
 */
export function subscribe(sliceName, callback) {
  if (!subscribers.has(sliceName)) {
    subscribers.set(sliceName, new Set());
  }
  subscribers.get(sliceName).add(callback);

  return () => {
    subscribers.get(sliceName)?.delete(callback);
  };
}
