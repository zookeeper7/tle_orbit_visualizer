/**
 * Orbit Viewer tab — single satellite 3D/2D visualization.
 *
 * Refactored from the original main.js. All DOM event handlers,
 * Cesium entity management, playback bar, pass schedule, and
 * ground station UI live here.
 *
 * Called once from main.js with the shared Cesium Viewer instance.
 */

import * as Cesium from 'cesium';
import { parseTLE, propagateOrbit, getOrbitalInfo, getCurrentPosition } from '../orbit.js';
import { addSatelliteVisualization, clearVisualization, createGroundStationVisuals, applySceneMode } from '../visualization.js';
import { checkConnection, fetchLatestTLE } from '../tle-fetch.js';
import { DEFAULT_STATIONS } from '../ground-stations.js';
import { computePasses } from '../pass-prediction.js';
import { getState, patch, subscribe } from '../core/app-store.js';
import { getSetting, putSetting, updateSatellite, createSatellite, deleteSatellite } from '../core/api.js';
import { classicalElementsToTLE } from '../separation-vector.js';
import { getGroupLabel, isGroupSchedulable } from '../core/groups.js';

/**
 * Initialize the Orbit Viewer tab.
 * @param {Cesium.Viewer} viewer - The shared Cesium viewer
 */
export function initOrbitViewer(viewer) {

  // ─── DOM References ───
  const ovSatSelector = document.getElementById('ovSatSelector');
  const ovFocusedSatLabel = document.getElementById('ovFocusedSatLabel');
  const ovSaveSelBtn = document.getElementById('ovSaveSelBtn');
  const ovResetSelBtn = document.getElementById('ovResetSelBtn');
  const tleInput = document.getElementById('tleInput');
  const pastOrbitsSlider = document.getElementById('pastOrbits');
  const futureOrbitsSlider = document.getElementById('futureOrbits');
  const pastVal = document.getElementById('pastVal');
  const futureVal = document.getElementById('futureVal');
  const visualizeBtn = document.getElementById('visualizeBtn');
  const errorMsg = document.getElementById('errorMsg');
  const satelliteInfo = document.getElementById('satelliteInfo');
  const infoTable = document.getElementById('infoTable');
  const togglePanel = document.getElementById('togglePanel');
  const panelContent = document.getElementById('panelContent');
  const connectionBtn = document.getElementById('connectionBtn');
  const connIndicator = document.getElementById('connIndicator');
  const connLabel = document.getElementById('connLabel');
  const fetchTleBtn = document.getElementById('fetchTleBtn');
  const connStatus = document.getElementById('connStatus');
  const pastTime = document.getElementById('pastTime');
  const futureTime = document.getElementById('futureTime');

  // Ground station DOM
  const toggleGS = document.getElementById('toggleGS');
  const gsBody = document.getElementById('gsBody');
  const gsList = document.getElementById('gsList');
  const gsExportBtn = document.getElementById('gsExportBtn');
  const trackBtn = document.getElementById('ovTrackBtn');

  // Playback bar DOM
  const pbPlayPause = document.getElementById('pbPlayPause');
  const pbIconPlay = document.getElementById('pbIconPlay');
  const pbIconPause = document.getElementById('pbIconPause');
  const pbReverse = document.getElementById('pbReverse');
  const pbStepFwd = document.getElementById('pbStepFwd');
  const pbScrubber = document.getElementById('pbScrubber');
  const pbTime = document.getElementById('pbTime');
  const pbTicks = document.getElementById('pbTicks');
  const pbSpeedBtns = document.querySelectorAll('.pb-speed');
  const pbNow = document.getElementById('pbNow');

  // Schedule panel DOM
  const toggleSchedule = document.getElementById('toggleSchedule');
  const scheduleContent = document.getElementById('scheduleContent');
  const schedCount = document.getElementById('schedCount');
  const schedBody = document.getElementById('schedBody');
  const schedEmpty = document.getElementById('schedEmpty');
  const schedTable = document.getElementById('schedTable');

  // ─── State ───
  let currentSatrec = null;
  let currentPeriodMin = 93;
  let updateInterval = null;
  let isOnline = false;
  let currentAvgAltKm = null;
  let currentPasses = [];
  let focusedSatId = null;
  /**
   * Satellite ID currently being followed by the camera. Stored as a string so
   * we can re-resolve the corresponding Cesium entity on every clock tick.
   * Storing the Entity object directly does not work: when visualize() calls
   * clearVisualization(viewer), the old Entity is removed but its
   * SampledPositionProperty still returns positions, which caused the camera
   * to keep snapping back even after the user thought tracking was off.
   * @type {string|null}
   */
  let customTrackingSatId = null;
  /** @type {Date|null} - if null, propagation uses current time (live mode) */
  let customReferenceDate = null;
  let customTrackingPrevLat = null;
  let customTrackingRange = null;
  /** @type {Set<string>} */
  let selectedSatIds = new Set();
  /** @type {Array<{id:string,name:string,color:string,tle:string,group:string,noradId?:number}>} */
  let availableSatellites = buildSatelliteListFromStore();
  let satById = buildSatById(availableSatellites);
  /** @type {Record<string, string>} */
  let tleBySatId = buildTleBySatId(availableSatellites);

  function rebuildSatelliteData() {
    availableSatellites = buildSatelliteListFromStore();
    satById = buildSatById(availableSatellites);
    // Preserve any fetched TLEs over store TLEs
    const freshTle = buildTleBySatId(availableSatellites);
    for (const id of Object.keys(freshTle)) {
      if (!tleBySatId[id]) tleBySatId[id] = freshTle[id];
    }
    // Remove deleted satellites
    for (const id of Object.keys(tleBySatId)) {
      if (!satById[id]) delete tleBySatId[id];
    }
  }

  // Ground stations
  let groundStations = toStationArray(getState().stations);
  if (groundStations.length === 0) {
    groundStations = DEFAULT_STATIONS.map((gs) => ({
      ...gs,
      antennas: Array.isArray(gs.antennas) ? gs.antennas.map((ant) => ({ ...ant })) : [],
    }));
  }

  function exportGroundStations() {
    const json = JSON.stringify(toStationArray(getState().stations), null, 2) + '\n';
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ground-stations.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Helpers ───

  function orbitsToTimeStr(orbits, periodMin) {
    const totalMin = orbits * periodMin;
    if (totalMin < 60) return `(${Math.round(totalMin)}m)`;
    const h = totalMin / 60;
    if (h < 24) return `(${h.toFixed(1)}h)`;
    const d = h / 24;
    return `(${d.toFixed(1)}d)`;
  }

  function updateTimeHints() {
    pastTime.textContent = orbitsToTimeStr(parseFloat(pastOrbitsSlider.value), currentPeriodMin);
    futureTime.textContent = orbitsToTimeStr(parseFloat(futureOrbitsSlider.value), currentPeriodMin);
  }

  function renderSatelliteSelector() {
    // Exclude non-schedulable groups from Orbit Viewer selector
    const filteredSatellites = availableSatellites.filter(s => isGroupSchedulable(s.group) && s.enabled !== false);
    const groups = filteredSatellites.reduce((acc, sat) => {
      const key = sat.group || 'other';
      if (!acc[key]) acc[key] = [];
      acc[key].push(sat);
      return acc;
    }, {});

    ovSatSelector.innerHTML = Object.entries(groups)
      .map(([group, sats]) => `
        <div class="ov-sat-group">
          <div class="ov-sat-group-title">${escapeHtml(getGroupLabel(group))}</div>
          <div class="ov-sat-list">
            ${sats.map((sat) => `
              <label class="ov-sat-item ${focusedSatId === sat.id ? 'is-focused' : ''}">
                <input type="checkbox" name="ov-sat-select" value="${sat.id}" ${selectedSatIds.has(sat.id) ? 'checked' : ''}>
                <span class="ov-sat-dot" style="--sat-color:${sat.color}"></span>
                <button type="button" class="ov-sat-name" data-sat-id="${sat.id}">${escapeHtml(sat.name)}</button>
              </label>
            `).join('')}
          </div>
        </div>
      `)
      .join('');
  }

  function focusSatellite(satId) {
    const sat = satById[satId];
    if (!sat) return;
    focusedSatId = satId;
    ovFocusedSatLabel.textContent = sat.name;
    tleInput.value = tleBySatId[satId] || sat.tle;

    try {
      const { satrec, name } = parseTLE(tleInput.value.trim());
      const info = getOrbitalInfo(satrec);
      currentSatrec = satrec;
      currentPeriodMin = info.periodMinutes;
      currentAvgAltKm = (info.apogeeAlt + info.perigeeAlt) / 2;
      updateTimeHints();
      displayOrbitalInfo(name, info, satrec);
      if (selectedSatIds.has(satId)) {
        updatePassSchedule(satrec);
        startLiveUpdates(satrec);
      }
    } catch (err) {
      showError(err.message);
    }

    // Always refresh the Track button so its label/tooltip reflect the new
    // focused satellite (even if TLE parsing above threw).
    updateTrackButton();
    renderSatelliteSelector();
  }

  // ─── Event Handlers ───

  ovSatSelector.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name !== 'ov-sat-select') return;

    if (target.checked) selectedSatIds.add(target.value);
    else selectedSatIds.delete(target.value);
    // If the user just deselected the satellite we were tracking, stop
    // tracking now so the camera does not keep snapping back. The on-tick
    // resolver will also catch this on the next frame, but doing it
    // synchronously keeps the UI honest immediately.
    if (customTrackingSatId && !selectedSatIds.has(customTrackingSatId)) {
      stopCustomTracking();
    } else {
      updateTrackButton();
    }
    renderSatelliteSelector();
  });

  ovSatSelector.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const satBtn = target.closest('.ov-sat-name');
    if (!satBtn) return;
    event.preventDefault();
    const satId = satBtn.getAttribute('data-sat-id');
    if (!satId || !satById[satId]) return;
    focusSatellite(satId);
  });

  tleInput.addEventListener('input', () => {
    if (!focusedSatId || !satById[focusedSatId]) return;
    tleBySatId[focusedSatId] = tleInput.value;
  });

  pastOrbitsSlider.addEventListener('input', () => {
    pastVal.textContent = pastOrbitsSlider.value;
    updateTimeHints();
  });
  pastOrbitsSlider.addEventListener('change', () => {
    visualize({ skipZoom: true });
  });
  futureOrbitsSlider.addEventListener('input', () => {
    futureVal.textContent = futureOrbitsSlider.value;
    updateTimeHints();
  });
  futureOrbitsSlider.addEventListener('change', () => {
    visualize({ skipZoom: true });
  });

  // ─── Reference Time control ───
  const refTimeInput = document.getElementById('ovRefTimeInput');
  const refTimeNowBtn = document.getElementById('ovRefTimeNowBtn');
  const refTimeApplyBtn = document.getElementById('ovRefTimeApplyBtn');
  const refTimeHint = document.getElementById('ovRefTimeHint');

  function formatDateForInput(date) {
    const d = date instanceof Date ? date : new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  }

  function parseRefTimeInput(value) {
    if (!value) return null;
    const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function updateRefTimeHint() {
    if (!refTimeHint) return;
    if (customReferenceDate) {
      refTimeHint.textContent = `Visualizing at ${formatDateForInput(customReferenceDate)} UTC`;
      refTimeHint.classList.add('is-active');
    } else {
      refTimeHint.textContent = 'Leave NOW for live tracking';
      refTimeHint.classList.remove('is-active');
    }
  }

  if (refTimeInput) {
    refTimeInput.value = formatDateForInput(new Date());
  }

  if (refTimeNowBtn) {
    refTimeNowBtn.addEventListener('click', () => {
      customReferenceDate = null;
      if (refTimeInput) refTimeInput.value = formatDateForInput(new Date());
      updateRefTimeHint();
      // resetClock so the playhead jumps to "now" — this is an explicit
      // user-initiated time switch, unlike the implicit visualize() calls
      // from slider drags or auto-refresh.
      visualize({ skipZoom: true, resetClock: true });
    });
  }

  if (refTimeApplyBtn) {
    refTimeApplyBtn.addEventListener('click', () => {
      const parsed = parseRefTimeInput(refTimeInput?.value);
      if (!parsed) {
        refTimeInput?.focus();
        return;
      }
      customReferenceDate = parsed;
      updateRefTimeHint();
      // resetClock: jump the playhead to the chosen reference time.
      visualize({ skipZoom: true, resetClock: true });
    });
  }

  if (refTimeInput) {
    refTimeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        refTimeApplyBtn?.click();
      }
    });
  }

  // ─── Interactive Keplerian Satellite ───
  const INT_SAT_ID = 'interactive_kep';
  const INT_SAT_NAME = 'Interactive Keplerian';
  const INT_SAT_COLOR = '#fbbf24';
  const INT_SAT_NORAD = 90001;
  const INT_DEFAULTS = { a: 6778, e: 0.0001, i: 51.64, raan: 100, argp: 0, nu: 0 };

  const intSliderEls = {
    a: document.getElementById('ovIntASlider'),
    e: document.getElementById('ovIntESlider'),
    i: document.getElementById('ovIntISlider'),
    raan: document.getElementById('ovIntRaanSlider'),
    argp: document.getElementById('ovIntArgpSlider'),
    nu: document.getElementById('ovIntNuSlider'),
  };
  const intNumEls = {
    a: document.getElementById('ovIntAInput'),
    e: document.getElementById('ovIntEInput'),
    i: document.getElementById('ovIntIInput'),
    raan: document.getElementById('ovIntRaanInput'),
    argp: document.getElementById('ovIntArgpInput'),
    nu: document.getElementById('ovIntNuInput'),
  };
  const intCreateBtn = document.getElementById('ovIntCreateBtn');
  const intResetBtn = document.getElementById('ovIntResetBtn');
  const intRemoveBtn = document.getElementById('ovIntRemoveBtn');
  const intStatus = document.getElementById('ovIntStatus');
  const intStateLabel = document.getElementById('ovIntStateLabel');

  function intReadElements() {
    return {
      a: Number(intNumEls.a.value),
      e: Number(intNumEls.e.value),
      i: Number(intNumEls.i.value),
      raan: Number(intNumEls.raan.value),
      argp: Number(intNumEls.argp.value),
      nu: Number(intNumEls.nu.value),
    };
  }

  function intSetElements(vals) {
    for (const key of Object.keys(vals)) {
      const v = String(vals[key]);
      if (intNumEls[key]) intNumEls[key].value = v;
      if (intSliderEls[key]) intSliderEls[key].value = v;
    }
  }

  function intShowStatus(text, kind = '') {
    if (!intStatus) return;
    intStatus.textContent = text || '';
    intStatus.classList.remove('is-success', 'is-error');
    if (kind) intStatus.classList.add(kind);
  }

  function intIsActive() {
    return Boolean(getState().satellites?.[INT_SAT_ID]);
  }

  function intUpdateStateLabel() {
    if (!intStateLabel) return;
    if (intIsActive()) {
      intStateLabel.textContent = 'Active';
      intStateLabel.classList.add('ov-int-state-active');
    } else {
      intStateLabel.textContent = 'Inactive';
      intStateLabel.classList.remove('ov-int-state-active');
    }
    if (intRemoveBtn) intRemoveBtn.disabled = !intIsActive();
  }

  /** Synchronize slider <-> number input for one element key */
  // Throttle state for real-time (no-persist) updates during drag
  /** @type {ReturnType<typeof setTimeout>|null} */
  let intLiveTimer = null;
  let intLivePending = false;
  const INT_LIVE_THROTTLE_MS = 50; // ~20 fps cap during drag

  function intScheduleLive() {
    intLivePending = true;
    if (intLiveTimer) return; // already armed; will pick up latest values when it fires
    intLiveTimer = setTimeout(() => {
      intLiveTimer = null;
      if (!intLivePending) return;
      intLivePending = false;
      intApply({ persist: false });
    }, INT_LIVE_THROTTLE_MS);
  }

  function intCancelLive() {
    if (intLiveTimer) { clearTimeout(intLiveTimer); intLiveTimer = null; }
    intLivePending = false;
  }

  function intWireSync(key) {
    const slider = intSliderEls[key];
    const num = intNumEls[key];
    if (!slider || !num) return;

    // While dragging the slider — live preview without DB write (throttled)
    slider.addEventListener('input', () => {
      num.value = slider.value;
      intScheduleLive();
    });
    // When user releases the slider — persist to DB
    slider.addEventListener('change', () => {
      num.value = slider.value;
      intCancelLive();
      intApply({ persist: true });
    });

    // Number input — live preview while typing, persist on commit
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (!Number.isFinite(v)) return;
      slider.value = String(v);
      intScheduleLive();
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (!Number.isFinite(v)) return;
      // Clamp to slider range so the slider stays in sync
      const min = Number(slider.min);
      const max = Number(slider.max);
      const clamped = Math.max(min, Math.min(max, v));
      slider.value = String(clamped);
      num.value = String(clamped);
      intCancelLive();
      intApply({ persist: true });
    });
  }
  for (const key of Object.keys(intSliderEls)) intWireSync(key);

  /**
   * Apply the current slider/number values to the interactive satellite.
   *
   * @param {{ persist?: boolean }} [opts] - persist=true (default) writes the
   *   change to the server DB via createSatellite/updateSatellite; persist=false
   *   only updates the in-memory store + visualization (used during slider drag
   *   for real-time preview).
   */
  async function intApply(opts = {}) {
    const persist = opts.persist !== false;
    if (persist) intShowStatus('Applying…');

    try {
      const vals = intReadElements();
      if (!(vals.a > 6378.137)) throw new Error('Semi-major axis must be > 6378.137 km.');
      if (!(vals.e >= 0 && vals.e < 1)) throw new Error('Eccentricity must be in [0, 1).');

      // Use Reference Time if set, otherwise current time, so the epoch matches what the viewer
      // is propagating to.
      const epoch = (customReferenceDate instanceof Date && !Number.isNaN(customReferenceDate.getTime()))
        ? new Date(customReferenceDate.getTime())
        : new Date();

      const { tle, elements } = classicalElementsToTLE({
        aKm: vals.a,
        e: vals.e,
        iDeg: vals.i,
        raanDeg: vals.raan,
        argpDeg: vals.argp,
        trueAnomalyDeg: vals.nu,
        utcDate: epoch,
        options: { name: INT_SAT_NAME.toUpperCase(), noradId: INT_SAT_NORAD, intlDesignator: '90001A  ', bstar: 0 },
      });

      const exists = intIsActive();
      const payload = {
        id: INT_SAT_ID,
        name: INT_SAT_NAME,
        noradId: INT_SAT_NORAD,
        groupName: 'custom',
        color: INT_SAT_COLOR,
        enabled: true,
        tleLine0: INT_SAT_NAME,
        tleLine1: tle.line1,
        tleLine2: tle.line2,
      };

      // DB write — only on persist path (drag end / button / typed commit)
      if (persist) {
        if (exists) await updateSatellite(INT_SAT_ID, payload);
        else await createSatellite(payload);
      }

      // Build the in-memory store representation matching loadSatellitesIntoStore's shape
      const storeEntry = {
        id: INT_SAT_ID,
        name: INT_SAT_NAME,
        noradId: INT_SAT_NORAD,
        groupName: 'custom',
        tle: tle.threeLine,
        tleLine0: INT_SAT_NAME,
        tleLine1: tle.line1,
        tleLine2: tle.line2,
        color: INT_SAT_COLOR,
        enabled: true,
      };

      // Force the TLE override map to use the freshly generated TLE.
      // The existing rebuildSatelliteData only seeds tleBySatId for missing IDs, so we must
      // explicitly overwrite to make the new orbit visible immediately.
      tleBySatId[INT_SAT_ID] = tle.threeLine;

      patch('satellites', (current) => {
        current[INT_SAT_ID] = storeEntry;
        return current;
      });

      // Make sure the interactive sat is selected so visualize() draws it
      selectedSatIds.add(INT_SAT_ID);
      // Refresh in-memory caches and re-render
      rebuildSatelliteData();
      tleBySatId[INT_SAT_ID] = tle.threeLine; // rebuild may overwrite if it was missing
      renderSatelliteSelector();
      visualize({ skipZoom: true });

      const periodStr = elements.periodMin.toFixed(2);
      const altMean = (elements.a - 6378.137).toFixed(0);
      if (persist) {
        intShowStatus(`Updated · alt ~${altMean} km · period ${periodStr} min`, 'is-success');
      } else {
        intShowStatus(`Live preview · alt ~${altMean} km · period ${periodStr} min`);
      }
      intUpdateStateLabel();
    } catch (err) {
      // During live preview, validation errors are common while user is mid-drag —
      // show them but don't log to console as if they were real failures.
      if (persist) console.error('Interactive orbit apply failed:', err);
      intShowStatus(err instanceof Error ? err.message : 'Failed to apply.', 'is-error');
    }
  }

  async function intRemove() {
    if (!intIsActive()) return;
    intShowStatus('Removing…');
    try {
      await deleteSatellite(INT_SAT_ID);
      delete tleBySatId[INT_SAT_ID];
      selectedSatIds.delete(INT_SAT_ID);
      patch('satellites', (current) => {
        delete current[INT_SAT_ID];
        return current;
      });
      rebuildSatelliteData();
      renderSatelliteSelector();
      visualize({ skipZoom: true });
      intShowStatus('Removed.', 'is-success');
      intUpdateStateLabel();
    } catch (err) {
      console.error('Interactive orbit remove failed:', err);
      intShowStatus(err instanceof Error ? err.message : 'Failed to remove.', 'is-error');
    }
  }

  function intReset() {
    intSetElements(INT_DEFAULTS);
    intApply();
  }

  if (intCreateBtn) intCreateBtn.addEventListener('click', intApply);
  if (intResetBtn) intResetBtn.addEventListener('click', intReset);
  if (intRemoveBtn) intRemoveBtn.addEventListener('click', intRemove);

  // On load, if a previously-saved interactive sat exists, sync sliders to its elements
  // so the user sees the persisted state instead of the defaults.
  function intSyncFromStore() {
    const sat = getState().satellites?.[INT_SAT_ID];
    if (!sat) { intUpdateStateLabel(); return; }
    // Try to read the elements back out of the stored TLE by re-parsing it
    try {
      const parsed = parseTLE(sat.tle || `${sat.tleLine0}\n${sat.tleLine1}\n${sat.tleLine2}`);
      const info = getOrbitalInfo(parsed.satrec);
      // SGP4 mean motion -> semi-major axis via n^2 a^3 = mu
      const MU = 398600.4418;
      const nRadSec = (parsed.satrec.no || 0) / 60; // satrec.no is rev per minute in radians? actually rad/min
      // satellite.js stores satrec.no in radians per minute. Convert to rad/s:
      const nRadPerSec = (parsed.satrec.no_kozai || parsed.satrec.no) / 60;
      const aKm = nRadPerSec > 0 ? Math.cbrt(MU / (nRadPerSec * nRadPerSec)) : INT_DEFAULTS.a;
      const e = parsed.satrec.ecco;
      const RAD2DEG = 180 / Math.PI;
      const iDeg = parsed.satrec.inclo * RAD2DEG;
      const raanDeg = parsed.satrec.nodeo * RAD2DEG;
      const argpDeg = parsed.satrec.argpo * RAD2DEG;
      const Mdeg = parsed.satrec.mo * RAD2DEG;
      // Mean anomaly -> true anomaly (solve Kepler iteratively)
      const M = parsed.satrec.mo;
      let E = M;
      for (let k = 0; k < 30; k++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
      const nuDeg = ((nu * RAD2DEG) + 360) % 360;
      intSetElements({
        a: Number(aKm.toFixed(3)),
        e: Number(e.toFixed(6)),
        i: Number(iDeg.toFixed(3)),
        raan: Number(raanDeg.toFixed(3)),
        argp: Number(argpDeg.toFixed(3)),
        nu: Number(nuDeg.toFixed(3)),
      });
    } catch { /* keep defaults */ }
    intUpdateStateLabel();
  }
  intSyncFromStore();
  subscribe('satellites', intUpdateStateLabel);

  togglePanel.addEventListener('click', () => {
    panelContent.classList.toggle('collapsed');
  });

  connectionBtn.addEventListener('click', async () => {
    setConnectionState('checking');
    const online = await checkConnection();
    isOnline = online;
    setConnectionState(online ? 'online' : 'offline');
  });

  fetchTleBtn.addEventListener('click', async () => {
    const sat = focusedSatId ? satById[focusedSatId] : null;

    if (!sat || !sat.noradId) {
      showConnStatus('Select a satellite with a NORAD ID first.', 'error');
      return;
    }

    fetchTleBtn.classList.add('loading');
    fetchTleBtn.textContent = 'Fetching\u2026';
    showConnStatus(`Fetching latest TLE for ${sat.name}\u2026`, 'info');

    try {
      const tle = await fetchLatestTLE(Number(sat.noradId));
      tleBySatId[sat.id] = tle;
      if (focusedSatId === sat.id) {
        tleInput.value = tle;
      }

      // Persist to server DB so Schedule Manager and other tabs use the same TLE
      const tleLines = tle.split('\n').map(l => l.trim()).filter(Boolean);
      const tleLine1 = tleLines.find(l => l.startsWith('1 ')) || '';
      const tleLine2 = tleLines.find(l => l.startsWith('2 ')) || '';
      const tleLine0 = tleLines[0] && tleLines[0] !== tleLine1 && tleLines[0] !== tleLine2 ? tleLines[0] : '';
      if (tleLine1 && tleLine2) {
        try {
          await updateSatellite(sat.id, {
            id: sat.id,
            name: sat.name,
            noradId: Number(sat.noradId),
            groupName: sat.group || sat.groupName || '',
            color: sat.color || '#7dd3fc',
            enabled: sat.enabled !== false,
            tleLine0,
            tleLine1,
            tleLine2,
          });
          // Update only this satellite in the store (no full replace)
          patch('satellites', (current) => {
            if (current[sat.id]) {
              current[sat.id] = {
                ...current[sat.id],
                tleLine0,
                tleLine1,
                tleLine2,
                tle: [tleLine0, tleLine1, tleLine2].filter(Boolean).join('\n'),
              };
            }
            return current;
          });
        } catch (dbErr) {
          console.warn('TLE fetched but failed to save to DB:', dbErr);
        }
      }

      // resetClock so the playhead jumps to "now" (or the custom reference
      // time) — the camera ends up on the satellite's REAL current
      // location, not wherever the playhead happened to be sitting when
      // Fetch was clicked.
      //
      // autoTrackFocused so the user lands on a clear "follow the
      // satellite" view (sub-satellite point lookAt with the Track
      // button highlighted) instead of an ambiguous mid-distance zoom.
      // The user can still drag the globe to release tracking or click
      // Track again to toggle it off.
      visualize({ resetClock: true, autoTrackFocused: true });
      showConnStatus(`Latest TLE loaded for ${sat.name} — tracking enabled`, 'success');
    } catch (err) {
      showConnStatus(err.message, 'error');
    } finally {
      fetchTleBtn.classList.remove('loading');
      fetchTleBtn.textContent = 'Fetch Latest TLE';
    }
  });

  visualizeBtn.addEventListener('click', () => {
    visualize();
  });

  // ─── Collapsible Sections ───
  const ovSection = document.getElementById('tab-orbit-viewer');
  (ovSection || document).querySelectorAll('.ov-section-toggle[data-ov-collapse]').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const targetId = toggle.getAttribute('data-ov-collapse');
      const body = document.getElementById(targetId);
      if (!body) return;
      const collapsed = !body.classList.contains('is-hidden');
      body.classList.toggle('is-hidden', collapsed);
      toggle.classList.toggle('is-collapsed', collapsed);
    });
  });

  // ─── Track Button ───
  if (trackBtn) {
    trackBtn.addEventListener('click', () => {
      // If the focused satellite is already the one being tracked → stop tracking.
      if (customTrackingSatId && customTrackingSatId === focusedSatId) {
        stopCustomTracking();
        return;
      }
      // If there is no focused selectable satellite, just stop whatever was being tracked.
      if (!focusedSatId || !satById[focusedSatId] || !selectedSatIds.has(focusedSatId)) {
        if (customTrackingSatId) stopCustomTracking();
        return;
      }
      // Otherwise: switch tracking to the currently focused satellite
      // (replacing any previous tracking target).
      const sat = satById[focusedSatId];
      const entity = viewer.entities.values.find((e) => e.name === sat.name);
      if (entity) startCustomTracking(focusedSatId, entity);
    });
  }

  /**
   * Refresh the Track button label/state to reflect the relationship between
   * the currently focused satellite and the tracking target. Three states:
   *  - Focused satellite IS the tracked one → "◉ Tracking" (click to stop)
   *  - Focused satellite is NOT the tracked one (but something else is tracked)
   *      → "◎ Track" with a tooltip explaining the current tracking target
   *  - Nothing tracked → "◎ Track"
   */
  function updateTrackButton() {
    if (!trackBtn) return;
    const focusedSat = focusedSatId ? satById[focusedSatId] : null;
    const hasFocus = !!(focusedSat && selectedSatIds.has(focusedSatId));
    const trackedSat = customTrackingSatId ? satById[customTrackingSatId] : null;
    const isFocusedTracked = hasFocus && customTrackingSatId === focusedSatId;

    // Button is enabled whenever any action is possible:
    //  - has focus → can start/switch tracking
    //  - is currently tracking → can stop
    trackBtn.disabled = !hasFocus && !customTrackingSatId;

    if (isFocusedTracked) {
      trackBtn.classList.add('is-tracking');
      trackBtn.textContent = '◉ Tracking';
      trackBtn.title = `Currently tracking ${focusedSat.name}. Click to stop.`;
    } else if (customTrackingSatId && hasFocus) {
      // Tracking a satellite that is not the focused one
      trackBtn.classList.remove('is-tracking');
      trackBtn.textContent = '◎ Track';
      const tn = trackedSat ? trackedSat.name : 'another satellite';
      trackBtn.title = `Currently tracking ${tn}. Click to switch to ${focusedSat.name}.`;
    } else if (customTrackingSatId && !hasFocus) {
      // Tracking continues even though no focus is set (rare). Indicate it.
      trackBtn.classList.add('is-tracking');
      trackBtn.textContent = '◉ Tracking';
      trackBtn.title = `Currently tracking ${trackedSat ? trackedSat.name : 'a satellite'}. Click to stop.`;
    } else {
      trackBtn.classList.remove('is-tracking');
      trackBtn.textContent = '◎ Track';
      trackBtn.title = hasFocus ? `Track ${focusedSat.name}` : 'Focus a selected satellite to track it';
    }
  }

  // ─── Auto Refresh TLE ───
  const autoRefreshBtn = document.getElementById('autoRefreshBtn');
  const autoRefreshLabel = document.getElementById('autoRefreshLabel');
  const autoRefreshInterval = document.getElementById('autoRefreshInterval');
  const autoRefreshStatus = document.getElementById('autoRefreshStatus');
  let autoRefreshTimer = null;

  if (autoRefreshBtn) {
    autoRefreshBtn.addEventListener('click', () => {
      if (autoRefreshTimer) {
        stopAutoRefresh();
      } else {
        startAutoRefresh();
      }
    });
  }

  function startAutoRefresh() {
    if (autoRefreshTimer) return;
    const intervalSec = Number(autoRefreshInterval?.value || 3600);
    autoRefreshBtn.classList.add('is-active');
    if (autoRefreshLabel) autoRefreshLabel.textContent = 'Auto Refresh: On';
    if (autoRefreshInterval) autoRefreshInterval.disabled = true;
    updateAutoRefreshStatus('Starting…');
    doAutoFetchAll();
    autoRefreshTimer = setInterval(() => doAutoFetchAll(), intervalSec * 1000);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    autoRefreshBtn.classList.remove('is-active');
    if (autoRefreshLabel) autoRefreshLabel.textContent = 'Auto Refresh: Off';
    if (autoRefreshInterval) autoRefreshInterval.disabled = false;
    updateAutoRefreshStatus('');
  }

  function updateAutoRefreshStatus(text) {
    if (autoRefreshStatus) autoRefreshStatus.textContent = text;
  }

  async function doAutoFetchAll() {
    const satellites = Object.values(getState().satellites || {})
      .filter((s) => s?.enabled !== false && Number.isFinite(Number(s?.noradId)));
    if (satellites.length === 0) {
      updateAutoRefreshStatus('No satellites');
      return;
    }
    updateAutoRefreshStatus(`Fetching ${satellites.length}…`);
    let ok = 0;
    let fail = 0;
    for (const sat of satellites) {
      try {
        const tle = await fetchLatestTLE(Number(sat.noradId));
        const tleLines = tle.split('\n').map((l) => l.trim()).filter(Boolean);
        const tleLine1 = tleLines.find((l) => l.startsWith('1 ')) || '';
        const tleLine2 = tleLines.find((l) => l.startsWith('2 ')) || '';
        const tleLine0 = tleLines[0] && tleLines[0] !== tleLine1 && tleLines[0] !== tleLine2 ? tleLines[0] : '';
        if (tleLine1 && tleLine2) {
          await updateSatellite(sat.id, {
            id: sat.id, name: sat.name, noradId: Number(sat.noradId),
            groupName: sat.group || sat.groupName || '',
            color: sat.color || '#7dd3fc', enabled: sat.enabled !== false,
            tleLine0, tleLine1, tleLine2,
          });
          patch('satellites', (current) => {
            if (current[sat.id]) {
              current[sat.id] = { ...current[sat.id], tleLine0, tleLine1, tleLine2,
                tle: [tleLine0, tleLine1, tleLine2].filter(Boolean).join('\n') };
            }
            return current;
          });
          ok++;
        } else { fail++; }
      } catch { fail++; }
    }
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    updateAutoRefreshStatus(`${hh}:${mm} UTC · ${ok}ok${fail > 0 ? ` ${fail}fail` : ''}`);

    // Re-visualize to refresh orbit trails and pass schedule with updated TLEs
    if (ok > 0) {
      rebuildSatelliteData();
      visualize({ skipZoom: true });
    }
  }

  // ─── Ground Station UI Handlers ───

  toggleGS.addEventListener('click', () => {
    gsBody.classList.toggle('collapsed');
    toggleGS.textContent = gsBody.classList.contains('collapsed') ? '\u25B8' : '\u25BE';
  });

  gsExportBtn.addEventListener('click', () => {
    exportGroundStations();
  });

  // ─── Schedule Panel Toggle ───
  toggleSchedule.addEventListener('click', () => {
    scheduleContent.classList.toggle('collapsed');
  });

  // ─── Ground Station Rendering ───

  function renderStationList() {
    gsList.innerHTML = groundStations
      .map(
        gs => `
        <div class="gs-item" data-id="${gs.id}">
          <div class="gs-item-head">
            <div class="gs-item-info">
              <span class="gs-item-name">${escapeHtml(gs.name)} <span class="gs-antenna-badge">${(gs.antennas || []).length} ant</span></span>
              <span class="gs-item-detail">${gs.lat.toFixed(4)}\u00B0, ${gs.lon.toFixed(4)}\u00B0 \u00B7 ${gs.minElevDeg}\u00B0</span>
            </div>
          </div>
          <details class="gs-antenna-details">
            <summary>Antenna Details</summary>
            <div class="gs-antenna-list">
              ${(gs.antennas || []).map((ant) => `
                <div class="gs-antenna-item">
                  <span class="gs-antenna-name">${escapeHtml(ant.name || ant.id)}</span>
                  <span class="gs-antenna-type">${escapeHtml(ant.type || '—')}</span>
                </div>
              `).join('') || '<div class="gs-antenna-empty">No antennas configured</div>'}
            </div>
          </details>
        </div>`,
      )
      .join('');
  }

  function renderGroundStations() {
    createGroundStationVisuals(viewer, groundStations, currentAvgAltKm);
  }

  // Station data is now managed in Configuration tab

  // ─── Pass Schedule Rendering ───

  const _pad2 = (n) => String(n).padStart(2, '0');

  function fmtTimeShort(d) {
    return `${_pad2(d.getUTCMonth() + 1)}/${_pad2(d.getUTCDate())} ` +
           `${_pad2(d.getUTCHours())}:${_pad2(d.getUTCMinutes())}:${_pad2(d.getUTCSeconds())}`;
  }

  function fmtDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${_pad2(s)}`;
  }

  function fmtDelta(deltaSec) {
    const abs = Math.abs(deltaSec);
    if (abs < 60) return `${Math.round(abs)}s`;
    if (abs < 3600) return `${Math.floor(abs / 60)}m ${Math.round(abs % 60)}s`;
    const h = Math.floor(abs / 3600);
    const m = Math.round((abs % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  /**
   * Compute pass schedule for all active satellites and render in the right panel.
   * @param {object|null} singleSatrec — if provided, compute only for this (legacy single mode)
   */
  /**
   * Get the set of station IDs that have at least one antenna mapped to this satellite.
   * If satellite has no mappings at all, fall back to all stations (graceful degradation).
   */
  function getMappedStationIds(satelliteId) {
    const mappings = getState().antennaMappings || [];
    const antennas = getState().antennas || {};
    const stationIds = new Set();
    for (const m of mappings) {
      if (m.satelliteId !== satelliteId) continue;
      const ant = antennas[m.antennaId];
      if (ant?.stationId) stationIds.add(ant.stationId);
    }
    return stationIds;
  }

  function filterStationsForSatellite(satelliteId) {
    const mapped = getMappedStationIds(satelliteId);
    if (mapped.size === 0) return groundStations; // no mappings → show all (fallback)
    return groundStations.filter((gs) => mapped.has(gs.id));
  }

  function updatePassSchedule(singleSatrec) {
    const startDate = Cesium.JulianDate.toDate(viewer.clock.startTime);
    const stopDate = Cesium.JulianDate.toDate(viewer.clock.stopTime);

    // Compute passes only for stations mapped to each satellite via Configuration
    currentPasses = [];
    if (singleSatrec && selectedSatIds.size <= 1) {
      // Single satellite mode
      const satId = focusedSatId || '';
      const name = satId ? (satById[satId]?.name || '') : '';
      const color = satId ? (satById[satId]?.color || '#7dd3fc') : '#7dd3fc';
      const passes = computePasses(singleSatrec, groundStations, startDate, stopDate, 10, { perAntenna: false });
      for (const p of passes) {
        p.satelliteName = name;
        p.satelliteColor = color;
      }
      currentPasses = passes;
    } else {
      // Multi-satellite mode
      for (const satId of selectedSatIds) {
        const sat = satById[satId];
        if (!sat) continue;
        const tleText = (tleBySatId[satId] || sat.tle || '').trim();
        if (!tleText) continue;
        try {
          const { satrec } = parseTLE(tleText);
          const passes = computePasses(satrec, groundStations, startDate, stopDate, 10, { perAntenna: false });
          for (const p of passes) {
            p.satelliteName = sat.name;
            p.satelliteColor = sat.color;
          }
          currentPasses.push(...passes);
        } catch { /* skip invalid TLE */ }
      }
      currentPasses.sort((a, b) => a.aos.getTime() - b.aos.getTime());
    }

    schedCount.textContent = currentPasses.length;

    if (currentPasses.length === 0) {
      schedTable.style.display = 'none';
      schedEmpty.style.display = '';
      return;
    }

    schedTable.style.display = '';
    schedEmpty.style.display = 'none';

    schedBody.innerHTML = currentPasses.map((p, i) => {
      const elClass = p.maxElDeg >= 60 ? 'el-high' : p.maxElDeg >= 30 ? 'el-mid' : '';
      return `<tr data-idx="${i}">` +
        `<td style="color:${p.satelliteColor || 'var(--accent)'}">${escapeHtml(p.satelliteName || '—')}</td>` +
        `<td>${p.stationName}</td>` +
        `<td>${fmtTimeShort(p.aos)}<span class="pass-rel" data-col="aos"></span></td>` +
        `<td>${fmtTimeShort(p.los)}<span class="pass-rel" data-col="los"></span></td>` +
        `<td>${fmtDuration(p.durationSec)}</td>` +
        `<td class="${elClass}">${p.maxElDeg.toFixed(1)}\u00B0</td>` +
        `</tr>`;
    }).join('');

    // Attach row click → jump to AOS + fly to ground station
    schedBody.querySelectorAll('tr').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx, 10);
        const pass = currentPasses[idx];
        if (!pass) return;

        const jumpMs = pass.aos.getTime() - 30000;
        const clampedMs = Math.max(
          Cesium.JulianDate.toDate(viewer.clock.startTime).getTime(),
          Math.min(jumpMs, Cesium.JulianDate.toDate(viewer.clock.stopTime).getTime()),
        );
        viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(clampedMs));

        const gs = groundStations.find(s => s.id === pass.stationId);
        if (gs) {
          viewer.trackedEntity = undefined;
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(gs.lon, gs.lat, currentAvgAltKm ? currentAvgAltKm * 4000 : 3000000),
            orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
            duration: 1.5,
          });
        }
      });
    });

    updatePassRowStyles();
  }

  function updatePassRowStyles() {
    if (currentPasses.length === 0) return;

    const nowMs = Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
    const rows = schedBody.querySelectorAll('tr');

    for (let i = 0; i < rows.length; i++) {
      const p = currentPasses[i];
      if (!p) continue;

      const aosMs = p.aos.getTime();
      const losMs = p.los.getTime();
      const row = rows[i];

      row.classList.remove('pass-past', 'pass-active');

      const aosRel = row.querySelector('.pass-rel[data-col="aos"]');
      const losRel = row.querySelector('.pass-rel[data-col="los"]');

      if (nowMs > losMs) {
        row.classList.add('pass-past');
        const ago = (nowMs - losMs) / 1000;
        if (aosRel) { aosRel.textContent = ''; aosRel.className = 'pass-rel'; }
        if (losRel) { losRel.textContent = fmtDelta(ago) + ' ago'; losRel.className = 'pass-rel rel-past'; }
      } else if (nowMs >= aosMs && nowMs <= losMs) {
        row.classList.add('pass-active');
        const elapsed = (nowMs - aosMs) / 1000;
        const remaining = (losMs - nowMs) / 1000;
        if (aosRel) { aosRel.textContent = fmtDelta(elapsed) + ' ago'; aosRel.className = 'pass-rel rel-active'; }
        if (losRel) { losRel.textContent = 'in ' + fmtDelta(remaining); losRel.className = 'pass-rel rel-active'; }
      } else {
        const until = (aosMs - nowMs) / 1000;
        if (aosRel) { aosRel.textContent = 'in ' + fmtDelta(until); aosRel.className = 'pass-rel rel-future'; }
        if (losRel) { losRel.textContent = ''; losRel.className = 'pass-rel'; }
      }
    }
  }

  // ─── Connection Helpers ───

  function setConnectionState(s) {
    connIndicator.classList.remove('online', 'offline', 'checking');
    connectionBtn.classList.remove('checking');

    switch (s) {
      case 'checking':
        connIndicator.classList.add('checking');
        connectionBtn.classList.add('checking');
        connLabel.textContent = 'Checking\u2026';
        fetchTleBtn.disabled = true;
        showConnStatus('Checking internet connection\u2026', 'info');
        break;
      case 'online':
        connIndicator.classList.add('online');
        connLabel.textContent = 'Connected';
        fetchTleBtn.disabled = false;
        showConnStatus('Online \u2014 CelesTrak reachable', 'success');
        break;
      case 'offline':
        connIndicator.classList.add('offline');
        connLabel.textContent = 'Offline';
        fetchTleBtn.disabled = true;
        showConnStatus('Cannot reach CelesTrak \u2014 check your internet', 'error');
        break;
    }
  }

  function showConnStatus(msg, type) {
    connStatus.textContent = msg;
    connStatus.className = `conn-status ${type}`;
    connStatus.style.display = 'block';
  }

  // ─── Core Logic ───

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
  }

  function hideError() {
    errorMsg.style.display = 'none';
  }

  function visualize(options = {}) {
    const skipZoom = options.skipZoom === true;
    // resetClock: force the playhead to jump to the (custom reference time or
    // wall-clock now), regardless of whether the previous position falls in
    // the new window. Used by explicit time-jump actions like Reference Time
    // Apply / NOW; everywhere else we want to preserve the user's position.
    const resetClock = options.resetClock === true;
    // autoTrackFocused: when visualizing a single satellite, automatically
    // attach the camera tracker even if the user wasn't already tracking.
    // Used by Fetch Latest TLE so the user lands on a clear "follow the
    // satellite" view instead of an ambiguous mid-distance zoom.
    const autoTrackFocused = options.autoTrackFocused === true;
    hideError();

    const satIds = Array.from(selectedSatIds);
    if (satIds.length === 0) {
      showError('Select at least one satellite to visualize.');
      return;
    }

    try {
      const pastOrbits = parseFloat(pastOrbitsSlider.value);
      const futureOrbits = parseFloat(futureOrbitsSlider.value);

      const pointsPerOrbit = satIds.length > 20 ? 40 : satIds.length > 10 ? 60 : 120;
      clearVisualization(viewer);

      const entities = [];
      let minStart = null;
      let maxStop = null;
      /** @type {Array<number>} */
      const avgAltList = [];

      for (const satId of satIds) {
        const sat = satById[satId];
        if (!sat) continue;

        const tleText = (tleBySatId[satId] || sat.tle || '').trim();
        if (!tleText) continue;

        const { satrec, name } = parseTLE(tleText);
        const { positions, info } = propagateOrbit(satrec, {
          pastOrbits,
          futureOrbits,
          pointsPerOrbit,
          referenceDate: customReferenceDate,
        });

        const entity = addSatelliteVisualization(viewer, name, positions, info, {
          pastOrbits,
          futureOrbits,
        }, sat.color);

        entities.push(entity);
        avgAltList.push((info.apogeeAlt + info.perigeeAlt) / 2);

        const startMs = positions[0]?.date?.getTime();
        const stopMs = positions[positions.length - 1]?.date?.getTime();
        if (Number.isFinite(startMs)) minStart = minStart === null ? startMs : Math.min(minStart, startMs);
        if (Number.isFinite(stopMs)) maxStop = maxStop === null ? stopMs : Math.max(maxStop, stopMs);

        if (satId === focusedSatId) {
          currentSatrec = satrec;
          currentPeriodMin = info.periodMinutes;
          displayOrbitalInfo(name, info, satrec);
          startLiveUpdates(satrec);
        }
      }

      currentAvgAltKm = avgAltList.length > 0
        ? avgAltList.reduce((sum, v) => sum + v, 0) / avgAltList.length
        : null;
      updateTimeHints();

      if (minStart !== null && maxStop !== null && maxStop > minStart) {
        viewer.clock.startTime = Cesium.JulianDate.fromDate(new Date(minStart));
        viewer.clock.stopTime = Cesium.JulianDate.fromDate(new Date(maxStop));

        // Preserve the user's current clock position when it still falls
        // inside the new visualization window. Otherwise (or when an explicit
        // time-jump is requested via resetClock) fall back to the custom
        // reference time or wall-clock now. This stops Interactive Orbit
        // drags / Auto Refresh / Past-Future slider changes from jerking the
        // playhead back to "now" while the user is mid-playback.
        const prevMs = viewer.clock.currentTime
          ? Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime()
          : NaN;
        const fallbackMs = customReferenceDate instanceof Date && !Number.isNaN(customReferenceDate.getTime())
          ? customReferenceDate.getTime()
          : Date.now();
        const canPreserve = !resetClock && Number.isFinite(prevMs) && prevMs >= minStart && prevMs <= maxStop;
        const targetMs = canPreserve
          ? prevMs
          : Math.max(minStart, Math.min(fallbackMs, maxStop));
        viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(targetMs));

        viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
        // NOTE: do NOT touch viewer.clock.multiplier here. Resetting it to 1
        // on every re-visualize was desyncing the speed-button UI (which
        // still showed 10x/60x/360x) from the actual playback rate.
        viewer.clock.shouldAnimate = true;
      }

      renderGroundStations();
      buildTimelineTicks();

      // Compute pass schedule for ALL active satellites
      updatePassSchedule(null);

      if (!skipZoom) {
        viewer.trackedEntity = undefined;
        if (entities.length === 1) {
          // Resolve sat ID from the entity name (set by
          // addSatelliteVisualization). Three camera options when only
          // one satellite is in the scene:
          //   (a) Tracking was already active for THIS satellite (e.g.
          //       user had clicked Track before triggering a
          //       re-visualize via Auto Refresh / slider drag) →
          //       re-attach the camera to the freshly-built entity so
          //       tracking stays continuous.
          //   (b) Caller passed autoTrackFocused (e.g. Fetch Latest
          //       TLE) → start tracking unconditionally so the user
          //       lands on a clear "follow the satellite" view instead
          //       of an ambiguous mid-distance zoom.
          //   (c) Neither (Visualize All / Reset) → fly to Cesium's
          //       default home view so the whole globe and the full
          //       orbit trail stay visible, exactly like the
          //       multi-satellite case below. The old zoomTo() framed a
          //       single satellite's (near-point) entity bounding sphere,
          //       dropping the camera into an ambiguous close-up where
          //       the orbit was not visible and no tracking was active.
          const onlyEntity = entities[0];
          const onlySatId = Object.keys(satById).find((id) => satById[id].name === onlyEntity.name);
          const wasTrackingThisSat = onlySatId && customTrackingSatId === onlySatId;
          if (wasTrackingThisSat || (autoTrackFocused && onlySatId)) {
            startCustomTracking(onlySatId, onlyEntity);
          } else {
            // If we were tracking some OTHER satellite that's no longer
            // in the scene, release that camera lock.
            if (customTrackingSatId) stopCustomTracking();
            viewer.camera.flyHome(1.5);
          }
        } else if (entities.length > 1) {
          // Two sub-cases when more than one satellite is on screen:
          //
          //   (a) autoTrackFocused (e.g. Fetch Latest TLE on a focused
          //       satellite while several others are also selected): the
          //       user's intent is "follow the satellite I just refreshed"
          //       — find the focused satellite's entity in the current
          //       scene and start tracking it. This is the FINAL step
          //       after visualize finishes, matching the user's mental
          //       model of "do everything else, then activate tracking".
          //
          //   (b) Otherwise (Visualize All / Reset / Auto Refresh): fly
          //       to Cesium's default home view (Camera.DEFAULT_VIEW_RECTANGLE,
          //       the same view the page opens with). The old
          //       zoomTo(entities, hpr) computed a union BoundingSphere
          //       whose center lands INSIDE the Earth for globally-
          //       distributed LEO satellites — the ECEF position vectors
          //       of satellites on opposite sides of the globe partially
          //       cancel. The HeadingPitchRange `range` was then measured
          //       from that subterranean center, placing the camera at a
          //       nonsensical surface point. Upstream-acknowledged in
          //       CesiumGS/cesium#2812. flyHome() is independent of the
          //       homeButton command override in main.js, so it always
          //       reaches the true default view.
          const focusedEntity = (autoTrackFocused && focusedSatId)
            ? entities.find((e) => satById[focusedSatId] && satById[focusedSatId].name === e.name)
            : null;
          if (focusedEntity) {
            startCustomTracking(focusedSatId, focusedEntity);
          } else {
            stopCustomTracking();
            viewer.camera.flyHome(1.5);
          }
        }
        applySceneMode(viewer);
      }
    } catch (err) {
      showError(err.message);
      console.error('Visualization error:', err);
    }
  }

  function displayOrbitalInfo(name, info, satrec) {
    const currentPos = getCurrentPosition(satrec);

    const rows = [
      ['Satellite', name],
      ['Period', `${info.periodMinutes.toFixed(2)} min`],
      ['Inclination', `${info.inclinationDeg.toFixed(2)}\u00B0`],
      ['Eccentricity', info.eccentricity.toFixed(6)],
      ['Semi-major Axis', `${info.semiMajorAxis.toFixed(1)} km`],
      ['Apogee Alt.', `${info.apogeeAlt.toFixed(1)} km`],
      ['Perigee Alt.', `${info.perigeeAlt.toFixed(1)} km`],
    ];

    if (currentPos) {
      rows.push(
        ['\u2500\u2500\u2500 Live \u2500\u2500\u2500', ''],
        ['Altitude', `${currentPos.height.toFixed(1)} km`],
        ['Latitude', `${currentPos.latitude.toFixed(4)}\u00B0`],
        ['Longitude', `${currentPos.longitude.toFixed(4)}\u00B0`],
        ['Speed', `${currentPos.speed.toFixed(3)} km/s`],
      );
    }

    infoTable.innerHTML = rows
      .map(([key, val]) => `<tr><td>${key}</td><td>${val}</td></tr>`)
      .join('');

    satelliteInfo.style.display = 'block';
  }

  function startLiveUpdates(satrec) {
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      const pos = getCurrentPosition(satrec);
      if (!pos) return;

      const liveRows = infoTable.querySelectorAll('tr');
      for (const row of liveRows) {
        const label = row.querySelector('td:first-child');
        const value = row.querySelector('td:last-child');
        if (!label || !value) continue;

        switch (label.textContent) {
          case 'Altitude': value.textContent = `${pos.height.toFixed(1)} km`; break;
          case 'Latitude': value.textContent = `${pos.latitude.toFixed(4)}\u00B0`; break;
          case 'Longitude': value.textContent = `${pos.longitude.toFixed(4)}\u00B0`; break;
          case 'Speed': value.textContent = `${pos.speed.toFixed(3)} km/s`; break;
        }
      }
    }, 1000);
  }

  // ─── 2D / 3D Mode Switch ───
  viewer.scene.morphComplete.addEventListener(() => {
    applySceneMode(viewer);
  });

  // ─── Custom Playback Bar ───
  const clock = viewer.clock;
  let isScrubbing = false;

  function updatePlayPauseIcon() {
    const playing = clock.shouldAnimate;
    pbIconPlay.style.display = playing ? 'none' : '';
    pbIconPause.style.display = playing ? '' : 'none';
  }

  pbPlayPause.addEventListener('click', () => {
    clock.shouldAnimate = !clock.shouldAnimate;
    updatePlayPauseIcon();
  });

  pbReverse.addEventListener('click', () => {
    clock.multiplier = -Math.abs(clock.multiplier);
    pbReverse.classList.add('active');
    if (!clock.shouldAnimate) {
      clock.shouldAnimate = true;
      updatePlayPauseIcon();
    }
  });

  pbStepFwd.addEventListener('click', () => {
    if (clock.multiplier < 0) {
      clock.multiplier = Math.abs(clock.multiplier);
      pbReverse.classList.remove('active');
    }
    const step = 60;
    const newTime = Cesium.JulianDate.addSeconds(clock.currentTime, step, new Cesium.JulianDate());
    clock.currentTime = newTime;
  });

  pbNow.addEventListener('click', () => {
    clock.currentTime = Cesium.JulianDate.now();
    clock.multiplier = Math.abs(clock.multiplier);
    pbReverse.classList.remove('active');
  });

  pbSpeedBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const sign = clock.multiplier < 0 ? -1 : 1;
      clock.multiplier = sign * parseFloat(btn.dataset.mult);
      pbSpeedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ─── Video recording via MediaRecorder ───
  const pbRecBtn = document.getElementById('pbRecBtn');
  const pbRecLabel = document.getElementById('pbRecLabel');
  const pbRecStatus = document.getElementById('pbRecStatus');
  const pbRecFps = document.getElementById('pbRecFps');

  /** @type {MediaRecorder|null} */
  let mediaRecorder = null;
  /** @type {Array<Blob>} */
  let recordedChunks = [];
  /** @type {ReturnType<typeof setInterval>|null} */
  let recordingStatusTimer = null;
  let recordingStartMs = 0;
  let recordingMimeType = '';

  function setRecStatus(text, kind) {
    if (!pbRecStatus) return;
    pbRecStatus.textContent = text || '';
    pbRecStatus.classList.remove('is-active', 'is-saving');
    if (kind) pbRecStatus.classList.add(kind);
  }

  function pickSupportedMimeType() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    for (const m of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  /** @type {MediaStream|null} */
  let recordingStream = null;

  async function startRecording() {
    if (mediaRecorder) return;
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      setRecStatus('Recording not supported in this browser', '');
      return;
    }

    const fps = Number(pbRecFps?.value || 30);
    recordingMimeType = pickSupportedMimeType();
    if (!recordingMimeType) {
      setRecStatus('No supported codec', '');
      return;
    }

    setRecStatus('Pick this tab to share…', 'is-saving');
    try {
      recordingStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: fps },
          displaySurface: 'browser',
        },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      });
    } catch (err) {
      console.warn('Display capture cancelled or failed:', err);
      setRecStatus('Cancelled', '');
      recordingStream = null;
      return;
    }

    try {
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(recordingStream, {
        mimeType: recordingMimeType,
        videoBitsPerSecond: 12_000_000, // 12 Mbps for high quality
      });
      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recordedChunks.push(event.data);
      };
      mediaRecorder.onstop = () => {
        if (recordingStream) {
          recordingStream.getTracks().forEach((t) => t.stop());
          recordingStream = null;
        }
        finalizeRecording();
      };
      mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event);
        setRecStatus('Recording error', '');
      };

      // If user clicks browser's "Stop sharing" button, end recording too
      const videoTrack = recordingStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          if (mediaRecorder && mediaRecorder.state === 'recording') {
            stopRecording();
          }
        });
      }

      mediaRecorder.start(1000); // emit a chunk every 1s
      recordingStartMs = Date.now();
    } catch (err) {
      console.error('Failed to start recording:', err);
      setRecStatus('Failed to start', '');
      if (recordingStream) {
        recordingStream.getTracks().forEach((t) => t.stop());
        recordingStream = null;
      }
      mediaRecorder = null;
      return;
    }

    pbRecBtn.classList.add('is-recording');
    if (pbRecLabel) pbRecLabel.textContent = 'STOP';
    if (pbRecFps) pbRecFps.disabled = true;
    setRecStatus(`0.0s @ ${fps}fps`, 'is-active');

    recordingStatusTimer = setInterval(() => {
      const sec = ((Date.now() - recordingStartMs) / 1000).toFixed(1);
      const f = Number(pbRecFps?.value || 30);
      setRecStatus(`${sec}s @ ${f}fps`, 'is-active');
    }, 250);
  }

  function stopRecording() {
    if (!mediaRecorder) return;
    if (recordingStatusTimer) {
      clearInterval(recordingStatusTimer);
      recordingStatusTimer = null;
    }
    pbRecBtn.classList.remove('is-recording');
    pbRecBtn.disabled = true;
    if (pbRecLabel) pbRecLabel.textContent = 'REC';
    setRecStatus('Saving…', 'is-saving');

    try {
      mediaRecorder.stop();
    } catch (err) {
      console.error('Stop recording failed:', err);
    }
  }

  function finalizeRecording() {
    const blob = new Blob(recordedChunks, { type: recordingMimeType });
    const ext = recordingMimeType.includes('mp4') ? 'mp4' : 'webm';

    if (blob.size === 0) {
      setRecStatus('No data recorded', '');
    } else {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `orbit-recording_${ts}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const sizeMb = (blob.size / 1024 / 1024).toFixed(1);
      setRecStatus(`Saved ${sizeMb} MB`, '');
    }

    recordedChunks = [];
    mediaRecorder = null;
    pbRecBtn.disabled = false;
    if (pbRecFps) pbRecFps.disabled = false;
  }

  if (pbRecBtn) {
    pbRecBtn.addEventListener('click', () => {
      if (mediaRecorder) stopRecording();
      else startRecording();
    });
  }

  pbScrubber.addEventListener('mousedown', () => { isScrubbing = true; });
  pbScrubber.addEventListener('pointerdown', () => { isScrubbing = true; });
  pbScrubber.addEventListener('mouseup', () => { isScrubbing = false; });
  pbScrubber.addEventListener('pointerup', () => { isScrubbing = false; });

  pbScrubber.addEventListener('input', () => {
    const fraction = pbScrubber.value / 1000;
    const startMs = Cesium.JulianDate.toDate(clock.startTime).getTime();
    const stopMs = Cesium.JulianDate.toDate(clock.stopTime).getTime();
    clock.currentTime = Cesium.JulianDate.fromDate(
      new Date(startMs + fraction * (stopMs - startMs)),
    );
    pbScrubber.style.setProperty('--pct', `${fraction * 100}%`);
  });

  function buildTimelineTicks() {
    const startMs = Cesium.JulianDate.toDate(clock.startTime).getTime();
    const stopMs = Cesium.JulianDate.toDate(clock.stopTime).getTime();
    const rangeMs = stopMs - startMs;
    if (rangeMs <= 0) return;

    pbTicks.innerHTML = '';
    const pad = (n) => String(n).padStart(2, '0');

    const rangeHrs = rangeMs / 3600000;
    let intervalHrs;
    if (rangeHrs <= 3) intervalHrs = 0.5;
    else if (rangeHrs <= 8) intervalHrs = 1;
    else if (rangeHrs <= 24) intervalHrs = 3;
    else if (rangeHrs <= 72) intervalHrs = 6;
    else intervalHrs = 12;

    const startDate = new Date(startMs);
    const firstTick = new Date(startDate);
    firstTick.setUTCMinutes(0, 0, 0);
    if (intervalHrs >= 1) {
      const h = firstTick.getUTCHours();
      firstTick.setUTCHours(Math.ceil(h / intervalHrs) * intervalHrs);
    } else {
      const m = firstTick.getUTCMinutes();
      firstTick.setUTCMinutes(Math.ceil(m / 30) * 30);
    }
    if (firstTick.getTime() < startMs) {
      firstTick.setTime(firstTick.getTime() + intervalHrs * 3600000);
    }

    for (let t = firstTick.getTime(); t <= stopMs; t += intervalHrs * 3600000) {
      const d = new Date(t);
      const fraction = (t - startMs) / rangeMs;

      if (fraction < 0.03 || fraction > 0.97) continue;

      const span = document.createElement('span');
      span.className = 'pb-tick';

      const hour = d.getUTCHours();
      const isNoon = hour === 12 && d.getUTCMinutes() === 0;
      const isMidnight = hour === 0 && d.getUTCMinutes() === 0;

      if (isNoon) span.classList.add('noon');
      if (isMidnight) span.classList.add('date');

      if (isMidnight) {
        span.textContent = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
      } else if (isNoon) {
        span.textContent = '12:00';
      } else {
        span.textContent = `${pad(hour)}:${pad(d.getUTCMinutes())}`;
      }

      span.style.left = `${fraction * 100}%`;
      pbTicks.appendChild(span);
    }
  }

  // ─── Custom Satellite Tracking (north-up) ───
  /**
   * Start tracking the given satellite. `entity` must be a freshly resolved
   * Cesium Entity (post-clearVisualization will create new entities so we always
   * want the current one for the initial zoom). After this initial frame, the
   * tracking loop will re-resolve the entity from the satellite ID on every
   * tick so stale Entity references after a re-visualize cannot break drag.
   *
   * @param {string} satId
   * @param {Cesium.Entity} entity
   */
  function startCustomTracking(satId, entity) {
    if (!satId || !entity) return;
    customTrackingSatId = satId;
    customTrackingPrevLat = null;
    customTrackingRange = currentAvgAltKm ? currentAvgAltKm * 6000 : 6_000_000;
    viewer.zoomTo(entity, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-25), customTrackingRange));
    updateTrackButton();
  }

  function stopCustomTracking() {
    customTrackingSatId = null;
    customTrackingPrevLat = null;
    customTrackingRange = null;
    // Release any camera transform so the user can drag the globe freely again.
    try { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* ignore */ }
    // Re-orient the camera so Earth's center sits at the screen center again.
    // After tracking ends, the camera is still aimed at the (sub-satellite)
    // surface point with a downward pitch, so Earth's visual centroid was
    // appearing in the lower half of the viewport.
    recenterEarthView();
    updateTrackButton();
  }

  /**
   * Keep the user's current camera position (zoom level / vantage) but rotate
   * the view so that Earth's center is at the screen center. Used when stopping
   * tracking to restore a sane neutral viewpoint without forcing the user back
   * to a hard-coded home view.
   */
  function recenterEarthView() {
    if (viewer.scene.mode !== Cesium.SceneMode.SCENE3D) return;
    try {
      const eye = viewer.camera.positionWC.clone();
      const distance = Cesium.Cartesian3.magnitude(eye);
      // If the camera is essentially at the origin (or invalid), there is no
      // direction to compute — bail out and let Cesium use its default.
      if (!Number.isFinite(distance) || distance < 1) return;

      // direction = unit vector from eye toward Earth's center.
      const direction = new Cesium.Cartesian3();
      Cesium.Cartesian3.negate(eye, direction);
      Cesium.Cartesian3.normalize(direction, direction);

      // up: world Z axis (north pole) projected onto the plane perpendicular
      // to `direction`. This gives a stable, intuitive "north is up" frame.
      const north = new Cesium.Cartesian3(0, 0, 1);
      const right = new Cesium.Cartesian3();
      Cesium.Cartesian3.cross(direction, north, right);
      if (Cesium.Cartesian3.magnitudeSquared(right) < 1e-8) {
        // Camera is directly above a pole — north and direction are parallel.
        // Fall back to a fixed right vector (world +X) so the cross still works.
        Cesium.Cartesian3.fromElements(1, 0, 0, right);
      }
      Cesium.Cartesian3.normalize(right, right);

      const up = new Cesium.Cartesian3();
      Cesium.Cartesian3.cross(right, direction, up);
      Cesium.Cartesian3.normalize(up, up);

      viewer.camera.setView({
        destination: eye,
        orientation: { direction, up },
      });
    } catch {
      // Any failure here is a no-op — Cesium will keep its previous view.
    }
  }

  /**
   * Resolve the entity for the currently tracked satellite (or null if the
   * tracking target was deselected/deleted/never visualized).
   */
  function resolveTrackingEntity() {
    if (!customTrackingSatId) return null;
    const sat = satById[customTrackingSatId];
    if (!sat) return null;
    if (!selectedSatIds.has(customTrackingSatId)) return null;
    return viewer.entities.values.find((e) => e.name === sat.name) || null;
  }

  function updateCustomTracking() {
    if (!customTrackingSatId) return;
    // Resolve the entity fresh every tick so that we never hold on to a stale
    // Entity object whose SampledPositionProperty still happens to return
    // valid positions (this was the cause of "globe drag broken" after
    // re-visualization).
    const entity = resolveTrackingEntity();
    if (!entity) {
      // Tracked satellite is gone (deselected / removed) — auto-stop.
      stopCustomTracking();
      return;
    }
    // Only track in 3D mode — 2D/Columbus don't support lookAt
    if (viewer.scene.mode !== Cesium.SceneMode.SCENE3D) return;

    const pos = entity.position;
    if (!pos) return;
    const cartesian = pos.getValue(clock.currentTime);
    if (!cartesian) return;

    try {
      // Use the sub-satellite point (on Earth's surface) as the lookAt target
      // This keeps the local East-North-Up frame consistent with Earth's surface
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      const satAltMeters = carto.height;
      const surfacePoint = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0);

      // Preserve user's current zoom distance relative to the surface point
      const currentRange = Cesium.Cartesian3.distance(viewer.camera.positionWC, surfacePoint);
      if (Number.isFinite(currentRange) && currentRange > 0) {
        customTrackingRange = currentRange;
      }

      // Ensure minimum range includes the orbital altitude
      const minRange = satAltMeters * 2;
      const range = Math.max(customTrackingRange, minRange);

      // lookAt the surface point — keeps north consistently up without drift
      viewer.camera.lookAt(
        surfacePoint,
        new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-25), range)
      );
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch {
      // Ignore errors during scene mode transitions
    }
  }

  // Clock tick → sync UI
  clock.onTick.addEventListener(() => {
    if (isScrubbing) return;

    updateCustomTracking();

    const startMs = Cesium.JulianDate.toDate(clock.startTime).getTime();
    const stopMs = Cesium.JulianDate.toDate(clock.stopTime).getTime();
    const currentMs = Cesium.JulianDate.toDate(clock.currentTime).getTime();

    const range = stopMs - startMs;
    const fraction = range > 0 ? (currentMs - startMs) / range : 0;

    pbScrubber.value = fraction * 1000;
    pbScrubber.style.setProperty('--pct', `${fraction * 100}%`);

    const d = Cesium.JulianDate.toDate(clock.currentTime);
    const pad = (n) => String(n).padStart(2, '0');
    pbTime.textContent =
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;

    pbReverse.classList.toggle('active', clock.multiplier < 0);

    if (!updatePassRowStyles._last || Date.now() - updatePassRowStyles._last > 2000) {
      updatePassRowStyles._last = Date.now();
      updatePassRowStyles();
    }
  });

  // ─── Save / Load satellite selection ───
  // Default satellites to preselect on first load — these are satellite IDs from presets.js, NOT group ids.
  const DEFAULT_SAT_IDS = ['iss', 'sentinel1a', 'sentinel3a'];
  const DEFAULT_FOCUS_ID = 'iss';

  async function saveSelection() {
    try {
      await putSetting('orbit-selection', { satelliteIds: Array.from(selectedSatIds) });
      if (ovSaveSelBtn) {
        ovSaveSelBtn.textContent = 'Saved!';
        setTimeout(() => { ovSaveSelBtn.textContent = 'Save Default'; }, 1500);
      }
    } catch (error) {
      console.warn('Failed to save Orbit Viewer defaults:', error);
    }
  }

  async function loadSelection() {
    try {
      const data = await getSetting('orbit-selection');
      if (Array.isArray(data?.satelliteIds) && data.satelliteIds.length > 0) {
        return data.satelliteIds.filter(id => satById[id]);
      }
    } catch (error) {
      console.warn('Failed to load Orbit Viewer defaults:', error);
    }
    return null;
  }

  // Save / Reset button handlers
  if (ovSaveSelBtn) ovSaveSelBtn.addEventListener('click', () => saveSelection());
  if (ovResetSelBtn) ovResetSelBtn.addEventListener('click', async () => {
    const saved = await loadSelection();
    const ids = saved || DEFAULT_SAT_IDS.filter(id => satById[id]);
    selectedSatIds.clear();
    for (const id of ids) selectedSatIds.add(id);
    focusedSatId = selectedSatIds.has(DEFAULT_FOCUS_ID) ? DEFAULT_FOCUS_ID : (ids[0] || null);
    renderSatelliteSelector();
    if (focusedSatId) focusSatellite(focusedSatId);
    visualize();
  });

  // ─── Initialize ───
  async function initializeSelection() {
    const saved = await loadSelection();
    const ids = saved || DEFAULT_SAT_IDS.filter(id => satById[id]);

    selectedSatIds.clear();
    for (const id of ids) selectedSatIds.add(id);

    focusedSatId = selectedSatIds.has(DEFAULT_FOCUS_ID) ? DEFAULT_FOCUS_ID : (ids[0] || null);

    renderSatelliteSelector();
    if (focusedSatId) focusSatellite(focusedSatId);
    updateTimeHints();
    renderStationList();
    subscribe('stations', (stationsSlice) => {
      const nextStations = toStationArray(stationsSlice);
      groundStations = nextStations;
      renderStationList();
      renderGroundStations();
      updatePassSchedule(null);
    });

    let satellitesChangedWhileHidden = false;

    subscribe('satellites', () => {
      rebuildSatelliteData();
      renderSatelliteSelector();
      // Re-visualize to pick up color/enabled changes from Configuration
      if (getState().ui?.activeTab === 'orbit-viewer') {
        visualize({ skipZoom: true });
      } else {
        satellitesChangedWhileHidden = true;
      }
    });

    subscribe('groups', () => {
      renderSatelliteSelector();
    });

    subscribe('ui', (ui) => {
      if (ui.activeTab === 'orbit-viewer' && satellitesChangedWhileHidden) {
        satellitesChangedWhileHidden = false;
        visualize({ skipZoom: true });
      }
    });
    updatePlayPauseIcon();
    // Auto-visualize on startup but skip camera zoom to avoid overriding Cesium's default centered view
    setTimeout(() => {
      visualize({ skipZoom: true });
    }, 500);
  }

  initializeSelection();
}

function toStationArray(stationsById) {
  return Object.values(stationsById || {}).map((station) => ({
    ...station,
    antennas: Array.isArray(station.antennas) ? station.antennas.map((ant) => ({ ...ant })) : [],
  }));
}

function toStationRecord(stations, antennas = []) {
  const antennaByStation = {};
  for (const antenna of antennas || []) {
    if (!antenna?.id || !antenna?.stationId) continue;
    if (!antennaByStation[antenna.stationId]) antennaByStation[antenna.stationId] = [];
    antennaByStation[antenna.stationId].push({
      id: antenna.id,
      name: antenna.name || antenna.id,
      type: antenna.type || '',
    });
  }

  return (Array.isArray(stations) ? stations : []).reduce((acc, station) => {
    if (!station?.id) return acc;
    acc[station.id] = {
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      minElevDeg: station.minElevDeg,
      antennas: antennaByStation[station.id] || (Array.isArray(station.antennas)
        ? station.antennas
          .filter((ant) => ant?.id)
          .map((ant) => ({ id: ant.id, name: ant.name || ant.id, type: ant.type || '' }))
        : []),
    };
    return acc;
  }, {});
}

function toAntennaRecord(stationsById) {
  const antennas = {};
  for (const station of Object.values(stationsById || {})) {
    for (const antenna of station.antennas || []) {
      if (!antenna?.id) continue;
      antennas[antenna.id] = {
        id: antenna.id,
        stationId: station.id,
        name: antenna.name || antenna.id,
        type: antenna.type || '',
      };
    }
  }
  return antennas;
}

function buildSatelliteListFromStore() {
  const storeSats = getState().satellites || {};
  return Object.values(storeSats).map((sat) => ({
    id: sat.id,
    name: sat.name,
    tle: sat.tle || [sat.tleLine0, sat.tleLine1, sat.tleLine2].filter(Boolean).join('\n'),
    group: sat.groupName || 'general',
    noradId: sat.noradId,
    color: sat.color || '#7dd3fc',
    enabled: sat.enabled !== false,
  }));
}

function buildSatById(satellites) {
  return satellites.reduce((acc, sat) => { acc[sat.id] = sat; return acc; }, {});
}

function buildTleBySatId(satellites) {
  return satellites.reduce((acc, sat) => { acc[sat.id] = sat.tle; return acc; }, {});
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
