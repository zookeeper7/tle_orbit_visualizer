/**
 * Groups helper module — single source of truth for group label lookup
 * and schedulable-flag checks. Replaces the previously duplicated
 * GROUP_LABELS constants that lived in configuration.js and orbit-viewer.js.
 *
 * All reads go through the app-store, so any subscriber that depends on
 * group labels or schedulability will re-render automatically when a group
 * is added/edited/deleted.
 */

import { getState } from './app-store.js';

/**
 * Resolve a group by either its store key (id) OR its name.
 *
 * The groups slice is keyed by group id, but satellites reference their group
 * by NAME (`satellite.groupName`). For the built-in groups id === name, so a
 * direct key lookup happens to work. User-created groups, however, get a
 * slugified id derived from the name (e.g. name "Weather Sats" → id
 * "weather_sats"), so looking them up by name against the id-keyed map misses
 * and the group looks non-existent / non-schedulable — which hides the group
 * and its satellites from the Orbit Viewer and Schedule Manager selectors.
 *
 * Resolving by id first (fast path, also covers built-ins) and falling back to
 * a name scan makes both id- and name-based callers correct.
 *
 * @param {string|null|undefined} groupKey - a group id or a group name
 * @returns {object|null}
 */
export function findGroup(groupKey) {
  if (!groupKey) return null;
  const groups = getState().groups || {};
  // Fast path: direct id hit (also covers built-in groups where id === name).
  if (groups[groupKey]) return groups[groupKey];
  // Fallback: satellites reference groups by name, but user-created groups are
  // stored under a slugified id, so scan for a matching name.
  for (const group of Object.values(groups)) {
    if (group?.name === groupKey) return group;
  }
  return null;
}

/**
 * Return the human-readable label for a group id or name.
 * Falls back to the key itself if the group is missing, and to '—' if no key.
 * @param {string|null|undefined} groupId
 * @returns {string}
 */
export function getGroupLabel(groupId) {
  if (!groupId) return '—';
  return findGroup(groupId)?.label || groupId;
}

/**
 * Check whether a group is marked as schedulable (i.e. included in
 * Schedule Manager + Orbit Viewer satellite selectors).
 * Returns false if the group is missing or has schedulable=false.
 * Accepts either a group id or a group name.
 * @param {string|null|undefined} groupId
 * @returns {boolean}
 */
export function isGroupSchedulable(groupId) {
  if (!groupId) return false;
  return findGroup(groupId)?.schedulable === true;
}

/**
 * Return groups sorted by (sortOrder asc, name asc).
 * Result is a plain array; caller is responsible for mapping to UI.
 * @returns {Array<{id:string,name:string,label:string,color:string,sortOrder:number,schedulable:boolean}>}
 */
export function getSortedGroups() {
  const groups = getState().groups || {};
  return Object.values(groups).sort((a, b) => {
    const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (so !== 0) return so;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}
