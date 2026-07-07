import { describe, it, expect, beforeEach } from 'vitest';
import { getState, patch } from '../app-store.js';
import { findGroup, getGroupLabel, isGroupSchedulable, getSortedGroups, filterSelectableSatelliteIds } from '../groups.js';

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

describe('filterSelectableSatelliteIds', () => {
  // groupName references a group NAME (as satellites do); 'general' + 'Weather Sats'
  // are schedulable, 'Archived Fleet' is not, 'custom' does not exist (→ non-schedulable).
  const SATS = {
    s1: { id: 's1', enabled: true, groupName: 'general' },          // enabled + schedulable
    s2: { id: 's2', enabled: false, groupName: 'general' },         // disabled
    s3: { id: 's3', enabled: true, groupName: 'Archived Fleet' },   // non-schedulable group
    s4: { id: 's4', enabled: true, groupName: 'Weather Sats' },     // schedulable (id !== name)
    s5: { id: 's5', enabled: true, group: 'general' },              // Orbit-Viewer shape (.group)
    interactive_kep: { id: 'interactive_kep', enabled: true, groupName: 'custom' },
  };

  it('keeps enabled satellites in schedulable groups (both sat shapes)', () => {
    expect(filterSelectableSatelliteIds(['s1', 's4', 's5'], SATS)).toEqual(['s1', 's4', 's5']);
  });

  it('drops disabled satellites', () => {
    expect(filterSelectableSatelliteIds(['s1', 's2'], SATS)).toEqual(['s1']);
  });

  it('drops satellites whose group is not schedulable', () => {
    expect(filterSelectableSatelliteIds(['s1', 's3'], SATS)).toEqual(['s1']);
  });

  it('drops ids missing from the store (deleted)', () => {
    expect(filterSelectableSatelliteIds(['s1', 'ghost'], SATS)).toEqual(['s1']);
  });

  it('drops an injected sat in a non-schedulable group by default', () => {
    expect(filterSelectableSatelliteIds(['interactive_kep'], SATS)).toEqual([]);
  });

  it('keeps an allow-listed injected sat even in a non-schedulable group', () => {
    expect(filterSelectableSatelliteIds(['interactive_kep'], SATS, { allow: ['interactive_kep'] }))
      .toEqual(['interactive_kep']);
  });

  it('allow-list still respects existence (a missing allowed id is dropped)', () => {
    expect(filterSelectableSatelliteIds(['ghost'], SATS, { allow: ['ghost'] })).toEqual([]);
  });

  it('preserves input order and only keeps eligible ids', () => {
    expect(filterSelectableSatelliteIds(['s3', 's1', 's2', 's4'], SATS)).toEqual(['s1', 's4']);
  });

  it('handles empty / null inputs gracefully', () => {
    expect(filterSelectableSatelliteIds([], {})).toEqual([]);
    expect(filterSelectableSatelliteIds(null, null)).toEqual([]);
    expect(filterSelectableSatelliteIds(new Set(['s1']), SATS)).toEqual(['s1']);
  });
});
