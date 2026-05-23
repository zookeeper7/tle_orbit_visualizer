/**
 * Mobile entry-point app shell.
 *
 * Scope per design decision: VIEWER ONLY.
 *   - Satellite multi-select chips (each toggles its orbit on/off; most
 *     recently tapped chip becomes the "focused" satellite that drives
 *     the TLE card and pass list)
 *   - Focused TLE card (read-only)
 *   - Next-5 pass cards (read-only) for the focused satellite across all stations
 *   - 2D / 3D mode toggle
 *   - Playback controls: Play/Pause, 4 speed pills (1×/10×/60×/360×),
 *     UTC clock display, Reference Time picker + Apply, NOW button
 *
 * NOT included on mobile (by design):
 *   - Schedule Manager / Timeline Gantt / Configuration CRUD / Recording
 *   - CelesTrak fetch, Auto-refresh
 *   - viewer.trackedEntity (Cesium's frustum culler crashes on
 *     SampledPositionProperty + trackedEntity bindings — desktop sidesteps
 *     this with a custom preRender tracker; mobile just doesn't ship the
 *     follow-camera affordance at all)
 *
 * Visualization reuses the desktop renderer (`src/visualization.js`)
 * verbatim — the previous mobile-only renderer was harder to debug and
 * never reliably rendered the orbit trail. The downside is that toggling
 * any satellite re-runs the full clear + re-add of every selected
 * satellite, but with ≤ 12 preset satellites this is unmeasurably fast.
 *
 * Backend: same VITE_BACKEND switch as desktop. Demo build resolves to
 * the localStorage adapter, so the mobile visitor shares any state they
 * previously edited on the desktop demo (same origin).
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './mobile.css';

import { patch, subscribe } from '../core/app-store.js';
import {
  fetchSatellites,
  fetchStations,
  fetchAntennas,
  fetchMappings,
  fetchGroups,
  getSetting,
  putSetting,
  updateSatellite,
} from '../core/api.js';
import { parseTLE, propagateOrbit } from '../orbit.js';
import { computePasses } from '../pass-prediction.js';
import { checkConnection, fetchLatestTLE } from '../tle-fetch.js';
import {
  pickConnDotState,
  formatBatchLabel,
  formatBatchPercent,
  runWithConcurrency,
} from './conn-tle-helpers.js';
import {
  addSatelliteVisualization,
  clearVisualization,
} from '../visualization.js';
import {
  buildMobileViewerOptions,
  pickResolutionScale,
  pickMsaaSamples,
  applyMobileViewerTweaks,
} from './cesium-config.js';
import { attachMobileLifecycle } from './lifecycle.js';
import { addMobileGroundStations } from './mobile-visualization.js';

// ─── State ────────────────────────────────────────────────────────────────

/** @type {Cesium.Viewer|null} */
let viewer = null;
let satellitesList = [];
let stationsList = [];
const selectedSatIds = new Set();
let focusedSatId = null;

/** null = live (clock follows wall-time), Date = locked epoch for replay. */
let referenceDate = null;

const SHEET_STATES = ['sheet-peek', 'sheet-half', 'sheet-full'];
let sheetStateIdx = 0;
let toastTimer = null;
let clockDisplayHandle = null;

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
  setupPlayback();
  setupConnAndTle();
  renderSatChips();
  renderFocusedCard(null);
  renderPasses([]);
  updatePlaybackUI();
  startClockDisplayLoop();

  // Install the 'satellites' store subscriber AFTER the initial render
  // pass — that way the subscriber doesn't re-fire during boot for the
  // patches inside loadInitialData() (those have already painted the UI).
  subscribeSatellitesSlice();

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

/**
 * Subscribe to the 'satellites' app-store slice. Whenever it changes
 * (e.g. background CelesTrak refresh writes fresh TLE rows, or the
 * user-triggered fetch UI updates them), rebuild satellitesList,
 * re-render the chip list + focused TLE card, and re-run the orbit
 * visualization for the focused satellite if its TLE actually changed.
 *
 * The diff is over the full TLE string (line0 + line1 + line2) so a
 * no-op patch (same TLE) doesn't trigger any re-render. This is
 * defence-in-depth — api-local.js already gates patch() behind
 * `updated > 0`, but other call sites (single-satellite Fetch button,
 * future Auto Refresh, third-party patches) might not.
 */
let lastSatTlesById = new Map();

function snapshotSatTles() {
  const next = new Map();
  for (const s of satellitesList) next.set(s.id, s.tle || '');
  return next;
}

function diffSatelliteTles(prev, next) {
  const changed = new Set();
  for (const [id, tle] of next) {
    if (prev.get(id) !== tle) changed.add(id);
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) changed.add(id);
  }
  return Array.from(changed).sort();
}

function subscribeSatellitesSlice() {
  lastSatTlesById = snapshotSatTles();
  subscribe('satellites', (satRec) => {
    const newList = rebuildSatellitesList(satRec);
    // Re-attach the joined `tle` field so the diff has something to compare.
    // satRec entries from api-local won't have `.tle` (they store split
    // tleLine0/1/2); loadInitialData already builds `.tle`, but a fresh
    // background-refresh patch comes from refreshPresetTlesFromCelesTrak
    // which DOES set `.tle`. Normalise here defensively.
    for (const s of newList) {
      if (typeof s.tle !== 'string' || !s.tle) {
        s.tle = [s.tleLine0, s.tleLine1, s.tleLine2].filter(Boolean).join('\n');
      }
    }
    satellitesList = newList;
    const nextMap = snapshotSatTles();
    const changedIds = diffSatelliteTles(lastSatTlesById, nextMap);
    lastSatTlesById = nextMap;
    if (changedIds.length === 0) return;

    // Repaint chip list (preserves selection + focus via existing module state)
    renderSatChips();

    // Update focused TLE card text if the focused satellite is in the changed set.
    if (focusedSatId) {
      const sat = satellitesList.find((s) => s.id === focusedSatId);
      if (sat) renderFocusedCard(sat);
    }

    // Re-run SGP4 propagation + redraw for any currently-selected satellite
    // whose TLE changed. syncVisualization re-runs the full set — cheap
    // for the preset count (≤12 entries) and keeps the visualization
    // consistent with the chip selection.
    const anySelectedChanged = changedIds.some((id) => selectedSatIds.has(id));
    if (anySelectedChanged) {
      syncVisualization();
    }

    // Pass schedule is derived from the focused satellite's TLE — recompute
    // it whenever the focused TLE changes.
    if (focusedSatId && changedIds.includes(focusedSatId)) {
      const sat = satellitesList.find((s) => s.id === focusedSatId);
      if (sat) {
        try { computeAndRenderPasses(parseTLE(sat.tle).satrec); } catch (_) {}
      }
    }
  });
}

// ─── Connection & TLE (top-bar dot, sheet section, batch fetch) ──────────

/** Connection state machine: 'idle' | 'checking' | 'online' | 'offline'. */
let connState = 'idle';
/** When set, indicates an in-flight batch fetch (and serves as its abort handle). */
let batchAbort = null;
/** Per-satellite single-fetch lock so the same satellite isn't fetched twice in parallel. */
const singleFetchInFlight = new Set();
/** Auto-retry timer when offline (15s cadence; cleared on any state change). */
let autoRetryTimer = null;
/** Per-chip data-fetch attribute clear timers, keyed by satId. */
const chipFetchTimers = new Map();
const AUTO_RETRY_MS = 15_000;
const CHIP_FETCH_CLEAR_MS_SUCCESS = 3000;
const CHIP_FETCH_CLEAR_MS_ERROR = 5000;
const FETCH_BATCH_CONCURRENCY = 3;

function setConnState(next) {
  if (connState === next) return;
  connState = next;

  // Top-bar dot
  const dot = document.getElementById('mConnDot');
  if (dot) dot.dataset.state = pickConnDotState(next);

  // In-sheet inline indicator
  const inline = document.getElementById('mConnInline');
  if (inline) inline.dataset.state = next;

  // Inline button label
  const label = document.getElementById('mConnLabel');
  if (label) {
    label.textContent = next === 'checking' ? 'Checking…'
      : next === 'online'  ? 'Connected'
      : next === 'offline' ? 'Offline'
      : 'Check Connection';
  }

  // Section-header pill (only shown for non-idle, non-online states)
  const pill = document.getElementById('mConnPill');
  if (pill) {
    if (next === 'idle' || next === 'online') {
      pill.hidden = true;
      pill.textContent = '';
      pill.removeAttribute('data-state');
    } else {
      pill.hidden = false;
      pill.dataset.state = next;
      pill.textContent = next === 'checking' ? 'Checking' : next === 'offline' ? 'Offline' : '';
    }
  }

  // Fetch buttons: enabled only when online and not in a batch
  const refreshBtn = document.getElementById('mRefreshFocusedBtn');
  const fetchAllBtn = document.getElementById('mFetchAllBtn');
  const enableFetch = next === 'online' && !batchAbort;
  if (refreshBtn) refreshBtn.disabled = !enableFetch;
  if (fetchAllBtn) fetchAllBtn.disabled = !enableFetch;

  // Auto-retry scheduling
  if (autoRetryTimer) { clearTimeout(autoRetryTimer); autoRetryTimer = null; }
  if (next === 'offline') {
    autoRetryTimer = setTimeout(() => { runConnectionCheck(/* silent */ true); }, AUTO_RETRY_MS);
  }
}

function showMobileConnStatus(msg, type, { announce = true } = {}) {
  const el = document.getElementById('mConnStatus');
  if (el) {
    el.className = `m-conn-status ${type || 'info'}`;
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  if (announce) {
    const live = document.getElementById('mSrLive');
    if (live) {
      // Switch role for error severity so AT interrupts (best-effort).
      try { live.setAttribute('role', type === 'error' ? 'alert' : 'status'); } catch (_) {}
      live.textContent = '';
      // Forced reflow so the live region observes the mutation
      // eslint-disable-next-line no-unused-expressions
      void live.offsetWidth;
      live.textContent = msg || '';
    }
  }
}

function setChipFetchState(satId, state) {
  const chip = document.querySelector(`.m-chip[data-sat-id="${cssEscape(satId)}"]`);
  if (chip) {
    if (state) chip.dataset.fetch = state;
    else chip.removeAttribute('data-fetch');
  }
  const prev = chipFetchTimers.get(satId);
  if (prev) clearTimeout(prev);
  if (state === 'success' || state === 'error') {
    const delay = state === 'success' ? CHIP_FETCH_CLEAR_MS_SUCCESS : CHIP_FETCH_CLEAR_MS_ERROR;
    const t = setTimeout(() => {
      const ch = document.querySelector(`.m-chip[data-sat-id="${cssEscape(satId)}"]`);
      if (ch) ch.removeAttribute('data-fetch');
      chipFetchTimers.delete(satId);
    }, delay);
    chipFetchTimers.set(satId, t);
  } else {
    chipFetchTimers.delete(satId);
  }
}

/**
 * CSS.escape polyfill for older browsers (mobile Safari < 14).
 * Satellite ids are alphanumeric in PRESETS so escape is a no-op in
 * practice, but defensive code costs nothing.
 */
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(s));
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c.codePointAt(0).toString(16)} `);
}

async function runConnectionCheck(silent = false) {
  setConnState('checking');
  if (!silent) showMobileConnStatus('Checking internet connection…', 'info');
  const online = await checkConnection();
  setConnState(online ? 'online' : 'offline');
  if (online) {
    if (!silent) showMobileConnStatus('Online — CelesTrak reachable', 'success');
  } else {
    showMobileConnStatus('Cannot reach CelesTrak — check your internet', 'error');
  }
  return online;
}

/**
 * Split a 3-line TLE response into {line0, line1, line2}, identifying
 * the lines by their leading "1 " / "2 " markers (same logic the
 * desktop fetchTleBtn handler uses). Returns null if the response is
 * malformed.
 */
function parseFetchedTle(tleText) {
  if (typeof tleText !== 'string') return null;
  const lines = tleText.split('\n').map((l) => l.trim()).filter(Boolean);
  const line1 = lines.find((l) => l.startsWith('1 ')) || '';
  const line2 = lines.find((l) => l.startsWith('2 ')) || '';
  if (!line1 || !line2) return null;
  const line0 = (lines[0] && lines[0] !== line1 && lines[0] !== line2) ? lines[0] : '';
  return { line0, line1, line2 };
}

/**
 * Persist a freshly-fetched TLE for one satellite — writes to the API
 * (server DB or localStorage adapter), then patches the in-memory store
 * so the 'satellites' subscriber (subscribeSatellitesSlice) re-renders
 * the chip / focused card / orbit visualization automatically.
 */
async function persistFetchedTle(sat, parsed) {
  await updateSatellite(sat.id, {
    id: sat.id,
    name: sat.name,
    noradId: Number.isFinite(Number(sat.noradId)) ? Number(sat.noradId) : null,
    groupName: sat.groupName || sat.group || '',
    color: sat.color || '#7dd3fc',
    enabled: sat.enabled !== false,
    tleLine0: parsed.line0,
    tleLine1: parsed.line1,
    tleLine2: parsed.line2,
  });
  patch('satellites', (current) => {
    if (current[sat.id]) {
      current[sat.id] = {
        ...current[sat.id],
        tleLine0: parsed.line0,
        tleLine1: parsed.line1,
        tleLine2: parsed.line2,
        tle: [parsed.line0, parsed.line1, parsed.line2].filter(Boolean).join('\n'),
      };
    }
    return current;
  });
}

async function handleRefreshFocused() {
  if (connState !== 'online') {
    showMobileConnStatus('Run "Check Connection" first.', 'error');
    return;
  }
  if (!focusedSatId) {
    showMobileConnStatus('Tap a satellite chip to focus it, then refresh.', 'error');
    return;
  }
  const sat = satellitesList.find((s) => s.id === focusedSatId);
  if (!sat || !Number.isFinite(Number(sat.noradId))) {
    showMobileConnStatus(`${sat?.name || 'Satellite'} has no NORAD ID.`, 'error');
    return;
  }
  if (singleFetchInFlight.has(sat.id)) return; // dedupe
  singleFetchInFlight.add(sat.id);
  setChipFetchState(sat.id, 'pending');
  showMobileConnStatus(`Fetching latest TLE for ${sat.name}…`, 'info');
  try {
    const tle = await fetchLatestTLE(Number(sat.noradId));
    const parsed = parseFetchedTle(tle);
    if (!parsed) throw new Error('Malformed TLE response');
    await persistFetchedTle(sat, parsed);
    setChipFetchState(sat.id, 'success');
    showMobileConnStatus(`Latest TLE loaded for ${sat.name}`, 'success');
  } catch (err) {
    setChipFetchState(sat.id, 'error');
    showMobileConnStatus(`Refresh failed for ${sat.name}: ${err?.message || err}`, 'error');
  } finally {
    singleFetchInFlight.delete(sat.id);
  }
}

async function handleFetchAll() {
  if (connState !== 'online') {
    showMobileConnStatus('Run "Check Connection" first.', 'error');
    return;
  }
  if (batchAbort) return; // already running
  const eligible = satellitesList.filter(
    (s) => s.enabled !== false && Number.isFinite(Number(s.noradId)),
  );
  if (eligible.length === 0) {
    showMobileConnStatus('No satellites with a NORAD ID to refresh.', 'error');
    return;
  }

  batchAbort = new AbortController();
  const progressEl = document.getElementById('mBatchProgress');
  const fillEl = document.getElementById('mBatchBarFill');
  const labelEl = document.getElementById('mBatchLabel');
  const cancelBtn = document.getElementById('mBatchCancelBtn');
  const refreshBtn = document.getElementById('mRefreshFocusedBtn');
  const fetchAllBtn = document.getElementById('mFetchAllBtn');

  if (progressEl) progressEl.hidden = false;
  if (labelEl) labelEl.textContent = formatBatchLabel(0, eligible.length);
  if (fillEl) fillEl.style.width = `${formatBatchPercent(0, eligible.length)}%`;
  if (refreshBtn) refreshBtn.disabled = true;
  if (fetchAllBtn) fetchAllBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = false;

  for (const sat of eligible) setChipFetchState(sat.id, 'pending');

  let done = 0;
  let ok = 0;
  let fail = 0;
  const updateProgress = () => {
    if (labelEl) labelEl.textContent = formatBatchLabel(done, eligible.length);
    if (fillEl) fillEl.style.width = `${formatBatchPercent(done, eligible.length)}%`;
  };

  const worker = async (sat) => {
    if (batchAbort?.signal.aborted) throw new Error('Cancelled');
    try {
      const tle = await fetchLatestTLE(Number(sat.noradId));
      const parsed = parseFetchedTle(tle);
      if (!parsed) throw new Error('Malformed TLE response');
      await persistFetchedTle(sat, parsed);
      setChipFetchState(sat.id, 'success');
      ok += 1;
    } catch (err) {
      setChipFetchState(sat.id, 'error');
      fail += 1;
      throw err;
    } finally {
      done += 1;
      updateProgress();
    }
  };

  showMobileConnStatus(`Fetching ${eligible.length} satellites…`, 'info');
  await runWithConcurrency(eligible, FETCH_BATCH_CONCURRENCY, worker, { signal: batchAbort.signal });

  const wasAborted = batchAbort.signal.aborted;
  batchAbort = null;

  // Re-enable buttons via setConnState (which re-evaluates batchAbort==null).
  // Manually re-poke because connState didn't change.
  if (refreshBtn) refreshBtn.disabled = connState !== 'online';
  if (fetchAllBtn) fetchAllBtn.disabled = connState !== 'online';

  // Linger at 100% for 1s so the user sees completion, then hide.
  setTimeout(() => { if (progressEl) progressEl.hidden = true; }, 1000);

  if (wasAborted) {
    showMobileConnStatus(`Cancelled. ${ok} updated, ${fail} failed, ${eligible.length - done} skipped.`, 'info');
  } else if (fail === 0) {
    showMobileConnStatus(`Refreshed ${ok} satellites.`, 'success');
  } else {
    showMobileConnStatus(`Refreshed ${ok}, failed ${fail}.`, fail === eligible.length ? 'error' : 'info');
  }
}

function handleBatchCancel() {
  if (!batchAbort) return;
  batchAbort.abort();
  // pending chips' state will be cleared by their workers' final
  // setChipFetchState on rejection. Workers that haven't started won't run
  // their chip update, so we proactively clear after a short delay.
  setTimeout(() => {
    for (const sat of satellitesList) {
      const chip = document.querySelector(`.m-chip[data-sat-id="${cssEscape(sat.id)}"]`);
      if (chip && chip.dataset.fetch === 'pending') chip.removeAttribute('data-fetch');
    }
  }, 200);
}

function setupConnAndTle() {
  const connBtn = document.getElementById('mConnCheckBtn');
  const dotBtn = document.getElementById('mConnDot');
  const refreshBtn = document.getElementById('mRefreshFocusedBtn');
  const fetchAllBtn = document.getElementById('mFetchAllBtn');
  const cancelBtn = document.getElementById('mBatchCancelBtn');

  if (connBtn) connBtn.addEventListener('click', () => runConnectionCheck());
  if (dotBtn) dotBtn.addEventListener('click', () => runConnectionCheck());
  if (refreshBtn) refreshBtn.addEventListener('click', handleRefreshFocused);
  if (fetchAllBtn) fetchAllBtn.addEventListener('click', handleFetchAll);
  if (cancelBtn) cancelBtn.addEventListener('click', handleBatchCancel);

  // Kick off a connection check immediately on boot so the user lands on
  // a known state (and the fetch buttons enable / disable correctly).
  runConnectionCheck(/* silent */ true);
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

    satellitesList = rebuildSatellitesList(satRec);

    stationsList = Object.values(stationRec)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  } catch (err) {
    showToast('Failed to load data: ' + (err?.message || err));
  }
}

/**
 * Pure helper — builds the sorted, enabled-only satellites list from a
 * record-by-id map. Extracted so both loadInitialData() and the
 * 'satellites' store subscriber can share one source of truth.
 */
function rebuildSatellitesList(satRec) {
  return Object.values(satRec || {})
    .filter((s) => s && s.enabled !== false)
    .sort((a, b) => {
      const g = String(a.groupName || '').localeCompare(String(b.groupName || ''));
      return g !== 0 ? g : String(a.name || '').localeCompare(String(b.name || ''));
    });
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
    if (!viewer) return;
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

// ─── Playback (top-bar clock + sheet controls) ────────────────────────────

function setupPlayback() {
  const playBtn = document.getElementById('mPlayPause');
  const nowBtn = document.getElementById('mNowBtn');
  const speedPills = document.querySelectorAll('.m-speed-pill');
  const refTimeInput = document.getElementById('mRefTime');
  const applyRefBtn = document.getElementById('mApplyRef');
  const liveBadge = document.getElementById('mLiveBadge');

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (!viewer) return;
      const next = !viewer.clock.shouldAnimate;
      viewer.clock.shouldAnimate = next;
      viewer.scene.requestRender();
      updatePlaybackUI();
    });
  }

  for (const pill of speedPills) {
    pill.addEventListener('click', () => {
      if (!viewer) return;
      const speed = Number(pill.dataset.speed);
      if (!Number.isFinite(speed) || speed <= 0) return;
      viewer.clock.multiplier = speed;
      viewer.scene.requestRender();
      updatePlaybackUI();
    });
  }

  if (nowBtn) {
    nowBtn.addEventListener('click', async () => {
      if (!viewer) return;
      referenceDate = null;
      if (refTimeInput) refTimeInput.value = '';
      await syncVisualization();
      if (focusedSatId) {
        const sat = satellitesList.find((s) => s.id === focusedSatId);
        if (sat) {
          try { computeAndRenderPasses(parseTLE(sat.tle).satrec); } catch (_) {}
        }
      }
      updatePlaybackUI();
      showToast('Reset to live time');
    });
  }

  if (applyRefBtn && refTimeInput) {
    applyRefBtn.addEventListener('click', async () => {
      const v = refTimeInput.value;
      if (!v) { showToast('Pick a date and time first'); return; }
      const d = new Date(v + 'Z');
      if (Number.isNaN(d.getTime())) { showToast('Invalid date'); return; }
      referenceDate = d;
      await syncVisualization();
      updatePlaybackUI();
      showToast('Reference time set');
    });
  }

  // Live badge is informational only; click resets to live just like NOW.
  if (liveBadge) {
    liveBadge.addEventListener('click', () => {
      if (nowBtn) nowBtn.click();
    });
  }
}

function updatePlaybackUI() {
  if (!viewer) return;

  const playBtn = document.getElementById('mPlayPause');
  if (playBtn) {
    const playing = viewer.clock.shouldAnimate;
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    playBtn.setAttribute('aria-label', playing ? 'Pause playback' : 'Resume playback');
  }

  const currentMult = viewer.clock.multiplier;
  const pills = document.querySelectorAll('.m-speed-pill');
  for (const p of pills) {
    const matches = Number(p.dataset.speed) === currentMult;
    p.setAttribute('aria-pressed', matches ? 'true' : 'false');
  }

  const liveBadge = document.getElementById('mLiveBadge');
  if (liveBadge) {
    liveBadge.hidden = referenceDate == null;
    if (referenceDate != null) {
      liveBadge.textContent = 'Ref: ' + referenceDate.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    }
  }
}

/**
 * Update the top-bar clock display via requestAnimationFrame instead of
 * Cesium's clock.onTick — onTick only fires while shouldAnimate is true,
 * but we want the display to reflect the current time even while paused.
 */
function startClockDisplayLoop() {
  if (clockDisplayHandle != null) return;
  const tick = () => {
    const el = document.getElementById('mClockText');
    if (el && viewer && viewer.clock && viewer.clock.currentTime) {
      const d = Cesium.JulianDate.toDate(viewer.clock.currentTime);
      el.textContent = formatClockShort(d);
    }
    clockDisplayHandle = requestAnimationFrame(tick);
  };
  clockDisplayHandle = requestAnimationFrame(tick);
}

function formatClockShort(d) {
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const H = String(d.getUTCHours()).padStart(2, '0');
  const Mi = String(d.getUTCMinutes()).padStart(2, '0');
  const S = String(d.getUTCSeconds()).padStart(2, '0');
  return `${M}/${D} ${H}:${Mi}:${S}Z`;
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
    if (sat.id === focusedSatId) chip.classList.add('m-chip-focused');

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

  // 1. Plain toggle off (without focusing) — only used programmatically;
  //    chip taps always pass makeFocused=true.
  if (alreadyOn && !makeFocused) {
    selectedSatIds.delete(satId);
    if (focusedSatId === satId) {
      focusedSatId = null;
      renderFocusedCard(null);
      renderPasses([]);
    }
    await syncVisualization();
    renderSatChips();
    return;
  }

  // 2. Tapping the already-focused chip again toggles it off.
  if (alreadyOn && makeFocused && focusedSatId === satId) {
    selectedSatIds.delete(satId);
    focusedSatId = null;
    renderFocusedCard(null);
    renderPasses([]);
    await syncVisualization();
    renderSatChips();
    return;
  }

  // 3. New addition OR already-on chip re-focused.
  if (!alreadyOn) selectedSatIds.add(satId);
  if (makeFocused) focusedSatId = satId;

  await syncVisualization();

  if (makeFocused) {
    let satrec;
    try {
      satrec = parseTLE(sat.tle).satrec;
    } catch (err) {
      showToast('Bad TLE for ' + sat.name + ': ' + (err?.message || err));
      selectedSatIds.delete(satId);
      focusedSatId = null;
      await syncVisualization();
      renderSatChips();
      return;
    }
    renderFocusedCard(sat);
    computeAndRenderPasses(satrec);
    flyCameraToFocused();
    try { await putSetting('mobileFocusedSat', { satId: sat.id }); } catch (_) {}
  }

  renderSatChips();
}

/**
 * Re-create the orbit visualization for every satellite currently in
 * `selectedSatIds`, plus the ground stations. We use the desktop renderer
 * (`addSatelliteVisualization`) because mobile-side rendering was unstable
 * and the desktop version handles SCENE2D correctly.
 *
 * Desktop's `clearVisualization` removes its own ground-station entities too,
 * so we re-add ours afterwards. The mobile ground-station registry is kept
 * in a separate module-scope array so there's no cross-pollution.
 */
async function syncVisualization() {
  if (!viewer) return;

  clearVisualization(viewer);

  let firstPositions = null;
  let avgAltSum = 0;
  let avgAltCount = 0;
  for (const satId of selectedSatIds) {
    const sat = satellitesList.find((s) => s.id === satId);
    if (!sat) continue;
    try {
      // parseTLE returns { satrec, name, line1, line2 } — destructure so we
      // hand `satellite.propagate` the actual SGP4 record, not the wrapper
      // object (which would silently yield NaN positions and tank the
      // visualization on mobile while desktop, which uses destructuring
      // everywhere, kept working).
      const { satrec } = parseTLE(sat.tle);
      const result = propagateOrbit(satrec, {
        pastOrbits: 1,
        futureOrbits: 1.5,
        pointsPerOrbit: 120,
        referenceDate: referenceDate || undefined,
      });
      // Two mobile-specific options:
      //   drawGroundTrack:false — skips the clampToGround dashed line.
      //   arcType: ArcType.NONE — every regular polyline (nadir line +
      //     12 taper bands) is drawn as straight segments between
      //     samples instead of geodesic arcs. The default GEODESIC
      //     tessellation calls Cesium's generateCartesianArc, which
      //     intermittently throws "Invalid array length" on
      //     low-power-WebGL + SCENE2D-default mobile contexts and stops
      //     the entire render loop. NONE skips that code path entirely
      //     and the visual difference between straight and geodesic
      //     segments is invisible at the ~1-minute sample spacing.
      addSatelliteVisualization(
        viewer,
        sat.name,
        result.positions,
        result.info,
        { drawGroundTrack: false, arcType: Cesium.ArcType.NONE },
        sat.color,
      );
      if (!firstPositions) firstPositions = result.positions;
      if (Number.isFinite(result.info?.apogeeAlt) && Number.isFinite(result.info?.perigeeAlt)) {
        avgAltSum += (result.info.apogeeAlt + result.info.perigeeAlt) / 2;
        avgAltCount += 1;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[mobile] failed to visualize', sat.id, '\ntle:\n' + (sat.tle || '(empty)'), '\nerror:', err);
    }
  }

  // Mean altitude across every visualized satellite — drives the ground
  // station coverage-circle radius (same formula as desktop's
  // `createGroundStationVisuals`). null when nothing is visualized.
  const avgAltKm = avgAltCount > 0 ? avgAltSum / avgAltCount : null;
  if (stationsList.length > 0) addMobileGroundStations(viewer, stationsList, avgAltKm);

  if (firstPositions) setClockForPositions(firstPositions);
}

function setClockForPositions(positions) {
  if (!viewer || !Array.isArray(positions) || positions.length === 0) return;
  const start = Cesium.JulianDate.fromDate(positions[0].date);
  const stop = Cesium.JulianDate.fromDate(positions[positions.length - 1].date);
  viewer.clock.startTime = start.clone();
  viewer.clock.stopTime = stop.clone();
  viewer.clock.currentTime = referenceDate
    ? Cesium.JulianDate.fromDate(referenceDate)
    : Cesium.JulianDate.now();
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
  if (!Number.isFinite(viewer.clock.multiplier) || viewer.clock.multiplier === 0) {
    viewer.clock.multiplier = 1;
  }
  viewer.clock.shouldAnimate = true;
  viewer.scene.requestRender();
}

function computeAndRenderPasses(satrec) {
  if (stationsList.length === 0) {
    renderPasses([]);
    return;
  }
  try {
    const passes = computePasses(
      satrec,
      stationsList,
      new Date(),
      new Date(Date.now() + 24 * 3600 * 1000),
      30, // 30 s step — faster than desktop's 10 s, good enough for display
      { perAntenna: false },
    );
    renderPasses(passes.slice(0, 5));
  } catch (err) {
    renderPasses([]);
    showToast('Pass compute failed: ' + (err?.message || err));
  }
}

function flyCameraToFocused() {
  if (!viewer || !focusedSatId) return;
  const sat = satellitesList.find((s) => s.id === focusedSatId);
  if (!sat) return;
  const ent = viewer.entities.values.find((e) => e.name === sat.name);
  if (!ent || !ent.position) return;

  try {
    const cart = ent.position.getValue(viewer.clock.currentTime);
    if (!cart) return;
    const carto = Cesium.Cartographic.fromCartesian(cart);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 15_000_000),
      duration: 0.6,
    });
  } catch (_) { /* leave camera where it is */ }
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
    if (!focusedSatId) {
      empty.textContent = 'Tap a satellite to see its next passes.';
    } else if (stationsList.length === 0) {
      empty.textContent = 'No ground stations configured. Open the desktop site → Configuration → Ground Stations to add one.';
    } else {
      const n = stationsList.length;
      empty.textContent = `No passes in the next 24 hours over ${n} station${n === 1 ? '' : 's'}.`;
    }
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

// ─── Toast ────────────────────────────────────────────────────────────────

function showToast(msg) {
  const toast = document.getElementById('mToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

// Re-export for tests / debugging (no global pollution).
export const _internal = {
  get viewer() { return viewer; },
  get focusedSatId() { return focusedSatId; },
  get selectedSatIds() { return new Set(selectedSatIds); },
  get referenceDate() { return referenceDate; },
};
