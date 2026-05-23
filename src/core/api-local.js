/**
 * localStorage backend — mirrors server.js but stores everything in the
 * browser's localStorage so the app works as a 100% static site (no Node,
 * no SQLite, no API server).
 *
 * Each visitor has their own isolated copy. Data persists across reloads
 * but is scoped to (origin, browser, profile). Incognito sessions and
 * other devices start with the seed defaults.
 *
 * Seed defaults are identical to server.js's seedDefaults() — same
 * groups, same preset satellites, same demo ground stations, same
 * antenna→satellite mappings — so the demo UX matches the self-hosted
 * server UX from the very first load.
 *
 * Activated when the app is built with VITE_BACKEND=local (see api.js).
 */

import { DEFAULT_STATIONS } from '../ground-stations.js';
import { PRESETS } from '../presets.js';
import { parseMaskCSV } from './azimuth-mask.js';
import { fetchLatestTLE } from '../tle-fetch.js';

const NS = 'tle-viz';
const K = {
  groups: `${NS}:groups`,
  satellites: `${NS}:satellites`,
  stations: `${NS}:stations`,
  antennas: `${NS}:antennas`,
  antennaMappings: `${NS}:antenna_mappings`,
  antennaMasks: `${NS}:antenna_masks`,
  passes: `${NS}:passes`,
  settings: `${NS}:settings`,
  seeded: `${NS}:seeded`,
  meta: `${NS}:meta`,
};

const SAT_COLORS = [
  '#7dd3fc', '#fbbf24', '#fb7185', '#34d399', '#a78bfa',
  '#f97316', '#38bdf8', '#f472b6', '#4ade80', '#c084fc',
  '#fb923c', '#22d3ee', '#e879f9', '#a3e635', '#fca5a5',
  '#67e8f9', '#d946ef', '#bef264',
];

const BUILTIN_GROUPS = [
  { id: 'general', name: 'general', label: 'General', color: '#94a3b8', sortOrder: 10, schedulable: true },
  { id: 'sentinel', name: 'sentinel', label: 'Sentinel', color: '#34d399', sortOrder: 20, schedulable: true },
];

// ─── Storage helpers ───────────────────────────────────────────────────────
//
// read()/write() lazily run the seed on first use so that simply importing
// this module has zero side effects. That lets the REST build (which routes
// through api-rest.js but still imports api-local.js for the build-time
// branch in api.js) avoid polluting the user's localStorage.

let _seeded = false;

function readRaw(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeRaw(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function read(key, fallback) {
  ensureSeeded();
  return readRaw(key, fallback);
}

function write(key, value) {
  ensureSeeded();
  writeRaw(key, value);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function clampElev(value) {
  return Math.max(0, Math.min(90, Number(value) || 0));
}

function deriveGroupId(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '');
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid ISO date');
  }
  return date.toISOString();
}

function normalizeAzDeg(value) {
  const wrapped = ((Number(value) % 360) + 360) % 360;
  return wrapped === 360 ? 0 : wrapped;
}

function normalizeMaskEntries(entries) {
  const items = Array.isArray(entries) ? entries : [];
  /** @type {Map<number, number>} */
  const byAz = new Map();

  for (const entry of items) {
    const az = Number(entry?.azDeg);
    const minEl = Number(entry?.minElDeg);

    if (!Number.isFinite(az) || !Number.isFinite(minEl)) {
      throw new Error('Mask entries must contain numeric azDeg and minElDeg');
    }
    if (az < 0 || az > 360) throw new Error('Mask azDeg must be in [0, 360]');
    if (minEl < 0 || minEl > 90) throw new Error('Mask minElDeg must be in [0, 90]');

    byAz.set(normalizeAzDeg(az), clampElev(minEl));
  }

  return Array.from(byAz.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([azDeg, minElDeg]) => ({ azDeg, minElDeg }));
}

function nextMappingId() {
  // Use raw read/write so the seed routine can call this without recursing
  // back into ensureSeeded(). Outside seeding, the seed flag is already
  // set, so behaviour is identical.
  const meta = readRaw(K.meta, { nextMappingId: 1 });
  const id = meta.nextMappingId || 1;
  meta.nextMappingId = id + 1;
  writeRaw(K.meta, meta);
  return id;
}

/**
 * For every satellite in localStorage whose id matches a PRESETS key,
 * realign its identity fields (noradId + the NORAD/intl-designator/epoch
 * portions of the TLE) to whatever the in-memory PRESETS now declares.
 *
 * Why this exists: an early build of the app shipped synthetic placeholder
 * NORAD IDs (99001, 99002, …) which never resolved on CelesTrak — so
 * "Fetch Latest TLE" 404'd for every preset. PRESETS was later corrected
 * to real NORAD IDs, but a returning visitor's localStorage still holds
 * the old placeholders. Same story for the epoch: a stale epoch sends
 * SGP4 numerically unstable. We splice the corrected fields in on every
 * page load so the demo self-heals without forcing the user to clear
 * their storage.
 *
 * What we touch (preserve user edits elsewhere):
 *   - sat.noradId           ← preset.noradId
 *   - tleLine1 cols 2..6    ← preset NORAD (5 chars)
 *   - tleLine1 cols 9..16   ← preset international designator (8 chars)
 *   - tleLine1 cols 18..31  ← fresh epoch (14 chars, regenerated each load)
 *   - tleLine2 cols 2..6    ← preset NORAD (5 chars)
 *
 * Everything else (BSTAR, mean motion derivatives, inclination, RAAN,
 * eccentricity, argument of perigee, mean anomaly, mean motion) is left
 * exactly as the user has it — so editing line 2 manually still sticks.
 */
function refreshPresetIdentity() {
  const satellites = readRaw(K.satellites, []);
  if (!Array.isArray(satellites) || satellites.length === 0) return;

  let changed = false;
  for (const sat of satellites) {
    if (!sat || !sat.id) continue;
    const preset = PRESETS[sat.id];
    if (!preset) continue;

    // (a) noradId
    if (preset.noradId && sat.noradId !== preset.noradId) {
      sat.noradId = preset.noradId;
      changed = true;
    }

    const presetLines = preset.tle.split('\n').map((l) => l.trim());
    const presetLine1 = presetLines.length === 3 ? presetLines[1] : presetLines[0];
    const presetLine2 = presetLines.length === 3 ? presetLines[2] : presetLines[1];

    // (b) tleLine1 NORAD + intl + epoch
    if (
      typeof sat.tleLine1 === 'string' && sat.tleLine1.length >= 32
      && typeof presetLine1 === 'string' && presetLine1.length >= 32
    ) {
      const merged = (
        sat.tleLine1.substring(0, 2)
        + presetLine1.substring(2, 7)         // NORAD (cols 2..6)
        + sat.tleLine1.substring(7, 9)
        + presetLine1.substring(9, 17)        // intl designator (cols 9..16)
        + sat.tleLine1.substring(17, 18)
        + presetLine1.substring(18, 32)       // epoch (cols 18..31)
        + sat.tleLine1.substring(32)
      );
      if (merged !== sat.tleLine1) {
        sat.tleLine1 = merged;
        changed = true;
      }
    }

    // (c) tleLine2 NORAD
    if (
      typeof sat.tleLine2 === 'string' && sat.tleLine2.length >= 7
      && typeof presetLine2 === 'string' && presetLine2.length >= 7
    ) {
      const merged = (
        sat.tleLine2.substring(0, 2)
        + presetLine2.substring(2, 7)         // NORAD (cols 2..6)
        + sat.tleLine2.substring(7)
      );
      if (merged !== sat.tleLine2) {
        sat.tleLine2 = merged;
        changed = true;
      }
    }
  }

  if (changed) writeRaw(K.satellites, satellites);
}

// ─── Seed (idempotent, lazy) ───────────────────────────────────────────────
//
// Mirrors server.js seedDefaults() exactly: groups → satellites → stations →
// antennas → antenna_mappings (cross-product of every antenna × every
// satellite in a schedulable group). Runs at most once per browser tab.
//
// Called lazily from read()/write() so importing this module does NOT touch
// localStorage. That way the REST build (which still imports api-local for
// the build-time switch in api.js) leaves the user's storage alone.

function ensureSeeded() {
  if (_seeded) return;
  _seeded = true; // set first to short-circuit re-entry through read()/write()

  if (readRaw(K.seeded, null) === '1') {
    // Already seeded on a previous visit. Realign the preset-derived
    // satellites' identity fields (noradId + TLE NORAD/intl/epoch) so
    // the demo self-heals after a source-code change without forcing
    // the user to clear their storage. See refreshPresetIdentity() for
    // exactly which fields are touched.
    refreshPresetIdentity();
    refreshPresetTlesFromCelesTrak();
    return;
  }

  // Groups
  const now = nowIso();
  const groups = BUILTIN_GROUPS.map((g) => ({
    id: g.id,
    name: g.name,
    label: g.label,
    color: g.color,
    sortOrder: g.sortOrder,
    schedulable: g.schedulable === true,
    createdAt: now,
    updatedAt: now,
  }));
  writeRaw(K.groups, groups);

  // Satellites from PRESETS
  const satellites = [];
  let idx = 0;
  for (const [id, preset] of Object.entries(PRESETS)) {
    const tleLines = preset.tle.split('\n').map((line) => line.trim());
    const tleLine0 = tleLines.length === 3 ? tleLines[0] : '';
    const tleLine1 = tleLines.length === 3 ? tleLines[1] : tleLines[0];
    const tleLine2 = tleLines.length === 3 ? tleLines[2] : tleLines[1];
    satellites.push({
      id,
      name: preset.name,
      noradId: preset.noradId || null,
      groupName: preset.group || '',
      tleLine0,
      tleLine1,
      tleLine2,
      color: SAT_COLORS[idx % SAT_COLORS.length],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    idx += 1;
  }
  writeRaw(K.satellites, satellites);

  // Stations + antennas
  const stations = [];
  const antennas = [];
  for (const station of DEFAULT_STATIONS) {
    stations.push({
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      minElevDeg: clampElev(station.minElevDeg ?? 5),
    });
    for (const ant of station.antennas || []) {
      antennas.push({
        id: ant.id,
        stationId: station.id,
        name: ant.name || ant.id,
        type: ant.type || '',
      });
    }
  }
  writeRaw(K.stations, stations);
  writeRaw(K.antennas, antennas);

  // Antenna mappings: every antenna × every satellite in a schedulable group
  const schedulableGroupNames = new Set(
    groups.filter((g) => g.schedulable).map((g) => g.name),
  );
  const schedulableSatelliteIds = satellites
    .filter((s) => schedulableGroupNames.has(s.groupName))
    .map((s) => s.id);
  const mappings = [];
  for (const ant of antennas) {
    for (const satId of schedulableSatelliteIds) {
      mappings.push({
        id: nextMappingId(),
        antennaId: ant.id,
        satelliteId: satId,
        role: 'primary',
      });
    }
  }
  writeRaw(K.antennaMappings, mappings);
  writeRaw(K.antennaMasks, {});
  writeRaw(K.passes, []);
  writeRaw(K.settings, {});

  writeRaw(K.seeded, '1');

  // Fire-and-forget: try to replace the placeholder TLE of each preset
  // with the live one from CelesTrak. UI is already populated with the
  // placeholder, so this never blocks the user — it just upgrades the
  // data in the background and the next user-triggered visualization
  // picks it up.
  refreshPresetTlesFromCelesTrak();
}

/**
 * Background refresh of PRESET satellites' TLE data from CelesTrak.
 *
 * Fired once per page load (immediately after ensureSeeded returns)
 * regardless of whether this is a fresh seed or a returning visitor.
 * Failures are swallowed with a console warning so users without
 * internet — or behind a firewall that blocks celestrak.org — still
 * get the placeholder visualization.
 *
 * Each fetch is independent and runs in parallel. Successful results
 * update only the TLE fields (tleLine0/1/2 + updatedAt); the user's
 * color, group membership, enabled flag etc. are preserved.
 */
function refreshPresetTlesFromCelesTrak() {
  const presetEntries = Object.entries(PRESETS).filter(([, p]) => p && p.noradId);
  if (presetEntries.length === 0) return;

  Promise.allSettled(
    presetEntries.map(async ([id, preset]) => {
      const tleText = await fetchLatestTLE(preset.noradId);
      return { id, tleText };
    }),
  ).then((results) => {
    const satellites = readRaw(K.satellites, []);
    if (!Array.isArray(satellites) || satellites.length === 0) return;

    let updated = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { id, tleText } = result.value;
      const sat = satellites.find((s) => s.id === id);
      if (!sat || typeof tleText !== 'string') continue;

      const lines = tleText.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      const tleLine0 = lines.length === 3 ? lines[0] : '';
      const tleLine1 = lines.length === 3 ? lines[1] : lines[0];
      const tleLine2 = lines.length === 3 ? lines[2] : lines[1];

      if (sat.tleLine1 !== tleLine1 || sat.tleLine2 !== tleLine2) {
        sat.tleLine0 = tleLine0;
        sat.tleLine1 = tleLine1;
        sat.tleLine2 = tleLine2;
        sat.updatedAt = nowIso();
        updated += 1;
      }
    }

    if (updated > 0) writeRaw(K.satellites, satellites);

    const failures = results.filter((r) => r.status === 'rejected').length;
    if (failures > 0) {
      // eslint-disable-next-line no-console
      console.info(`[api-local] CelesTrak background refresh: ${updated} updated, ${failures} failed`);
    }
  });
}

// ─── Stations ──────────────────────────────────────────────────────────────

export async function fetchStations() {
  const stations = read(K.stations, []);
  const antennas = read(K.antennas, []);
  const byStation = antennas.reduce((acc, ant) => {
    if (!acc[ant.stationId]) acc[ant.stationId] = [];
    acc[ant.stationId].push({ id: ant.id, name: ant.name, type: ant.type || '' });
    return acc;
  }, {});
  return [...stations]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((station) => ({
      ...station,
      antennas: byStation[station.id] || [],
    }));
}

export async function createStation(data) {
  const id = normalizeText(data?.id);
  const name = normalizeText(data?.name);
  const lat = Number(data?.lat);
  const lon = Number(data?.lon);
  const minElevDeg = Number.isFinite(Number(data?.minElevDeg)) ? Number(data.minElevDeg) : 5;

  if (!id || !name || Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error('id, name, lat, lon are required');
  }

  const stations = read(K.stations, []);
  if (stations.some((s) => s.id === id)) {
    throw new Error('Station already exists');
  }

  const row = { id, name, lat, lon, minElevDeg: clampElev(minElevDeg) };
  stations.push(row);
  write(K.stations, stations);
  return row;
}

export async function updateStation(id, data) {
  const name = normalizeText(data?.name);
  const lat = Number(data?.lat);
  const lon = Number(data?.lon);
  const minElevDeg = Number.isFinite(Number(data?.minElevDeg)) ? Number(data.minElevDeg) : 5;

  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error('name, lat, lon are required');
  }

  const stations = read(K.stations, []);
  const idx = stations.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error('Station not found');

  const row = { id, name, lat, lon, minElevDeg: clampElev(minElevDeg) };
  stations[idx] = row;
  write(K.stations, stations);
  return row;
}

export async function deleteStation(id) {
  const stations = read(K.stations, []);
  if (!stations.some((s) => s.id === id)) throw new Error('Station not found');
  write(K.stations, stations.filter((s) => s.id !== id));

  // Cascade: antennas, masks, mappings (mirrors ON DELETE CASCADE in server.js)
  const antennas = read(K.antennas, []);
  const removedAntennaIds = antennas.filter((a) => a.stationId === id).map((a) => a.id);
  if (removedAntennaIds.length > 0) {
    write(K.antennas, antennas.filter((a) => a.stationId !== id));
    const masks = read(K.antennaMasks, {});
    for (const aId of removedAntennaIds) delete masks[aId];
    write(K.antennaMasks, masks);
    const mappings = read(K.antennaMappings, []);
    write(K.antennaMappings, mappings.filter((m) => !removedAntennaIds.includes(m.antennaId)));
  }
  return null;
}

// ─── Antennas ──────────────────────────────────────────────────────────────

export async function fetchAntennas(stationId) {
  const all = read(K.antennas, []);
  const filtered = stationId ? all.filter((a) => a.stationId === stationId) : all;
  return [...filtered].sort((a, b) => {
    if (a.stationId !== b.stationId) return String(a.stationId).localeCompare(String(b.stationId));
    return String(a.name).localeCompare(String(b.name));
  });
}

export async function createAntenna(data) {
  const id = normalizeText(data?.id);
  const stationId = normalizeText(data?.stationId);
  const name = normalizeText(data?.name);
  const type = normalizeText(data?.type) || '';

  if (!id || !stationId || !name) throw new Error('id, stationId, name are required');

  const stations = read(K.stations, []);
  if (!stations.some((s) => s.id === stationId)) throw new Error('Station not found');

  const antennas = read(K.antennas, []);
  if (antennas.some((a) => a.id === id)) throw new Error('Antenna already exists');

  const row = { id, stationId, name, type };
  antennas.push(row);
  write(K.antennas, antennas);
  return row;
}

export async function updateAntenna(id, data) {
  const stationId = normalizeText(data?.stationId);
  const name = normalizeText(data?.name);
  const type = normalizeText(data?.type) || '';

  if (!stationId || !name) throw new Error('stationId and name are required');

  const antennas = read(K.antennas, []);
  const idx = antennas.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error('Antenna not found');

  const row = { id, stationId, name, type };
  antennas[idx] = row;
  write(K.antennas, antennas);
  return row;
}

export async function deleteAntenna(id) {
  const antennas = read(K.antennas, []);
  if (!antennas.some((a) => a.id === id)) throw new Error('Antenna not found');
  write(K.antennas, antennas.filter((a) => a.id !== id));

  // Cascade
  const masks = read(K.antennaMasks, {});
  delete masks[id];
  write(K.antennaMasks, masks);
  const mappings = read(K.antennaMappings, []);
  write(K.antennaMappings, mappings.filter((m) => m.antennaId !== id));
  return null;
}

// ─── Antenna masks ─────────────────────────────────────────────────────────

export async function fetchAntennaMask(antennaId) {
  const antennas = read(K.antennas, []);
  if (!antennas.some((a) => a.id === antennaId)) throw new Error('Antenna not found');

  const masks = read(K.antennaMasks, {});
  const entries = Array.isArray(masks[antennaId]) ? masks[antennaId] : [];
  return {
    antennaId,
    entries: [...entries].sort((a, b) => a.azDeg - b.azDeg),
  };
}

export async function uploadAntennaMask(antennaId, csvText) {
  const antennas = read(K.antennas, []);
  if (!antennas.some((a) => a.id === antennaId)) throw new Error('Antenna not found');
  if (typeof csvText !== 'string' || !csvText.trim()) throw new Error('csvText is required');

  const entries = normalizeMaskEntries(parseMaskCSV(csvText));
  const masks = read(K.antennaMasks, {});
  masks[antennaId] = entries;
  write(K.antennaMasks, masks);
  return { antennaId, entries };
}

export async function deleteAntennaMask(antennaId) {
  const antennas = read(K.antennas, []);
  if (!antennas.some((a) => a.id === antennaId)) throw new Error('Antenna not found');

  const masks = read(K.antennaMasks, {});
  delete masks[antennaId];
  write(K.antennaMasks, masks);
  return null;
}

// ─── Antenna mappings ──────────────────────────────────────────────────────

export async function fetchMappings() {
  const all = read(K.antennaMappings, []);
  return [...all].sort((a, b) => {
    if (a.antennaId !== b.antennaId) return String(a.antennaId).localeCompare(String(b.antennaId));
    return String(a.satelliteId).localeCompare(String(b.satelliteId));
  });
}

export async function createMapping(data) {
  const antennaId = normalizeText(data?.antennaId);
  const satelliteId = normalizeText(data?.satelliteId);
  const role = normalizeText(data?.role) || 'primary';

  if (!antennaId || !satelliteId) throw new Error('antennaId and satelliteId are required');

  const mappings = read(K.antennaMappings, []);
  const existing = mappings.find((m) => m.antennaId === antennaId && m.satelliteId === satelliteId);
  if (existing) {
    return { id: existing.id, antennaId, satelliteId, role: existing.role || 'primary' };
  }

  const row = { id: nextMappingId(), antennaId, satelliteId, role };
  mappings.push(row);
  write(K.antennaMappings, mappings);
  return row;
}

export async function updateMappingRole(id, role) {
  const next = normalizeText(role);
  if (!next) throw new Error('role is required');

  const mappings = read(K.antennaMappings, []);
  const idx = mappings.findIndex((m) => m.id === id || m.id === Number(id));
  if (idx < 0) throw new Error('Mapping not found');
  mappings[idx] = { ...mappings[idx], role: next };
  write(K.antennaMappings, mappings);
  return { ...mappings[idx] };
}

export async function deleteMapping(id) {
  const mappings = read(K.antennaMappings, []);
  const idx = mappings.findIndex((m) => m.id === id || m.id === Number(id));
  if (idx < 0) throw new Error('Mapping not found');
  mappings.splice(idx, 1);
  write(K.antennaMappings, mappings);
  return null;
}

// ─── Passes ────────────────────────────────────────────────────────────────

export async function fetchPasses(filters = {}) {
  const all = read(K.passes, []);
  return all
    .filter((p) => {
      if (filters.satelliteId && p.satelliteId !== filters.satelliteId) return false;
      if (filters.stationId && p.stationId !== filters.stationId) return false;
      if (filters.status && p.status !== filters.status) return false;
      return true;
    })
    .sort((a, b) => String(a.aos).localeCompare(String(b.aos)));
}

export async function bulkUpsertPasses(passes) {
  const items = Array.isArray(passes) ? passes : [];
  if (items.length === 0) return { upserted: 0 };

  const existing = read(K.passes, []);
  const byId = new Map(existing.map((p) => [p.id, p]));
  for (const pass of items) {
    const row = {
      id: normalizeText(pass?.id),
      satelliteId: normalizeText(pass?.satelliteId),
      stationId: normalizeText(pass?.stationId),
      antennaId: normalizeText(pass?.antennaId) || null,
      aos: toIsoString(pass?.aos),
      los: toIsoString(pass?.los),
      durationSec: Number(pass?.durationSec ?? 0),
      maxElDeg: Number(pass?.maxElDeg ?? 0),
      status: normalizeText(pass?.status) || 'predicted',
      notes: normalizeText(pass?.notes) || '',
    };
    byId.set(row.id, row);
  }
  write(K.passes, Array.from(byId.values()));
  return { upserted: items.length };
}

export async function updatePass(id, data) {
  const all = read(K.passes, []);
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Pass not found');

  const updates = data || {};
  const next = { ...all[idx] };
  let mutated = false;
  if ('status' in updates) { next.status = normalizeText(updates.status) || 'predicted'; mutated = true; }
  if ('aos' in updates) { next.aos = toIsoString(updates.aos); mutated = true; }
  if ('los' in updates) { next.los = toIsoString(updates.los); mutated = true; }
  if ('antennaId' in updates) { next.antennaId = normalizeText(updates.antennaId) || null; mutated = true; }
  if ('notes' in updates) { next.notes = normalizeText(updates.notes) || ''; mutated = true; }
  if (!mutated) throw new Error('No fields to update');

  all[idx] = next;
  write(K.passes, all);
  return next;
}

// ─── Groups ────────────────────────────────────────────────────────────────

export async function fetchGroups() {
  const all = read(K.groups, []);
  return [...all].sort((a, b) => {
    if ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0)) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    return String(a.name).localeCompare(String(b.name));
  });
}

export async function createGroup(data) {
  const name = normalizeText(data?.name);
  const label = normalizeText(data?.label);
  const id = normalizeText(data?.id) || deriveGroupId(name);
  const color = normalizeText(data?.color) || '';
  const sortOrder = Number.isFinite(Number(data?.sortOrder)) ? Number(data.sortOrder) : 0;
  const schedulable = data?.schedulable !== false;

  if (!name || !label || !id) throw new Error('name and label are required');

  const groups = read(K.groups, []);
  if (groups.some((g) => g.id === id || g.name === name)) {
    throw new Error('Group already exists');
  }

  const now = nowIso();
  const row = {
    id,
    name,
    label,
    color,
    sortOrder,
    schedulable,
    createdAt: now,
    updatedAt: now,
  };
  groups.push(row);
  write(K.groups, groups);
  return row;
}

export async function updateGroup(id, data) {
  const groups = read(K.groups, []);
  const idx = groups.findIndex((g) => g.id === id);
  if (idx < 0) throw new Error('Group not found');

  const current = groups[idx];
  const updates = data || {};
  const has = (key) => key in updates;

  if (!has('name') && !has('label') && !has('color') && !has('sortOrder') && !has('schedulable')) {
    throw new Error('No fields to update');
  }

  const name = has('name') ? normalizeText(updates.name) : current.name;
  const label = has('label') ? normalizeText(updates.label) : current.label;
  const color = has('color') ? (normalizeText(updates.color) || '') : (current.color || '');
  const sortOrder = has('sortOrder')
    ? (Number.isFinite(Number(updates.sortOrder)) ? Number(updates.sortOrder) : NaN)
    : current.sortOrder;
  const schedulable = has('schedulable') ? updates.schedulable !== false : current.schedulable;

  if (!name || !label) throw new Error('name and label cannot be empty');
  if (Number.isNaN(sortOrder)) throw new Error('sortOrder must be a number');

  if (
    name === current.name
    && label === current.label
    && color === (current.color || '')
    && sortOrder === current.sortOrder
    && schedulable === current.schedulable
  ) {
    throw new Error('No fields to update');
  }

  if (name !== current.name && groups.some((g, i) => i !== idx && g.name === name)) {
    throw new Error('Group already exists');
  }

  const row = { ...current, name, label, color, sortOrder, schedulable, updatedAt: nowIso() };
  groups[idx] = row;
  write(K.groups, groups);

  // Rename: cascade to satellites referencing the old group_name (mirrors server.js)
  if (name !== current.name) {
    const satellites = read(K.satellites, []);
    const next = satellites.map((s) => (
      s.groupName === current.name ? { ...s, groupName: name } : s
    ));
    write(K.satellites, next);
  }
  return row;
}

export async function deleteGroup(id) {
  const groups = read(K.groups, []);
  const target = groups.find((g) => g.id === id);
  if (!target) throw new Error('Group not found');

  const satellites = read(K.satellites, []);
  const memberCount = satellites.filter((s) => s.groupName === target.name).length;

  if (id === 'custom' && memberCount > 0) {
    const err = new Error('Cannot delete the "custom" group while it contains satellites. Reassign them first.');
    err.memberCount = memberCount;
    throw err;
  }

  // Ensure a "custom" group exists so orphaned satellites have somewhere to land.
  const nextGroups = groups.filter((g) => g.id !== id);
  if (!nextGroups.some((g) => g.id === 'custom')) {
    const now = nowIso();
    nextGroups.push({
      id: 'custom',
      name: 'custom',
      label: 'Custom',
      color: '',
      sortOrder: 100,
      schedulable: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  const nextSatellites = satellites.map((s) => (
    s.groupName === target.name ? { ...s, groupName: 'custom' } : s
  ));

  write(K.groups, nextGroups);
  write(K.satellites, nextSatellites);
  return {
    deletedId: id,
    reassignedSatellites: memberCount,
    reassignedTo: 'custom',
  };
}

// ─── Satellites ────────────────────────────────────────────────────────────

export async function fetchSatellites() {
  const all = read(K.satellites, []);
  return [...all].sort((a, b) => {
    const ga = String(a.groupName || '');
    const gb = String(b.groupName || '');
    if (ga !== gb) return ga.localeCompare(gb);
    return String(a.name).localeCompare(String(b.name));
  });
}

export async function createSatellite(data) {
  const id = normalizeText(data?.id);
  const name = normalizeText(data?.name);
  const noradId = Number.isFinite(Number(data?.noradId)) ? Number(data.noradId) : null;
  const groupName = normalizeText(data?.groupName) || '';
  const tleLine0 = normalizeText(data?.tleLine0) || '';
  const tleLine1 = normalizeText(data?.tleLine1);
  const tleLine2 = normalizeText(data?.tleLine2);
  const color = normalizeText(data?.color) || '';
  const enabled = data?.enabled !== false;

  if (!id || !name || !tleLine1 || !tleLine2) {
    throw new Error('id, name, tleLine1, tleLine2 are required');
  }

  const satellites = read(K.satellites, []);
  if (satellites.some((s) => s.id === id)) throw new Error('Satellite already exists');

  const now = nowIso();
  const row = {
    id,
    name,
    noradId,
    groupName,
    tleLine0,
    tleLine1,
    tleLine2,
    color,
    enabled,
    createdAt: now,
    updatedAt: now,
  };
  satellites.push(row);
  write(K.satellites, satellites);
  return row;
}

export async function updateSatellite(id, data) {
  const name = normalizeText(data?.name);
  const noradId = Number.isFinite(Number(data?.noradId)) ? Number(data.noradId) : null;
  const groupName = normalizeText(data?.groupName) || '';
  const tleLine0 = normalizeText(data?.tleLine0) || '';
  const tleLine1 = normalizeText(data?.tleLine1);
  const tleLine2 = normalizeText(data?.tleLine2);
  const color = normalizeText(data?.color) || '';
  const enabled = data?.enabled !== false;

  if (!name || !tleLine1 || !tleLine2) {
    throw new Error('name, tleLine1, tleLine2 are required');
  }

  const satellites = read(K.satellites, []);
  const idx = satellites.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error('Satellite not found');

  const now = nowIso();
  const row = {
    ...satellites[idx],
    id,
    name,
    noradId,
    groupName,
    tleLine0,
    tleLine1,
    tleLine2,
    color,
    enabled,
    updatedAt: now,
  };
  satellites[idx] = row;
  write(K.satellites, satellites);
  return row;
}

export async function deleteSatellite(id) {
  const satellites = read(K.satellites, []);
  if (!satellites.some((s) => s.id === id)) throw new Error('Satellite not found');
  write(K.satellites, satellites.filter((s) => s.id !== id));
  // Clean up mappings referencing this satellite (mirrors server.js)
  const mappings = read(K.antennaMappings, []);
  write(K.antennaMappings, mappings.filter((m) => m.satelliteId !== id));
  return null;
}

// ─── Settings ──────────────────────────────────────────────────────────────

export async function getSetting(key) {
  const all = read(K.settings, {});
  if (!(key in all)) return {};
  const value = all[key];
  return value == null ? {} : value;
}

export async function putSetting(key, value) {
  const all = read(K.settings, {});
  all[key] = value;
  write(K.settings, all);
  return { ok: true };
}
