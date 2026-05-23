/**
 * Mobile entry-point app shell.
 *
 * Scope per design decision: VIEWER ONLY.
 *   - Satellite multi-select chips (each toggles its orbit on/off)
 *   - Focused TLE card (read-only) for the most recently chosen satellite
 *   - Next-5 pass cards (read-only) for the focused satellite across all stations
 *   - 2D ⇄ 3D mode toggle
 *   - Track FAB that locks the camera onto the focused satellite
 *
 * NOT included on mobile (by design):
 *   - Schedule Manager / Timeline Gantt / Configuration CRUD / Recording
 *   - CelesTrak fetch, Auto-refresh, Reference time picker, Past/future sliders
 *
 * Backend: same VITE_BACKEND switch as desktop. Demo build resolves to
 * the localStorage adapter, so the mobile visitor shares any state they
 * previously edited on the desktop demo (same origin).
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './mobile.css';

import { patch } from '../core/app-store.js';
import {
  fetchSatellites,
  fetchStations,
  fetchAntennas,
  fetchMappings,
  fetchGroups,
  getSetting,
  putSetting,
} from '../core/api.js';
import { parseTLE, propagateOrbit } from '../orbit.js';
import { computePasses } from '../pass-prediction.js';
import {
  buildMobileViewerOptions,
  pickResolutionScale,
  pickMsaaSamples,
  applyMobileViewerTweaks,
} from './cesium-config.js';
import { attachMobileLifecycle } from './lifecycle.js';
import {
  addMobileSatellite,
  removeMobileSatellite,
  addMobileGroundStations,
} from './mobile-visualization.js';

// ─── State ────────────────────────────────────────────────────────────────

/** @type {Cesium.Viewer|null} */
let viewer = null;
/** Sorted satellites for the chip list. */
let satellitesList = [];
/** Sorted stations for pass computation + display. */
let stationsList = [];
/** Currently visible satellite ids (chip toggle state). */
const selectedSatIds = new Set();
/** Most recently chosen satellite — drives TLE card + pass list + Track FAB. */
let focusedSatId = null;
/** Cached propagation result for the focused satellite. */
let focusedSatrec = null;
let trackEnabled = false;
const SHEET_STATES = ['sheet-peek', 'sheet-half', 'sheet-full'];
let sheetStateIdx = 0;
let toastTimer = null;

// ─── Bootstrap ────────────────────────────────────────────────────────────

bootstrap();

async function bootstrap() {
  await loadInitialData();

  viewer = createMobileViewer();
  applyMobileViewerTweaks(viewer, {
    resolutionScale: pickResolutionScale({
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
    }),
    msaaSamples: pickMsaaSamples({
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
    }),
  });
  attachMobileLifecycle(viewer);

  addMobileGroundStations(viewer, stationsList);

  setupTopBar();
  setupSheet();
  setupTrackFab();
  renderSatChips();
  renderFocusedCard(null);
  renderPasses([]);

  // Restore last focused satellite (if any).
  try {
    const saved = await getSetting('mobileFocusedSat');
    if (saved && typeof saved.satId === 'string') {
      const stillExists = satellitesList.some((s) => s.id === saved.satId);
      if (stillExists) {
        await toggleSatellite(saved.satId, /* makeFocused */ true);
      }
    }
  } catch (_) { /* missing setting is fine */ }
}

// ─── Data loading ─────────────────────────────────────────────────────────

async function loadInitialData() {
  try {
    const [groups, satellites, stations, antennas, mappings] = await Promise.all([
      fetchGroups(),
      fetchSatellites(),
      fetchStations(),
      fetchAntennas(),
      fetchMappings(),
    ]);

    const groupRec = {};
    for (const g of (groups || [])) {
      if (g?.id) groupRec[g.id] = g;
    }
    patch('groups', groupRec);

    const satRec = {};
    for (const s of (satellites || [])) {
      if (!s?.id) continue;
      satRec[s.id] = {
        ...s,
        tle: [s.tleLine0, s.tleLine1, s.tleLine2].filter(Boolean).join('\n'),
      };
    }
    patch('satellites', satRec);

    const stationRec = {};
    for (const st of (stations || [])) {
      if (st?.id) stationRec[st.id] = st;
    }
    patch('stations', stationRec);

    const antennaRec = {};
    for (const a of (antennas || [])) {
      if (a?.id) antennaRec[a.id] = a;
    }
    patch('antennas', antennaRec);

    patch('antennaMappings', Array.isArray(mappings) ? mappings : []);

    satellitesList = Object.values(satRec)
      .filter((s) => s.enabled !== false)
      .sort((a, b) => {
        const g = String(a.groupName || '').localeCompare(String(b.groupName || ''));
        return g !== 0 ? g : String(a.name || '').localeCompare(String(b.name || ''));
      });

    stationsList = Object.values(stationRec)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  } catch (err) {
    showToast('Failed to load data: ' + (err?.message || err));
  }
}

// ─── Viewer creation ──────────────────────────────────────────────────────

function createMobileViewer() {
  const opts = buildMobileViewerOptions({
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
  });

  // Use the bundled NaturalEarthII imagery (no Cesium Ion token needed).
  opts.baseLayer = Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
    ),
  );

  return new Cesium.Viewer('mCesium', opts);
}

// ─── Top bar ──────────────────────────────────────────────────────────────

function setupTopBar() {
  const modeBtn = document.getElementById('mModeToggle');
  const sheetBtn = document.getElementById('mSheetToggle');
  if (!modeBtn || !sheetBtn) return;

  modeBtn.addEventListener('click', () => {
    const is2D = viewer.scene.mode === Cesium.SceneMode.SCENE2D;
    if (is2D) {
      viewer.scene.morphTo3D(0.5);
      modeBtn.textContent = '3D';
      modeBtn.setAttribute('aria-pressed', 'true');
    } else {
      viewer.scene.morphTo2D(0.5);
      modeBtn.textContent = '2D';
      modeBtn.setAttribute('aria-pressed', 'false');
    }
  });

  sheetBtn.addEventListener('click', cycleSheetState);
}

// ─── Bottom sheet ─────────────────────────────────────────────────────────

function setupSheet() {
  const handle = document.getElementById('mSheetHandle');
  if (handle) handle.addEventListener('click', cycleSheetState);
}

function cycleSheetState() {
  sheetStateIdx = (sheetStateIdx + 1) % SHEET_STATES.length;
  const sheet = document.getElementById('mSheet');
  if (!sheet) return;
  sheet.classList.remove(...SHEET_STATES);
  sheet.classList.add(SHEET_STATES[sheetStateIdx]);
}

// ─── Satellite chip list ──────────────────────────────────────────────────

function renderSatChips() {
  const list = document.getElementById('mSatList');
  if (!list) return;
  list.innerHTML = '';

  if (satellitesList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'm-pass-empty';
    empty.textContent = 'No satellites available.';
    list.appendChild(empty);
    return;
  }

  for (const sat of satellitesList) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'm-chip';
    chip.dataset.satId = sat.id;
    chip.setAttribute('aria-pressed', selectedSatIds.has(sat.id) ? 'true' : 'false');
    if (sat.id === focusedSatId) {
      chip.classList.add('m-chip-focused');
    }

    const dot = document.createElement('span');
    dot.className = 'm-chip-dot';
    dot.style.setProperty('--dot-color', sat.color || '#7dd3fc');
    chip.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = sat.name;
    chip.appendChild(label);

    chip.addEventListener('click', () => toggleSatellite(sat.id, /* makeFocused */ true));
    list.appendChild(chip);
  }
}

async function toggleSatellite(satId, makeFocused) {
  const sat = satellitesList.find((s) => s.id === satId);
  if (!sat) return;

  const alreadyOn = selectedSatIds.has(satId);

  if (alreadyOn && !makeFocused) {
    // Plain toggle off
    removeMobileSatellite(viewer, satId);
    selectedSatIds.delete(satId);
    if (focusedSatId === satId) {
      focusedSatId = null;
      focusedSatrec = null;
      renderFocusedCard(null);
      renderPasses([]);
      hideTrackFab();
    }
    renderSatChips();
    return;
  }

  if (alreadyOn && makeFocused && focusedSatId === satId) {
    // Same focused chip tapped again → toggle off
    removeMobileSatellite(viewer, satId);
    selectedSatIds.delete(satId);
    focusedSatId = null;
    focusedSatrec = null;
    renderFocusedCard(null);
    renderPasses([]);
    hideTrackFab();
    renderSatChips();
    return;
  }

  // Either not on yet, or on but a different chip is focused.
  if (!alreadyOn) {
    let satrec;
    let positions;
    try {
      satrec = parseTLE(sat.tle);
      const result = propagateOrbit(satrec, {
        pastOrbits: 1,
        futureOrbits: 1.5,
        pointsPerOrbit: 90,
      });
      positions = result.positions;
      addMobileSatellite(viewer, sat.id, sat.name, positions, sat.color);
      selectedSatIds.add(sat.id);
    } catch (err) {
      showToast('Bad TLE for ' + sat.name + ': ' + (err?.message || err));
      return;
    }

    // Cesium's SampledPositionProperty + the trail CallbackProperty both
    // need the viewer clock to be inside the position-sample availability
    // window AND actively advancing — otherwise the trail returns empty
    // slices and only the satellite point shows up. Pin the clock to the
    // freshly-propagated window every time a satellite is added so
    // subsequent satellites can't desync it.
    setClockForPositions(positions);

    if (makeFocused) {
      focusedSatId = sat.id;
      focusedSatrec = satrec;
      await onFocusedSatelliteChanged(sat, satrec);
    }
  } else if (makeFocused) {
    // Already on, just re-focus
    try {
      const satrec = parseTLE(sat.tle);
      focusedSatId = sat.id;
      focusedSatrec = satrec;
      await onFocusedSatelliteChanged(sat, satrec);
    } catch (err) {
      showToast('Re-focus failed: ' + (err?.message || err));
    }
  }

  renderSatChips();
}

async function onFocusedSatelliteChanged(sat, satrec) {
  showTrackFab();
  renderFocusedCard(sat);

  // Compute next 5 passes within 24h (read-only).
  try {
    const passes = computePasses(
      satrec,
      stationsList,
      new Date(),
      new Date(Date.now() + 24 * 3600 * 1000),
      30, // 30 s step — faster than desktop's 10 s, fine for mobile display
      { perAntenna: false },
    );
    renderPasses(passes.slice(0, 5));
  } catch (err) {
    renderPasses([]);
    showToast('Pass compute failed: ' + (err?.message || err));
  }

  // Persist focused id so refresh restores it.
  try { await putSetting('mobileFocusedSat', { satId: sat.id }); } catch (_) {}

  flyCameraToSatellite(sat.id);
}

/**
 * Move the camera so the satellite is centred at a roughly continent-scale
 * altitude that shows a useful chunk of the orbit trail.
 *
 * We use Cartesian3.fromDegrees(lon, lat, 15_000_000) rather than a
 * Rectangle, because Rectangle.fromDegrees(lon-45, …, lon+45, …) wraps
 * past ±180° whenever the satellite is anywhere near the antimeridian,
 * which feeds Cesium a degenerate camera frame and trips
 * `createPotentiallyVisibleSet` with "Invalid array length". A point
 * destination is unconditional.
 */
function flyCameraToSatellite(satId) {
  if (!viewer) return;
  const ent = viewer.entities.getById(`m-sat-${satId}`);
  if (!ent || !ent.position) return;

  try {
    const cart = ent.position.getValue(viewer.clock.currentTime);
    if (!cart) return;
    const carto = Cesium.Cartographic.fromCartesian(cart);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 15_000_000), // ~15,000 km up
      duration: 0.6,
    });
  } catch (_) {
    // Don't try a secondary flyTo — if the primary failed, the safest
    // outcome is to leave the camera where it is.
  }
}

/**
 * Pin Cesium's clock to the freshly-propagated position window AND restart
 * playback at "now". Without this the SampledPositionProperty falls outside
 * the availability window (or the clock isn't advancing) and trails render
 * empty — only the point shows.
 */
function setClockForPositions(positions) {
  if (!viewer || !Array.isArray(positions) || positions.length === 0) return;
  const start = Cesium.JulianDate.fromDate(positions[0].date);
  const stop = Cesium.JulianDate.fromDate(positions[positions.length - 1].date);
  viewer.clock.startTime = start.clone();
  viewer.clock.stopTime = stop.clone();
  viewer.clock.currentTime = Cesium.JulianDate.now();
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
  viewer.clock.multiplier = 1;
  viewer.clock.shouldAnimate = true;
  viewer.scene.requestRender();
}

// ─── Focused TLE card ─────────────────────────────────────────────────────

function renderFocusedCard(sat) {
  const section = document.getElementById('mFocusedSection');
  const card = document.getElementById('mFocusedCard');
  if (!section || !card) return;

  if (!sat) {
    section.hidden = true;
    card.innerHTML = '';
    return;
  }
  section.hidden = false;
  card.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'm-card-header';
  const dot = document.createElement('span');
  dot.className = 'm-chip-dot';
  dot.style.setProperty('--dot-color', sat.color || '#7dd3fc');
  header.appendChild(dot);
  const title = document.createElement('span');
  title.textContent = sat.name;
  header.appendChild(title);
  card.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'm-card-meta';
  if (sat.noradId) meta.appendChild(makeMetaSpan('NORAD', String(sat.noradId)));
  if (sat.groupName) meta.appendChild(makeMetaSpan('Group', sat.groupName));
  card.appendChild(meta);

  if (sat.tle) {
    const pre = document.createElement('pre');
    pre.className = 'm-tle-text';
    pre.textContent = sat.tle;
    card.appendChild(pre);
  }
}

function makeMetaSpan(label, value) {
  const span = document.createElement('span');
  span.textContent = `${label}: ${value}`;
  return span;
}

// ─── Pass schedule cards ──────────────────────────────────────────────────

function renderPasses(passes) {
  const list = document.getElementById('mPassesList');
  if (!list) return;
  list.innerHTML = '';

  if (!passes || passes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'm-pass-empty';
    empty.textContent = focusedSatId
      ? 'No passes in the next 24 hours.'
      : 'Tap a satellite to see its next passes.';
    list.appendChild(empty);
    return;
  }

  for (const pass of passes) {
    const card = document.createElement('div');
    card.className = 'm-pass-card';

    const stationName = stationsList.find((s) => s.id === pass.stationId)?.name || pass.stationId;
    const aos = pass.aos instanceof Date ? pass.aos : new Date(pass.aos);
    const los = pass.los instanceof Date ? pass.los : new Date(pass.los);
    const durMin = Math.max(0, Math.round((los - aos) / 60000));
    const maxEl = Number.isFinite(pass.maxElDeg) ? pass.maxElDeg.toFixed(1) : '–';

    const stationSpan = document.createElement('span');
    stationSpan.className = 'm-pass-station';
    stationSpan.textContent = stationName;
    card.appendChild(stationSpan);

    const whenSpan = document.createElement('span');
    whenSpan.className = 'm-pass-when';
    whenSpan.textContent = formatAosShort(aos);
    card.appendChild(whenSpan);

    const meta = document.createElement('div');
    meta.className = 'm-pass-meta';
    const aosSpan = document.createElement('span');
    aosSpan.textContent = `AOS ${aos.toISOString().slice(11, 19)}Z`;
    meta.appendChild(aosSpan);
    const durSpan = document.createElement('span');
    durSpan.textContent = `${durMin} min`;
    meta.appendChild(durSpan);
    const elSpan = document.createElement('span');
    elSpan.textContent = `max ${maxEl}°`;
    meta.appendChild(elSpan);
    card.appendChild(meta);

    list.appendChild(card);
  }
}

function formatAosShort(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const MM = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${HH}:${MM}`;
}

// ─── Track FAB ────────────────────────────────────────────────────────────

function setupTrackFab() {
  const fab = document.getElementById('mTrackFab');
  if (!fab) return;
  fab.addEventListener('click', () => {
    if (!viewer || !focusedSatId) return;
    trackEnabled = !trackEnabled;
    fab.setAttribute('aria-pressed', trackEnabled ? 'true' : 'false');
    if (trackEnabled) {
      const ent = viewer.entities.getById(`m-sat-${focusedSatId}`);
      if (ent) viewer.trackedEntity = ent;
    } else {
      viewer.trackedEntity = undefined;
    }
  });
}

function showTrackFab() {
  const fab = document.getElementById('mTrackFab');
  if (fab) fab.hidden = false;
}

function hideTrackFab() {
  const fab = document.getElementById('mTrackFab');
  if (fab) {
    fab.hidden = true;
    fab.setAttribute('aria-pressed', 'false');
  }
  trackEnabled = false;
  if (viewer) viewer.trackedEntity = undefined;
}

// ─── Toast ────────────────────────────────────────────────────────────────

function showToast(msg) {
  const toast = document.getElementById('mToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

// Re-export for tests / debugging (no global pollution).
export const _internal = {
  get viewer() { return viewer; },
  get focusedSatId() { return focusedSatId; },
  get selectedSatIds() { return new Set(selectedSatIds); },
};
