import { describe, it, expect, beforeEach } from 'vitest';
import { getState, patch } from '../app-store.js';
import { findGroup, getGroupLabel, isGroupSchedulable, getSortedGroups } from '../groups.js';

/**
 * Replace the whole `groups` slice (the store shallow-merges object slices, so
 * we must delete existing keys before assigning the new record).
 * @param {Record<string, object>} record
 */
function setGroups(record) {
  patch('groups', (current) => {
    for (const key of Object.keys(current)) delete current[key];
    return record;
  });
}

// Mirrors the real store shape: keyed by group id, satellites reference by name.
// Built-in groups have id === name; user-created groups get a slugified id.
const GROUPS = {
  general: { id: 'general', name: 'general', label: 'General', color: '#94a3b8', sortOrder: 10, schedulable: true },
  // User-created: note id ("weather_sats") !== name ("Weather Sats").
  weather_sats: { id: 'weather_sats', name: 'Weather Sats', label: 'Weather Satellites', color: '#7dd3fc', sortOrder: 30, schedulable: true },
  // User-created, non-schedulable.
  archived: { id: 'archived', name: 'Archived Fleet', label: 'Archived Fleet', color: '#f97316', sortOrder: 40, schedulable: false },
};

beforeEach(() => {
  setGroups(structuredClone(GROUPS));
});

describe('findGroup', () => {
  it('resolves a built-in group by its shared id/name', () => {
    expect(findGroup('general')?.id).toBe('general');
  });

  it('resolves a user group by its slugified id', () => {
    expect(findGroup('weather_sats')?.name).toBe('Weather Sats');
  });

  it('resolves a user group by its NAME even though the store is keyed by id', () => {
    // This is the crux of the bug: satellites reference groups by name.
    expect(findGroup('Weather Sats')?.id).toBe('weather_sats');
  });

  it('returns null for missing / empty keys', () => {
    expect(findGroup('nope')).toBeNull();
    expect(findGroup('')).toBeNull();
    expect(findGroup(null)).toBeNull();
    expect(findGroup(undefined)).toBeNull();
  });
});

describe('isGroupSchedulable', () => {
  it('is true for a built-in schedulable group (by name)', () => {
    expect(isGroupSchedulable('general')).toBe(true);
  });

  it('is true for a user group referenced by NAME (regression: was false)', () => {
    // Before the fix, isGroupSchedulable('Weather Sats') looked up
    // groups['Weather Sats'] against an id-keyed map, got undefined, and
    // returned false — hiding the group + its satellites from the selectors.
    expect(isGroupSchedulable('Weather Sats')).toBe(true);
  });

  it('is true for a user group referenced by id', () => {
    expect(isGroupSchedulable('weather_sats')).toBe(true);
  });

  it('is false for a non-schedulable group (by name or id)', () => {
    expect(isGroupSchedulable('Archived Fleet')).toBe(false);
    expect(isGroupSchedulable('archived')).toBe(false);
  });

  it('is false for missing / empty keys', () => {
    expect(isGroupSchedulable('nope')).toBe(false);
    expect(isGroupSchedulable('')).toBe(false);
    expect(isGroupSchedulable(null)).toBe(false);
    expect(isGroupSchedulable(undefined)).toBe(false);
  });
});

describe('getGroupLabel', () => {
  it('returns the label when resolved by name', () => {
    expect(getGroupLabel('Weather Sats')).toBe('Weather Satellites');
  });

  it('returns the label when resolved by id', () => {
    expect(getGroupLabel('weather_sats')).toBe('Weather Satellites');
  });

  it('falls back to the key when the group is missing', () => {
    expect(getGroupLabel('Unknown Group')).toBe('Unknown Group');
  });

  it('returns the em dash placeholder for empty keys', () => {
    expect(getGroupLabel('')).toBe('—');
    expect(getGroupLabel(null)).toBe('—');
    expect(getGroupLabel(undefined)).toBe('—');
  });
});

describe('getSortedGroups', () => {
  it('sorts by sortOrder ascending', () => {
    const ids = getSortedGroups().map((g) => g.id);
    expect(ids).toEqual(['general', 'weather_sats', 'archived']);
  });

  it('reads live from the store', () => {
    setGroups({});
    expect(getSortedGroups()).toEqual([]);
    expect(getState().groups).toEqual({});
  });
});
