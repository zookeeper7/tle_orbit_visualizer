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
 * Return the human-readable label for a group id.
 * Falls back to the id itself if the group is missing, and to '—' if no id.
 * @param {string|null|undefined} groupId
 * @returns {string}
 */
export function getGroupLabel(groupId) {
  if (!groupId) return '—';
  const group = getState().groups?.[groupId];
  return group?.label || groupId;
}

/**
 * Check whether a group is marked as schedulable (i.e. included in
 * Schedule Manager + Orbit Viewer satellite selectors).
 * Returns false if the group is missing or has schedulable=false.
 * @param {string|null|undefined} groupId
 * @returns {boolean}
 */
export function isGroupSchedulable(groupId) {
  if (!groupId) return false;
  return getState().groups?.[groupId]?.schedulable === true;
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
