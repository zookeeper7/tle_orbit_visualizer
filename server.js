import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';

import { DEFAULT_STATIONS } from './src/ground-stations.js';
import { PRESETS } from './src/presets.js';
import { parseMaskCSV } from './src/core/azimuth-mask.js';
import { ommToTLE } from './src/gp.js';

const PORT = 3001;
const DB_DIR = path.resolve('data');
const DB_PATH = path.join(DB_DIR, 'schedule.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const SAT_COLORS = [
  '#7dd3fc', '#fbbf24', '#fb7185', '#34d399', '#a78bfa',
  '#f97316', '#38bdf8', '#f472b6', '#4ade80', '#c084fc',
  '#fb923c', '#22d3ee', '#e879f9', '#a3e635', '#fca5a5',
  '#67e8f9', '#d946ef', '#bef264',
];

const BUILTIN_GROUPS = [
  { id: 'general', name: 'general', label: 'General', color: '#94a3b8', sortOrder: 10, schedulable: 1 },
  { id: 'sentinel', name: 'sentinel', label: 'Sentinel', color: '#34d399', sortOrder: 20, schedulable: 1 },
];

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

initSchema();
seedDefaults();

const app = express();

app.use(cors({ origin: ['http://localhost:5173'] }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/stations', (_req, res) => {
  const stations = db.prepare(`
    SELECT id, name, lat, lon, min_elev_deg
    FROM stations
    ORDER BY name
  `).all();

  const antennas = db.prepare(`
    SELECT id, station_id, name, type
    FROM antennas
    ORDER BY station_id, name
  `).all();

  const antennasByStationId = antennas.reduce((acc, antenna) => {
    if (!acc[antenna.station_id]) acc[antenna.station_id] = [];
    acc[antenna.station_id].push({
      id: antenna.id,
      name: antenna.name,
      type: antenna.type || '',
    });
    return acc;
  }, {});

  res.json(stations.map((station) => ({
    id: station.id,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    minElevDeg: station.min_elev_deg,
    antennas: antennasByStationId[station.id] || [],
  })));
});

app.post('/api/stations', (req, res) => {
  const id = normalizeText(req.body?.id);
  const name = normalizeText(req.body?.name);
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  const minElevDeg = Number.isFinite(Number(req.body?.minElevDeg)) ? Number(req.body.minElevDeg) : 5;

  if (!id || !name || Number.isNaN(lat) || Number.isNaN(lon)) {
    res.status(400).json({ error: 'id, name, lat, lon are required' });
    return;
  }

  try {
    db.prepare(`
      INSERT INTO stations (id, name, lat, lon, min_elev_deg)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, lat, lon, clampElev(minElevDeg));

    res.status(201).json({ id, name, lat, lon, minElevDeg: clampElev(minElevDeg) });
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.put('/api/stations/:id', (req, res) => {
  const id = req.params.id;
  const name = normalizeText(req.body?.name);
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  const minElevDeg = Number.isFinite(Number(req.body?.minElevDeg)) ? Number(req.body.minElevDeg) : 5;

  if (!name || Number.isNaN(lat) || Number.isNaN(lon)) {
    res.status(400).json({ error: 'name, lat, lon are required' });
    return;
  }

  const result = db.prepare(`
    UPDATE stations
    SET name = ?, lat = ?, lon = ?, min_elev_deg = ?
    WHERE id = ?
  `).run(name, lat, lon, clampElev(minElevDeg), id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Station not found' });
    return;
  }

  res.json({ id, name, lat, lon, minElevDeg: clampElev(minElevDeg) });
});

app.delete('/api/stations/:id', (req, res) => {
  const result = db.prepare('DELETE FROM stations WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Station not found' });
    return;
  }
  res.status(204).end();
});

app.get('/api/antennas', (req, res) => {
  const stationId = normalizeText(req.query.stationId);
  const rows = stationId
    ? db.prepare(`SELECT id, station_id, name, type FROM antennas WHERE station_id = ? ORDER BY name`).all(stationId)
    : db.prepare(`SELECT id, station_id, name, type FROM antennas ORDER BY station_id, name`).all();

  res.json(rows.map((row) => ({
    id: row.id,
    stationId: row.station_id,
    name: row.name,
    type: row.type || '',
  })));
});

app.post('/api/antennas', (req, res) => {
  const id = normalizeText(req.body?.id);
  const stationId = normalizeText(req.body?.stationId);
  const name = normalizeText(req.body?.name);
  const type = normalizeText(req.body?.type) || '';

  if (!id || !stationId || !name) {
    res.status(400).json({ error: 'id, stationId, name are required' });
    return;
  }

  try {
    db.prepare(`
      INSERT INTO antennas (id, station_id, name, type)
      VALUES (?, ?, ?, ?)
    `).run(id, stationId, name, type);

    res.status(201).json({ id, stationId, name, type });
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.put('/api/antennas/:id', (req, res) => {
  const id = req.params.id;
  const stationId = normalizeText(req.body?.stationId);
  const name = normalizeText(req.body?.name);
  const type = normalizeText(req.body?.type) || '';

  if (!stationId || !name) {
    res.status(400).json({ error: 'stationId and name are required' });
    return;
  }

  const result = db.prepare(`
    UPDATE antennas
    SET station_id = ?, name = ?, type = ?
    WHERE id = ?
  `).run(stationId, name, type, id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Antenna not found' });
    return;
  }

  res.json({ id, stationId, name, type });
});

app.delete('/api/antennas/:id', (req, res) => {
  const result = db.prepare('DELETE FROM antennas WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Antenna not found' });
    return;
  }
  res.status(204).end();
});

app.get('/api/antennas/:id/mask', (req, res) => {
  const antennaId = normalizeText(req.params.id);
  if (!antennaExists(antennaId)) {
    res.status(404).json({ error: 'Antenna not found' });
    return;
  }

  const rows = db.prepare(`
    SELECT az_deg, min_el_deg
    FROM antenna_masks
    WHERE antenna_id = ?
    ORDER BY az_deg
  `).all(antennaId);

  res.json({
    antennaId,
    entries: rows.map((row) => ({
      azDeg: row.az_deg,
      minElDeg: row.min_el_deg,
    })),
  });
});

app.put('/api/antennas/:id/mask', (req, res) => {
  const antennaId = normalizeText(req.params.id);
  if (!antennaExists(antennaId)) {
    res.status(404).json({ error: 'Antenna not found' });
    return;
  }

  try {
    const entries = normalizeMaskEntries(req.body?.entries);
    replaceAntennaMaskEntries(antennaId, entries);
    res.json({ antennaId, entries });
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.delete('/api/antennas/:id/mask', (req, res) => {
  const antennaId = normalizeText(req.params.id);
  if (!antennaExists(antennaId)) {
    res.status(404).json({ error: 'Antenna not found' });
    return;
  }

  db.prepare('DELETE FROM antenna_masks WHERE antenna_id = ?').run(antennaId);
  res.status(204).end();
});

app.post('/api/antennas/:id/mask/csv', (req, res) => {
  const antennaId = normalizeText(req.params.id);
  if (!antennaExists(antennaId)) {
    res.status(404).json({ error: 'Antenna not found' });
    return;
  }

  const csvText = typeof req.body?.csvText === 'string' ? req.body.csvText : '';
  if (!csvText.trim()) {
    res.status(400).json({ error: 'csvText is required' });
    return;
  }

  try {
    const entries = normalizeMaskEntries(parseMaskCSV(csvText));
    replaceAntennaMaskEntries(antennaId, entries);
    res.status(201).json({ antennaId, entries });
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.get('/api/antenna-mappings', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, antenna_id, satellite_id, role
    FROM antenna_mappings
    ORDER BY antenna_id, satellite_id
  `).all();

  res.json(rows.map((row) => ({
    id: row.id,
    antennaId: row.antenna_id,
    satelliteId: row.satellite_id,
    role: row.role || 'primary',
  })));
});

app.post('/api/antenna-mappings', (req, res) => {
  const antennaId = normalizeText(req.body?.antennaId);
  const satelliteId = normalizeText(req.body?.satelliteId);
  const role = normalizeText(req.body?.role) || 'primary';
  if (!antennaId || !satelliteId) {
    res.status(400).json({ error: 'antennaId and satelliteId are required' });
    return;
  }

  const existing = db.prepare(`
    SELECT id, role FROM antenna_mappings WHERE antenna_id = ? AND satellite_id = ?
  `).get(antennaId, satelliteId);

  if (existing) {
    res.status(200).json({ id: existing.id, antennaId, satelliteId, role: existing.role || 'primary' });
    return;
  }

  try {
    const result = db.prepare(`
      INSERT INTO antenna_mappings (antenna_id, satellite_id, role)
      VALUES (?, ?, ?)
    `).run(antennaId, satelliteId, role);
    res.status(201).json({ id: result.lastInsertRowid, antennaId, satelliteId, role });
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.patch('/api/antenna-mappings/:id', (req, res) => {
  const id = req.params.id;
  const role = normalizeText(req.body?.role);
  if (!role) {
    res.status(400).json({ error: 'role is required' });
    return;
  }

  const result = db.prepare('UPDATE antenna_mappings SET role = ? WHERE id = ?').run(role, id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  const row = db.prepare('SELECT id, antenna_id, satellite_id, role FROM antenna_mappings WHERE id = ?').get(id);
  res.json({ id: row.id, antennaId: row.antenna_id, satelliteId: row.satellite_id, role: row.role || 'primary' });
});

app.delete('/api/antenna-mappings/:id', (req, res) => {
  const result = db.prepare('DELETE FROM antenna_mappings WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }
  res.status(204).end();
});

app.get('/api/passes', (req, res) => {
  const conditions = [];
  const values = [];
  const { satelliteId, stationId, status } = req.query;

  if (satelliteId) {
    conditions.push('satellite_id = ?');
    values.push(String(satelliteId));
  }
  if (stationId) {
    conditions.push('station_id = ?');
    values.push(String(stationId));
  }
  if (status) {
    conditions.push('status = ?');
    values.push(String(status));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT id, satellite_id, station_id, antenna_id, aos, los, duration_sec, max_el_deg, status, notes
    FROM passes
    ${where}
    ORDER BY aos
  `).all(...values);

  res.json(rows.map((row) => ({
    id: row.id,
    satelliteId: row.satellite_id,
    stationId: row.station_id,
    antennaId: row.antenna_id,
    aos: row.aos,
    los: row.los,
    durationSec: row.duration_sec,
    maxElDeg: row.max_el_deg,
    status: row.status,
    notes: row.notes || '',
  })));
});

app.post('/api/passes/bulk', (req, res) => {
  const items = Array.isArray(req.body?.passes) ? req.body.passes : [];
  if (items.length === 0) {
    res.json({ upserted: 0 });
    return;
  }

  const upsert = db.prepare(`
    INSERT INTO passes (id, satellite_id, station_id, antenna_id, aos, los, duration_sec, max_el_deg, status, notes)
    VALUES (@id, @satelliteId, @stationId, @antennaId, @aos, @los, @durationSec, @maxElDeg, @status, @notes)
    ON CONFLICT(id) DO UPDATE SET
      satellite_id = excluded.satellite_id,
      station_id = excluded.station_id,
      antenna_id = excluded.antenna_id,
      aos = excluded.aos,
      los = excluded.los,
      duration_sec = excluded.duration_sec,
      max_el_deg = excluded.max_el_deg,
      status = excluded.status,
      notes = excluded.notes
  `);

  const txn = db.transaction((rows) => {
    for (const row of rows) upsert.run(row);
  });

  try {
    txn(items.map((pass) => ({
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
    })));
    res.json({ upserted: items.length });
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.patch('/api/passes/:id', (req, res) => {
  const updates = [];
  const values = [];

  if ('status' in req.body) {
    updates.push('status = ?');
    values.push(normalizeText(req.body.status) || 'predicted');
  }
  if ('aos' in req.body) {
    updates.push('aos = ?');
    values.push(toIsoString(req.body.aos));
  }
  if ('los' in req.body) {
    updates.push('los = ?');
    values.push(toIsoString(req.body.los));
  }
  if ('antennaId' in req.body) {
    updates.push('antenna_id = ?');
    values.push(normalizeText(req.body.antennaId) || null);
  }
  if ('notes' in req.body) {
    updates.push('notes = ?');
    values.push(normalizeText(req.body.notes) || '');
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  values.push(req.params.id);
  const result = db.prepare(`UPDATE passes SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Pass not found' });
    return;
  }

  const row = db.prepare(`
    SELECT id, satellite_id, station_id, antenna_id, aos, los, duration_sec, max_el_deg, status, notes
    FROM passes
    WHERE id = ?
  `).get(req.params.id);

  res.json({
    id: row.id,
    satelliteId: row.satellite_id,
    stationId: row.station_id,
    antennaId: row.antenna_id,
    aos: row.aos,
    los: row.los,
    durationSec: row.duration_sec,
    maxElDeg: row.max_el_deg,
    status: row.status,
    notes: row.notes || '',
  });
});

// ─── Groups (CRUD) ───

app.get('/api/groups', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, name, label, color, sort_order, schedulable, created_at, updated_at
    FROM groups
    ORDER BY sort_order, name
  `).all();
  res.json(rows.map(mapGroupRow));
});

app.post('/api/groups', (req, res) => {
  const name = normalizeText(req.body?.name);
  const label = normalizeText(req.body?.label);
  const id = normalizeText(req.body?.id) || deriveGroupId(name);
  const color = normalizeText(req.body?.color) || '';
  const sortOrder = Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 0;
  const schedulable = req.body?.schedulable !== false ? 1 : 0;
  const now = new Date().toISOString();

  if (!name || !label || !id) {
    res.status(400).json({ error: 'name and label are required' });
    return;
  }

  try {
    db.prepare(`
      INSERT INTO groups (id, name, label, color, sort_order, schedulable, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, label, color, sortOrder, schedulable, now, now);

    res.status(201).json({
      id,
      name,
      label,
      color,
      sortOrder,
      schedulable: Boolean(schedulable),
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (isSqliteConstraintError(error)) {
      res.status(409).json({ error: 'Group already exists' });
      return;
    }
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.put('/api/groups/:id', (req, res) => {
  const id = req.params.id;
  const current = db.prepare(`
    SELECT id, name, label, color, sort_order, schedulable, created_at, updated_at
    FROM groups
    WHERE id = ?
  `).get(id);

  if (!current) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (
    !('name' in req.body)
    && !('label' in req.body)
    && !('color' in req.body)
    && !('sortOrder' in req.body)
    && !('schedulable' in req.body)
  ) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const name = 'name' in req.body ? normalizeText(req.body.name) : current.name;
  const label = 'label' in req.body ? normalizeText(req.body.label) : current.label;
  const color = 'color' in req.body ? normalizeText(req.body.color) : (current.color || '');
  const sortOrder = 'sortOrder' in req.body
    ? (Number.isFinite(Number(req.body.sortOrder)) ? Number(req.body.sortOrder) : NaN)
    : current.sort_order;
  const schedulable = 'schedulable' in req.body
    ? (req.body.schedulable !== false ? 1 : 0)
    : current.schedulable;

  if (!name || !label) {
    res.status(400).json({ error: 'name and label cannot be empty' });
    return;
  }
  if (Number.isNaN(sortOrder)) {
    res.status(400).json({ error: 'sortOrder must be a number' });
    return;
  }

  if (
    name === current.name
    && label === current.label
    && color === (current.color || '')
    && sortOrder === current.sort_order
    && schedulable === current.schedulable
  ) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const now = new Date().toISOString();

  try {
    if (name !== current.name) {
      db.transaction(() => {
        const conflict = db.prepare('SELECT id FROM groups WHERE name = ? AND id != ?').get(name, id);
        if (conflict) {
          const err = new Error('Group already exists');
          err.statusCode = 409;
          throw err;
        }

        db.prepare(`
          UPDATE groups
          SET name = ?, label = ?, color = ?, sort_order = ?, schedulable = ?, updated_at = ?
          WHERE id = ?
        `).run(name, label, color, sortOrder, schedulable, now, id);

        db.prepare(`
          UPDATE satellites
          SET group_name = ?
          WHERE group_name = ?
        `).run(name, current.name);
      })();
    } else {
      db.prepare(`
        UPDATE groups
        SET name = ?, label = ?, color = ?, sort_order = ?, schedulable = ?, updated_at = ?
        WHERE id = ?
      `).run(name, label, color, sortOrder, schedulable, now, id);
    }

    const updated = db.prepare(`
      SELECT id, name, label, color, sort_order, schedulable, created_at, updated_at
      FROM groups
      WHERE id = ?
    `).get(id);
    res.json(mapGroupRow(updated));
  } catch (error) {
    if (error?.statusCode === 409 || isSqliteConstraintError(error)) {
      res.status(409).json({ error: 'Group already exists' });
      return;
    }
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.delete('/api/groups/:id', (req, res) => {
  try {
    const result = db.transaction((id) => {
      const group = db.prepare('SELECT id, name FROM groups WHERE id = ?').get(id);
      if (!group) {
        const err = new Error('Group not found');
        err.statusCode = 404;
        throw err;
      }

      const memberCount = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM satellites
        WHERE group_name = ?
      `).get(group.name).cnt;

      if (id === 'custom' && memberCount > 0) {
        const err = new Error('Cannot delete custom group');
        err.statusCode = 409;
        err.payload = {
          error: 'Cannot delete the "custom" group while it contains satellites. Reassign them first.',
          memberCount,
        };
        throw err;
      }

      ensureCustomGroup();
      db.prepare(`
        UPDATE satellites
        SET group_name = 'custom'
        WHERE group_name = ?
      `).run(group.name);
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);

      return {
        deletedId: id,
        reassignedSatellites: memberCount,
        reassignedTo: 'custom',
      };
    })(req.params.id);

    res.json(result);
  } catch (error) {
    if (error?.statusCode) {
      res.status(error.statusCode).json(error.payload || { error: toErrorMessage(error) });
      return;
    }
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

// ─── Satellites (CRUD) ───

app.get('/api/satellites', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, name, norad_id, group_name, tle_line0, tle_line1, tle_line2, color, enabled, created_at, updated_at
    FROM satellites
    ORDER BY group_name, name
  `).all();

  res.json(rows.map((row) => ({
    id: row.id,
    name: row.name,
    noradId: row.norad_id,
    groupName: row.group_name || '',
    tleLine0: row.tle_line0 || '',
    tleLine1: row.tle_line1,
    tleLine2: row.tle_line2,
    color: row.color || '',
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })));
});

app.post('/api/satellites', (req, res) => {
  const id = normalizeText(req.body?.id);
  const name = normalizeText(req.body?.name);
  const noradId = Number.isFinite(Number(req.body?.noradId)) ? Number(req.body.noradId) : null;
  const groupName = normalizeText(req.body?.groupName) || '';
  const tleLine0 = normalizeText(req.body?.tleLine0) || '';
  const tleLine1 = normalizeText(req.body?.tleLine1);
  const tleLine2 = normalizeText(req.body?.tleLine2);
  const color = normalizeText(req.body?.color) || '';
  const enabled = req.body?.enabled !== false ? 1 : 0;
  const now = new Date().toISOString();

  if (!id || !name || !tleLine1 || !tleLine2) {
    res.status(400).json({ error: 'id, name, tleLine1, tleLine2 are required' });
    return;
  }

  try {
    db.prepare(`
      INSERT INTO satellites (id, name, norad_id, group_name, tle_line0, tle_line1, tle_line2, color, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, noradId, groupName, tleLine0, tleLine1, tleLine2, color, enabled, now, now);

    res.status(201).json({ id, name, noradId, groupName, tleLine0, tleLine1, tleLine2, color, enabled: Boolean(enabled), createdAt: now, updatedAt: now });
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.put('/api/satellites/:id', (req, res) => {
  const id = req.params.id;
  const name = normalizeText(req.body?.name);
  const noradId = Number.isFinite(Number(req.body?.noradId)) ? Number(req.body.noradId) : null;
  const groupName = normalizeText(req.body?.groupName) || '';
  const tleLine0 = normalizeText(req.body?.tleLine0) || '';
  const tleLine1 = normalizeText(req.body?.tleLine1);
  const tleLine2 = normalizeText(req.body?.tleLine2);
  const color = normalizeText(req.body?.color) || '';
  const enabled = req.body?.enabled !== false ? 1 : 0;
  const now = new Date().toISOString();

  if (!name || !tleLine1 || !tleLine2) {
    res.status(400).json({ error: 'name, tleLine1, tleLine2 are required' });
    return;
  }

  const result = db.prepare(`
    UPDATE satellites
    SET name = ?, norad_id = ?, group_name = ?, tle_line0 = ?, tle_line1 = ?, tle_line2 = ?, color = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(name, noradId, groupName, tleLine0, tleLine1, tleLine2, color, enabled, now, id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Satellite not found' });
    return;
  }

  res.json({ id, name, noradId, groupName, tleLine0, tleLine1, tleLine2, color, enabled: Boolean(enabled), updatedAt: now });
});

app.delete('/api/satellites/:id', (req, res) => {
  const result = db.prepare('DELETE FROM satellites WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Satellite not found' });
    return;
  }
  // Clean up antenna mappings referencing this satellite
  db.prepare('DELETE FROM antenna_mappings WHERE satellite_id = ?').run(req.params.id);
  res.status(204).end();
});

// ─── Settings (key-value store) ───

app.get('/api/settings/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(req.params.key);
  if (!row) return res.json({});
  res.json(safeParseJson(row.value) || {});
});

app.put('/api/settings/:key', (req, res) => {
  const key = req.params.key;
  const value = JSON.stringify(req.body);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  console.log(`SQLite DB: ${DB_PATH}`);
});

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      min_elev_deg REAL DEFAULT 5
    );

    CREATE TABLE IF NOT EXISTS antennas (
      id TEXT PRIMARY KEY,
      station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS antenna_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      antenna_id TEXT NOT NULL REFERENCES antennas(id) ON DELETE CASCADE,
      satellite_id TEXT NOT NULL,
      role TEXT DEFAULT 'primary'
    );

    CREATE TABLE IF NOT EXISTS antenna_masks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      antenna_id TEXT NOT NULL REFERENCES antennas(id) ON DELETE CASCADE,
      az_deg REAL NOT NULL,
      min_el_deg REAL NOT NULL,
      UNIQUE(antenna_id, az_deg)
    );

    CREATE TABLE IF NOT EXISTS passes (
      id TEXT PRIMARY KEY,
      satellite_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      antenna_id TEXT,
      aos TEXT NOT NULL,
      los TEXT NOT NULL,
      duration_sec REAL,
      max_el_deg REAL,
      status TEXT DEFAULT 'predicted',
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      color TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      schedulable INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS satellites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      norad_id INTEGER,
      group_name TEXT DEFAULT '',
      tle_line0 TEXT DEFAULT '',
      tle_line1 TEXT NOT NULL,
      tle_line2 TEXT NOT NULL,
      color TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Migration: add role column to antenna_mappings if missing
  const mappingCols = db.prepare("PRAGMA table_info('antenna_mappings')").all().map(c => c.name);
  if (!mappingCols.includes('role')) {
    db.exec("ALTER TABLE antenna_mappings ADD COLUMN role TEXT DEFAULT 'primary'");
  }
}

function seedDefaults() {
  seedGroupsIfEmpty();

  // Seed satellites from PRESETS if table is empty
  const satCount = db.prepare('SELECT COUNT(*) AS cnt FROM satellites').get().cnt;
  if (satCount === 0) {
    const insertSat = db.prepare(`
      INSERT INTO satellites (id, name, norad_id, group_name, tle_line0, tle_line1, tle_line2, color, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    const satTxn = db.transaction(() => {
      let idx = 0;
      for (const [id, preset] of Object.entries(PRESETS)) {
        const tleLines = preset.tle.split('\n').map(l => l.trim());
        const line0 = tleLines.length === 3 ? tleLines[0] : '';
        const line1 = tleLines.length === 3 ? tleLines[1] : tleLines[0];
        const line2 = tleLines.length === 3 ? tleLines[2] : tleLines[1];
        insertSat.run(
          id, preset.name, preset.noradId || null, preset.group || '',
          line0, line1, line2,
          SAT_COLORS[idx % SAT_COLORS.length],
          1, now, now,
        );
        idx++;
      }
    });
    satTxn();
  }

  // Fire-and-forget: try to upgrade every preset's TLE with the live one
  // from CelesTrak. The placeholder values are already in the table so
  // the API is fully usable immediately; this just refreshes the data
  // in the background. Runs on every server start so a long-lived
  // deployment stays current.
  refreshPresetTlesFromCelesTrak();

  // Seed stations if table is empty
  const stationCount = db.prepare('SELECT COUNT(*) AS cnt FROM stations').get().cnt;
  if (stationCount > 0) return;

  const insertStation = db.prepare(`
    INSERT INTO stations (id, name, lat, lon, min_elev_deg)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertAntenna = db.prepare(`
    INSERT INTO antennas (id, station_id, name, type)
    VALUES (?, ?, ?, ?)
  `);

  const koreanSatelliteIds = db.prepare(`
    SELECT s.id
    FROM satellites s
    INNER JOIN groups g ON g.name = s.group_name
    WHERE g.schedulable = 1
  `).all().map(r => r.id);

  const seedTxn = db.transaction(() => {
    for (const station of DEFAULT_STATIONS) {
      insertStation.run(
        station.id,
        station.name,
        station.lat,
        station.lon,
        clampElev(station.minElevDeg ?? 5),
      );

      for (const antenna of station.antennas || []) {
        insertAntenna.run(
          antenna.id,
          station.id,
          antenna.name || antenna.id,
          antenna.type || '',
        );
      }
    }

    const mappingCount = db.prepare('SELECT COUNT(*) AS cnt FROM antenna_mappings').get().cnt;
    if (mappingCount === 0) {
      const antennaIds = db.prepare('SELECT id FROM antennas').all().map((row) => row.id);
      const insertMapping = db.prepare('INSERT INTO antenna_mappings (antenna_id, satellite_id) VALUES (?, ?)');
      for (const antennaId of antennaIds) {
        for (const satelliteId of koreanSatelliteIds) {
          insertMapping.run(antennaId, satelliteId);
        }
      }
    }
  });

  seedTxn();
}

/**
 * Background refresh of every PRESET satellite's TLE from CelesTrak.
 *
 * Runs on every server start, NOT just on the first seed — that way a
 * long-lived production deployment stays current even when the user
 * never clicks "Fetch All TLEs" in the UI. Failures are swallowed
 * (logged) so an offline server still serves the placeholder data.
 *
 * Uses Node's native fetch (Node 18+). All 11 PRESET requests fire in
 * parallel; CelesTrak handles the small burst without complaint.
 */
async function refreshPresetTlesFromCelesTrak() {
  const presetEntries = Object.entries(PRESETS).filter(([, p]) => p && p.noradId);
  if (presetEntries.length === 0) return;

  // Respect CelesTrak's ~2h GP update cadence: skip re-fetching if we already
  // refreshed under 2h ago. Without this, frequent restarts would re-download
  // the same data and risk CelesTrak's rate-limit/firewall policy.
  const REFRESH_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'lastPresetRefresh'").get();
    const lastAt = row ? Number(safeParseJson(row.value)?.at) : 0;
    if (Number.isFinite(lastAt) && lastAt > 0 && Date.now() - lastAt < REFRESH_MIN_INTERVAL_MS) {
      console.log('[seed] CelesTrak refresh skipped (GP data < 2h old)');
      return;
    }
  } catch { /* proceed on any read error */ }

  const updateStmt = db.prepare(`
    UPDATE satellites
    SET tle_line0 = ?, tle_line1 = ?, tle_line2 = ?, updated_at = ?
    WHERE id = ?
  `);

  const results = await Promise.allSettled(
    presetEntries.map(async ([id, preset]) => {
      const tleText = await fetchTleFromCelesTrak(preset.noradId);
      return { id, tleText };
    }),
  );

  let updated = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();
  for (const result of results) {
    if (result.status !== 'fulfilled') { failed += 1; continue; }
    const { id, tleText } = result.value;
    const lines = tleText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) { failed += 1; continue; }
    const line0 = lines.length === 3 ? lines[0] : '';
    const line1 = lines.length === 3 ? lines[1] : lines[0];
    const line2 = lines.length === 3 ? lines[2] : lines[1];
    try {
      const r = updateStmt.run(line0, line1, line2, nowIso, id);
      if (r.changes > 0) updated += 1;
    } catch (_) {
      failed += 1;
    }
  }

  // Stamp the refresh time so the 2h guard above can throttle future restarts.
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('lastPresetRefresh', JSON.stringify({ at: Date.now() }));
  } catch { /* non-fatal */ }

  console.log(`[seed] CelesTrak background refresh: ${updated} updated, ${failed} failed`);
}

/**
 * Fetch one satellite's GP data as an OMM (FORMAT=JSON — forward-compatible with
 * 6+ digit catalog numbers) and convert it to a legacy 3-line TLE string.
 */
async function fetchTleFromCelesTrak(noradId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=JSON`,
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    if (!text || text.startsWith('No GP') || text === '[]') throw new Error(`No GP data for NORAD ${noradId}`);
    const data = JSON.parse(text);
    const omm = Array.isArray(data) ? data[0] : data;
    if (!omm || omm.NORAD_CAT_ID == null) throw new Error(`No GP data for NORAD ${noradId}`);
    return ommToTLE(omm).threeLine;
  } finally {
    clearTimeout(timeoutId);
  }
}

function seedGroupsIfEmpty() {
  const insertGroup = db.prepare(`
    INSERT OR IGNORE INTO groups (id, name, label, color, sort_order, schedulable, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedTxn = db.transaction(() => {
    const now = new Date().toISOString();
    for (const group of BUILTIN_GROUPS) {
      insertGroup.run(
        group.id,
        group.name,
        group.label,
        group.color,
        group.sortOrder,
        group.schedulable,
        now,
        now,
      );
    }
  });

  seedTxn();
}

function normalizeText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function deriveGroupId(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid ISO date');
  }
  return date.toISOString();
}

function clampElev(value) {
  return Math.max(0, Math.min(90, Number(value) || 0));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isSqliteConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

function safeParseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function antennaExists(antennaId) {
  if (!antennaId) return false;
  const row = db.prepare('SELECT id FROM antennas WHERE id = ?').get(antennaId);
  return Boolean(row?.id);
}

function mapGroupRow(row) {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    color: row.color || '',
    sortOrder: row.sort_order,
    schedulable: Boolean(row.schedulable),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureCustomGroup() {
  const customGroup = BUILTIN_GROUPS.find((group) => group.id === 'custom');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO groups (id, name, label, color, sort_order, schedulable, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    customGroup.id,
    customGroup.name,
    customGroup.label,
    customGroup.color,
    customGroup.sortOrder,
    customGroup.schedulable,
    now,
    now,
  );
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
    if (az < 0 || az > 360) {
      throw new Error('Mask azDeg must be in [0, 360]');
    }
    if (minEl < 0 || minEl > 90) {
      throw new Error('Mask minElDeg must be in [0, 90]');
    }

    byAz.set(normalizeAzDeg(az), clampElev(minEl));
  }

  return Array.from(byAz.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([azDeg, minElDeg]) => ({ azDeg, minElDeg }));
}

function replaceAntennaMaskEntries(antennaId, entries) {
  const remove = db.prepare('DELETE FROM antenna_masks WHERE antenna_id = ?');
  const insert = db.prepare(`
    INSERT INTO antenna_masks (antenna_id, az_deg, min_el_deg)
    VALUES (?, ?, ?)
  `);

  const txn = db.transaction((normalizedEntries) => {
    remove.run(antennaId);
    for (const entry of normalizedEntries) {
      insert.run(antennaId, entry.azDeg, entry.minElDeg);
    }
  });

  txn(entries);
}

function normalizeAzDeg(value) {
  const wrapped = ((Number(value) % 360) + 360) % 360;
  return wrapped === 360 ? 0 : wrapped;
}
