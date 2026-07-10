import { getState, patch, subscribe } from '../core/app-store.js';
import {
  fetchSatellites,
  createSatellite,
  updateSatellite,
  deleteSatellite,
  fetchStations,
  createStation,
  updateStation,
  deleteStation,
  fetchAntennas,
  createAntenna,
  deleteAntenna,
  fetchMappings,
  createMapping,
  deleteMapping,
  updateMappingRole,
  uploadAntennaMask,
  deleteAntennaMask,
  fetchAntennaMask,
  fetchGroups,
  createGroup,
  updateGroup,
  deleteGroup,
} from '../core/api.js';
import { getGroupLabel, getSortedGroups } from '../core/groups.js';
import { checkConnection, fetchLatestTLE, searchSatellitesByName, searchSatellitesByNorad, fetchGPGroup } from '../tle-fetch.js';
import { ommToSatellitePayload } from '../gp.js';
import { separationVectorToTLE, classicalElementsToTLE } from '../separation-vector.js';

/**
 * Curated CelesTrak GROUP query values for the bulk-import panel. Values are
 * the group names accepted by `gp.php?GROUP=...`. Large groups are labelled.
 */
const CELESTRAK_GROUPS = [
  { value: 'stations', label: 'Space Stations' },
  { value: 'visual', label: 'Brightest (Visual)' },
  { value: 'weather', label: 'Weather' },
  { value: 'noaa', label: 'NOAA' },
  { value: 'goes', label: 'GOES' },
  { value: 'resource', label: 'Earth Resources' },
  { value: 'sarsat', label: 'Search & Rescue (SARSAT)' },
  { value: 'gps-ops', label: 'GPS Operational' },
  { value: 'glo-ops', label: 'GLONASS Operational' },
  { value: 'galileo', label: 'Galileo' },
  { value: 'beidou', label: 'Beidou' },
  { value: 'science', label: 'Space & Earth Science' },
  { value: 'geodetic', label: 'Geodetic' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'cubesat', label: 'CubeSats' },
  { value: 'amateur', label: 'Amateur Radio' },
  { value: 'intelsat', label: 'Intelsat' },
  { value: 'iridium-NEXT', label: 'Iridium NEXT' },
  { value: 'orbcomm', label: 'Orbcomm' },
  { value: 'globalstar', label: 'Globalstar' },
  { value: 'oneweb', label: 'OneWeb (large)' },
  { value: 'starlink', label: 'Starlink (large)' },
  { value: 'geo', label: 'GEO (large)' },
  { value: 'active', label: 'All Active (very large)' },
];

/** Color palette cycled through for bulk-imported satellites. */
const SAT_IMPORT_COLORS = [
  '#7dd3fc', '#fbbf24', '#fb7185', '#34d399', '#a78bfa',
  '#f97316', '#38bdf8', '#f472b6', '#4ade80', '#c084fc',
  '#fb923c', '#22d3ee', '#e879f9', '#a3e635', '#fca5a5',
];

export function initConfiguration() {
  const section = document.getElementById('tab-configuration');
  if (!section) return;

  const navButtons = Array.from(section.querySelectorAll('.cfg-nav-btn'));
  const sectionByKey = { satellites: document.getElementById('cfgSatellites'), groups: document.getElementById('cfgGroups'), stations: document.getElementById('cfgStations'), antennas: document.getElementById('cfgAntennas'), mappings: document.getElementById('cfgMappings') };

  const satAddBtn = document.getElementById('cfgSatAddBtn'), satFetchAllBtn = document.getElementById('cfgSatFetchAllBtn'), satForm = document.getElementById('cfgSatForm'), satFormTitle = document.getElementById('cfgSatFormTitle'), satIdInput = document.getElementById('cfgSatId'), satNameInput = document.getElementById('cfgSatName'), satNoradInput = document.getElementById('cfgSatNorad'), satGroupInput = document.getElementById('cfgSatGroup'), satColorInput = document.getElementById('cfgSatColor'), satColorHex = document.getElementById('cfgSatColorHex'), satEnabledInput = document.getElementById('cfgSatEnabled'), satTleInput = document.getElementById('cfgSatTle'), satSaveBtn = document.getElementById('cfgSatSaveBtn'), satCancelBtn = document.getElementById('cfgSatCancelBtn'), satList = document.getElementById('cfgSatList');

  const satSearchInput = document.getElementById('cfgSatSearchInput'), satSearchBtn = document.getElementById('cfgSatSearchBtn'), satSearchStatus = document.getElementById('cfgSatSearchStatus'), satSearchResults = document.getElementById('cfgSatSearchResults'), satSearchWrap = document.getElementById('cfgSatSearchWrap');

  const stationAddBtn = document.getElementById('cfgStationAddBtn'), stationForm = document.getElementById('cfgStationForm'), stationFormTitle = document.getElementById('cfgStationFormTitle'), stationNameInput = document.getElementById('cfgStationName'), stationLatInput = document.getElementById('cfgStationLat'), stationLonInput = document.getElementById('cfgStationLon'), stationElevInput = document.getElementById('cfgStationElev'), stationSaveBtn = document.getElementById('cfgStationSaveBtn'), stationCancelBtn = document.getElementById('cfgStationCancelBtn'), stationList = document.getElementById('cfgStationList');

  const groupAddBtn = document.getElementById('cfgGroupAddBtn'), groupForm = document.getElementById('cfgGroupForm'), groupFormTitle = document.getElementById('cfgGroupFormTitle'), groupNameInput = document.getElementById('cfgGroupName'), groupLabelInput = document.getElementById('cfgGroupLabel'), groupColorInput = document.getElementById('cfgGroupColor'), groupColorHex = document.getElementById('cfgGroupColorHex'), groupSortInput = document.getElementById('cfgGroupSort'), groupSchedulableInput = document.getElementById('cfgGroupSchedulable'), groupSaveBtn = document.getElementById('cfgGroupSaveBtn'), groupCancelBtn = document.getElementById('cfgGroupCancelBtn'), groupList = document.getElementById('cfgGroupList');

  const antennaStationSel = document.getElementById('cfgAntennaStationSel'), antennaAddBtn = document.getElementById('cfgAntennaAddBtn'), antennaForm = document.getElementById('cfgAntennaForm'), antennaFormTitle = document.getElementById('cfgAntennaFormTitle'), antennaNameInput = document.getElementById('cfgAntennaName'), antennaTypeInput = document.getElementById('cfgAntennaType'), antennaSaveBtn = document.getElementById('cfgAntennaSaveBtn'), antennaCancelBtn = document.getElementById('cfgAntennaCancelBtn'), antennaList = document.getElementById('cfgAntennaList');

  const mappingTree = document.getElementById('cfgMappingTree');

  // Validate critical DOM refs — log missing elements instead of silently aborting
  const _requiredRefs = {
    satAddBtn, satFetchAllBtn, satForm, satFormTitle, satIdInput, satNameInput,
    satNoradInput, satGroupInput, satColorInput, satColorHex, satEnabledInput,
    satTleInput, satSaveBtn, satCancelBtn, satList,
    stationAddBtn, stationForm, stationFormTitle, stationNameInput, stationLatInput,
    stationLonInput, stationElevInput, stationSaveBtn, stationCancelBtn, stationList,
    antennaStationSel, antennaAddBtn, antennaForm, antennaFormTitle,
    antennaNameInput, antennaTypeInput, antennaSaveBtn, antennaCancelBtn, antennaList,
    mappingTree,
  };
  const _missing = Object.entries(_requiredRefs).filter(([, v]) => !v).map(([k]) => k);
  if (_missing.length > 0) {
    console.error('[Configuration] Missing DOM elements:', _missing.join(', '));
    return;
  }
  if (navButtons.length === 0 || !sectionByKey.satellites) {
    console.error('[Configuration] Nav buttons or section panels not found');
    return;
  }

  let satFormMode = /** @type {'add'|'edit'} */ ('add');
  let satEditingId = '';
  let satBusy = false;

  let stationFormMode = /** @type {'add'|'edit'} */ ('add');
  let stationEditingId = '';
  let stationBusy = false;

  let groupFormMode = /** @type {'add'|'edit'} */ ('add');
  let groupEditingId = '';
  let groupBusy = false;

  let selectedAntennaStationId = '';
  let antennaBusy = false;

  /** Track which <details> are open across re-renders */
  const openDetails = new Set();

  setActiveSection('satellites');
  hideSatelliteForm();
  hideStationForm();
  hideAntennaForm();
  hideGroupForm();
  syncSelectedAntennaStation();
  renderSatelliteList();
  renderStationList();
  renderAntennaStationSelector();
  renderAntennaList();
  renderMappingTree();
  renderGroupList();
  renderSatGroupDropdown();
  void refreshAll();

  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-cfg-section') || '';
      if (!Object.hasOwn(sectionByKey, key)) return;
      setActiveSection(key);
    });
  });

  satAddBtn.addEventListener('click', () => {
    satFormMode = 'add';
    satEditingId = '';
    satFormTitle.textContent = 'Add Satellite';
    satIdInput.value = '';
    satIdInput.readOnly = false;
    satNameInput.value = '';
    satNoradInput.value = '';
    satGroupInput.value = 'custom';
    satColorInput.value = '#7dd3fc';
    satColorHex.textContent = '#7dd3fc';
    satEnabledInput.checked = true;
    satTleInput.value = '';
    // Show search, reset search state
    if (satSearchWrap) satSearchWrap.style.display = '';
    if (satSearchInput) satSearchInput.value = '';
    if (satSearchStatus) satSearchStatus.style.display = 'none';
    hideSearchResults();
    hideImportForm();
    showSatelliteForm();
  });

  satCancelBtn.addEventListener('click', hideSatelliteForm);

  // ─── CelesTrak Satellite Search ───

  let searchAbort = null;

  async function performSatelliteSearch() {
    const query = (satSearchInput?.value || '').trim();
    if (query.length < 2) {
      showSearchStatus('Type at least 2 characters to search.', 'info');
      return;
    }

    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();

    showSearchStatus('Searching CelesTrak…', 'info');
    hideSearchResults();
    if (satSearchBtn) { satSearchBtn.disabled = true; satSearchBtn.textContent = 'Searching…'; }

    try {
      // Decide search type: numeric → NORAD ID, otherwise → name
      const isNumeric = /^\d+$/.test(query);
      const results = isNumeric
        ? await searchSatellitesByNorad(Number(query))
        : await searchSatellitesByName(query);

      if (results.length === 0) {
        showSearchStatus(`No satellites found for "${escapeHtml(query)}".`, 'warn');
        hideSearchResults();
        return;
      }

      showSearchStatus(`${results.length} satellite${results.length > 1 ? 's' : ''} found. Click to select.`, 'success');
      renderSearchResults(results);
    } catch (error) {
      showSearchStatus(error instanceof Error ? error.message : 'Search failed.', 'error');
      hideSearchResults();
    } finally {
      if (satSearchBtn) { satSearchBtn.disabled = false; satSearchBtn.textContent = 'Search'; }
    }
  }

  if (satSearchBtn) satSearchBtn.addEventListener('click', performSatelliteSearch);

  if (satSearchInput) {
    satSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); performSatelliteSearch(); }
    });
  }

  // ─── Bulk import from a CelesTrak GROUP ───

  const satImportBtn = document.getElementById('cfgSatImportBtn');
  const satImportForm = document.getElementById('cfgSatImportForm');
  const importGroupSel = document.getElementById('cfgImportGroupSel');
  const importTargetGroup = document.getElementById('cfgImportTargetGroup');
  const importFetchBtn = document.getElementById('cfgImportFetchBtn');
  const importCancelBtn = document.getElementById('cfgImportCancelBtn');
  const importStatus = document.getElementById('cfgImportStatus');
  const importControls = document.getElementById('cfgImportControls');
  const importSelectAll = document.getElementById('cfgImportSelectAll');
  const importCount = document.getElementById('cfgImportCount');
  const importAddBtn = document.getElementById('cfgImportAddBtn');
  const importResults = document.getElementById('cfgImportResults');

  /** @type {Array<Record<string, unknown>>} last fetched OMM records for preview */
  let importRecords = [];
  let importBusy = false;
  const IMPORT_PREVIEW_CAP = 500;

  function renderImportGroupOptions() {
    if (!importGroupSel) return;
    importGroupSel.innerHTML = CELESTRAK_GROUPS
      .map((g) => `<option value="${escapeHtmlAttr(g.value)}">${escapeHtml(g.label)}</option>`)
      .join('');
  }

  function renderImportTargetGroup() {
    if (!importTargetGroup) return;
    const groups = getSortedGroups();
    const prev = importTargetGroup.value;
    importTargetGroup.innerHTML = groups.length
      ? groups.map((g) => `<option value="${escapeHtmlAttr(g.name)}">${escapeHtml(g.label)}</option>`).join('')
      : '<option value="">(no groups)</option>';
    if (prev && groups.some((g) => g.name === prev)) importTargetGroup.value = prev;
  }

  function showImportStatus(msg, type = 'info') {
    if (!importStatus) return;
    importStatus.textContent = msg || '';
    importStatus.className = `cfg-search-status cfg-search-status-${type}`;
    importStatus.style.display = msg ? '' : 'none';
  }

  function hideImportForm() {
    if (satImportForm) satImportForm.style.display = 'none';
  }

  function updateImportCount() {
    if (!importCount || !importResults) return;
    const boxes = importResults.querySelectorAll('.cfg-import-cb');
    const checked = importResults.querySelectorAll('.cfg-import-cb:checked');
    importCount.textContent = `${checked.length} selected · ${boxes.length} shown`;
  }

  function renderImportPreview(records) {
    if (!importResults) return;
    const existingNorads = new Set(
      Object.values(getState().satellites || {})
        .map((s) => Number(s?.noradId))
        .filter((n) => Number.isFinite(n)),
    );
    const shown = records.slice(0, IMPORT_PREVIEW_CAP);
    const rows = shown.map((omm) => {
      const norad = Number(omm.NORAD_CAT_ID);
      const name = escapeHtml(String(omm.OBJECT_NAME || `NORAD ${norad}`));
      const exists = existingNorads.has(norad);
      const epoch = escapeHtml(String(omm.EPOCH || '').slice(0, 19));
      return `<label class="cfg-search-item" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" class="cfg-import-cb" value="${norad}" ${exists ? 'disabled' : 'checked'}>
        <span class="cfg-search-item-name">${name}${exists ? ' <span class="cfg-tbl-dim">(already added)</span>' : ''}</span>
        <span class="cfg-search-item-meta"><span>NORAD: ${norad}</span><span>${epoch}</span></span>
      </label>`;
    }).join('');
    const truncNote = records.length > IMPORT_PREVIEW_CAP
      ? `<div class="cfg-search-more">Showing first ${IMPORT_PREVIEW_CAP} of ${records.length}. Import a smaller group to see all.</div>`
      : '';
    importResults.innerHTML = rows + truncNote;
    importResults.style.display = '';
    if (importControls) importControls.style.display = 'flex';
    if (importSelectAll) importSelectAll.checked = true;
    updateImportCount();
  }

  if (satImportBtn) {
    satImportBtn.addEventListener('click', () => {
      hideSatelliteForm();
      renderImportGroupOptions();
      renderImportTargetGroup();
      importRecords = [];
      if (importResults) { importResults.style.display = 'none'; importResults.innerHTML = ''; }
      if (importControls) importControls.style.display = 'none';
      showImportStatus('');
      if (satImportForm) satImportForm.style.display = '';
    });
  }

  if (importCancelBtn) importCancelBtn.addEventListener('click', hideImportForm);

  if (importFetchBtn) {
    importFetchBtn.addEventListener('click', async () => {
      if (importBusy) return;
      const group = importGroupSel?.value || '';
      if (!group) { showImportStatus('Select a group.', 'warn'); return; }
      importBusy = true;
      importFetchBtn.disabled = true;
      const origText = importFetchBtn.textContent;
      importFetchBtn.textContent = 'Fetching…';
      showImportStatus(`Fetching group "${group}" from CelesTrak…`, 'info');
      if (importControls) importControls.style.display = 'none';
      if (importResults) { importResults.style.display = 'none'; importResults.innerHTML = ''; }
      try {
        const records = await fetchGPGroup(group);
        importRecords = records;
        renderImportPreview(records);
        showImportStatus(`${records.length} satellite${records.length === 1 ? '' : 's'} in "${group}". Select and click Add Selected.`, 'success');
      } catch (err) {
        importRecords = [];
        showImportStatus(err instanceof Error ? err.message : 'Failed to fetch group.', 'error');
      } finally {
        importBusy = false;
        importFetchBtn.disabled = false;
        importFetchBtn.textContent = origText;
      }
    });
  }

  if (importSelectAll) {
    importSelectAll.addEventListener('change', () => {
      if (!importResults) return;
      importResults.querySelectorAll('.cfg-import-cb:not(:disabled)').forEach((cb) => {
        cb.checked = importSelectAll.checked;
      });
      updateImportCount();
    });
  }

  if (importResults) {
    importResults.addEventListener('change', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.classList.contains('cfg-import-cb')) {
        updateImportCount();
      }
    });
  }

  if (importAddBtn) {
    importAddBtn.addEventListener('click', async () => {
      if (importBusy || !importResults) return;
      const checkedNorads = new Set(
        Array.from(importResults.querySelectorAll('.cfg-import-cb:checked')).map((cb) => Number(cb.value)),
      );
      if (checkedNorads.size === 0) { showImportStatus('No satellites selected.', 'warn'); return; }
      const targetGroup = importTargetGroup?.value || 'custom';

      const existingIds = new Set(Object.keys(getState().satellites || {}));
      const existingNorads = new Set(
        Object.values(getState().satellites || {}).map((s) => Number(s?.noradId)).filter((n) => Number.isFinite(n)),
      );

      importBusy = true;
      importAddBtn.disabled = true;
      const origText = importAddBtn.textContent;
      importAddBtn.textContent = 'Adding…';

      let added = 0; let skipped = 0; let failed = 0; let colorIdx = 0;
      for (const omm of importRecords) {
        const norad = Number(omm.NORAD_CAT_ID);
        if (!checkedNorads.has(norad)) continue;
        if (existingNorads.has(norad)) { skipped += 1; continue; }
        try {
          const color = SAT_IMPORT_COLORS[colorIdx % SAT_IMPORT_COLORS.length];
          colorIdx += 1;
          const payload = ommToSatellitePayload(omm, { groupName: targetGroup, color });
          let id = payload.id; let n = 2;
          while (existingIds.has(id)) { id = `${payload.id}_${n}`; n += 1; }
          payload.id = id;
          await createSatellite(payload);
          existingIds.add(id);
          existingNorads.add(norad);
          added += 1;
          if (added % 10 === 0) showImportStatus(`Adding… ${added} added`, 'info');
        } catch (err) {
          failed += 1;
          if (err && err.isRateLimited) { showImportStatus('Rate-limited by CelesTrak — stopped.', 'error'); break; }
        }
      }

      try { await refreshAll(); } catch { /* ignore */ }

      importBusy = false;
      importAddBtn.disabled = false;
      importAddBtn.textContent = origText;
      showImportStatus(
        `Added ${added}${skipped ? `, skipped ${skipped} (already present)` : ''}${failed ? `, failed ${failed}` : ''}.`,
        added > 0 ? 'success' : 'warn',
      );
      renderImportPreview(importRecords); // re-render so newly-added rows show as disabled
    });
  }

  // ── Separation Vector → TLE generator ──
  const sepvecGenBtn = document.getElementById('cfgSepvecGenBtn');
  const sepvecUtcInput = document.getElementById('cfgSepvecUtc');
  const sepvecPosInput = document.getElementById('cfgSepvecPos');
  const sepvecVelInput = document.getElementById('cfgSepvecVel');
  const sepvecStatus = document.getElementById('cfgSepvecStatus');
  const sepvecResult = document.getElementById('cfgSepvecResult');

  if (sepvecGenBtn) {
    sepvecGenBtn.addEventListener('click', () => {
      handleSeparationVectorGenerate();
    });
  }

  function showSepvecStatus(text, kind = 'info') {
    if (!sepvecStatus) return;
    sepvecStatus.textContent = text || '';
    sepvecStatus.classList.remove('is-error', 'is-success');
    if (kind === 'error') sepvecStatus.classList.add('is-error');
    else if (kind === 'success') sepvecStatus.classList.add('is-success');
  }

  function parseTriple(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 3) return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return nums;
  }

  function handleSeparationVectorGenerate() {
    showSepvecStatus('');
    if (sepvecResult) sepvecResult.style.display = 'none';

    const utcStr = sepvecUtcInput?.value?.trim() || '';
    if (!utcStr) {
      showSepvecStatus('Enter UTC time of state.', 'error');
      sepvecUtcInput?.focus();
      return;
    }
    // Parse as UTC: append Z if missing
    const utcParse = /(?:Z|[+-]\d{2}:?\d{2})$/.test(utcStr) ? utcStr : `${utcStr}Z`;
    const utcDate = new Date(utcParse);
    if (Number.isNaN(utcDate.getTime())) {
      showSepvecStatus('Invalid UTC time.', 'error');
      sepvecUtcInput?.focus();
      return;
    }

    const posEcefM = parseTriple(sepvecPosInput?.value || '');
    if (!posEcefM) {
      showSepvecStatus('ECEF position must be 3 numbers (X, Y, Z) in meters.', 'error');
      sepvecPosInput?.focus();
      return;
    }
    const velEcefMs = parseTriple(sepvecVelInput?.value || '');
    if (!velEcefMs) {
      showSepvecStatus('ECEF velocity must be 3 numbers (X, Y, Z) in m/s.', 'error');
      sepvecVelInput?.focus();
      return;
    }

    try {
      const proposedName = (satNameInput?.value?.trim() || 'GENERATED-SAT').toUpperCase();
      const noradVal = Number(satNoradInput?.value);
      const noradId = Number.isFinite(noradVal) && noradVal > 0 ? noradVal : 99999;
      const { tle, elements } = separationVectorToTLE({
        posEcefM,
        velEcefMs,
        utcDate,
        options: {
          name: proposedName,
          noradId,
          intlDesignator: '99999A  ',
          bstar: 0,
        },
      });

      // Fill into the TLE textarea so the user can save the satellite as usual
      if (satTleInput) {
        satTleInput.value = tle.threeLine;
      }

      // Show summary
      const RE = 6378.137;
      const altMeanKm = elements.a - RE;
      const periodStr = `${elements.periodMin.toFixed(2)} min`;
      const meta =
        `Inclination: ${(elements.i * 180 / Math.PI).toFixed(3)}°\n` +
        `Eccentricity: ${elements.e.toExponential(3)}\n` +
        `Mean altitude: ${altMeanKm.toFixed(1)} km\n` +
        `Period: ${periodStr}\n` +
        `Mean motion: ${elements.meanMotionRevPerDay.toFixed(8)} rev/day`;

      if (sepvecResult) {
        sepvecResult.style.display = '';
        sepvecResult.innerHTML =
          `<div>${escapeHtml(tle.line1)}\n${escapeHtml(tle.line2)}</div>` +
          `<div class="cfg-sepvec-result-meta">${escapeHtml(meta)}</div>`;
      }

      showSepvecStatus('TLE generated and inserted into the form above.', 'success');
    } catch (err) {
      showSepvecStatus(err instanceof Error ? err.message : 'Failed to generate TLE.', 'error');
    }
  }

  // ── Classical Orbital Elements → TLE generator ──
  const kepGenBtn = document.getElementById('cfgKepGenBtn');
  const kepUtcInput = document.getElementById('cfgKepUtc');
  const kepAInput = document.getElementById('cfgKepA');
  const kepEInput = document.getElementById('cfgKepE');
  const kepIInput = document.getElementById('cfgKepI');
  const kepRaanInput = document.getElementById('cfgKepRaan');
  const kepArgpInput = document.getElementById('cfgKepArgp');
  const kepNuInput = document.getElementById('cfgKepNu');
  const kepStatus = document.getElementById('cfgKepStatus');
  const kepResult = document.getElementById('cfgKepResult');

  if (kepGenBtn) {
    kepGenBtn.addEventListener('click', () => {
      handleKeplerianGenerate();
    });
  }

  function showKepStatus(text, kind = 'info') {
    if (!kepStatus) return;
    kepStatus.textContent = text || '';
    kepStatus.classList.remove('is-error', 'is-success');
    if (kind === 'error') kepStatus.classList.add('is-error');
    else if (kind === 'success') kepStatus.classList.add('is-success');
  }

  function parseNumberField(el, label) {
    const raw = (el?.value || '').trim();
    if (raw === '') throw new Error(`Enter ${label}.`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${label} is not a valid number.`);
    return n;
  }

  function handleKeplerianGenerate() {
    showKepStatus('');
    if (kepResult) kepResult.style.display = 'none';

    try {
      const utcStr = (kepUtcInput?.value || '').trim();
      if (!utcStr) {
        showKepStatus('Enter epoch UTC.', 'error');
        kepUtcInput?.focus();
        return;
      }
      const utcParse = /(?:Z|[+-]\d{2}:?\d{2})$/.test(utcStr) ? utcStr : `${utcStr}Z`;
      const utcDate = new Date(utcParse);
      if (Number.isNaN(utcDate.getTime())) {
        showKepStatus('Invalid epoch UTC.', 'error');
        kepUtcInput?.focus();
        return;
      }

      const aKm = parseNumberField(kepAInput, 'semi-major axis (a)');
      const e = parseNumberField(kepEInput, 'eccentricity (e)');
      const iDeg = parseNumberField(kepIInput, 'inclination (i)');
      const raanDeg = parseNumberField(kepRaanInput, 'RAAN (Ω)');
      const argpDeg = parseNumberField(kepArgpInput, 'argument of perigee (ω)');
      const trueAnomalyDeg = parseNumberField(kepNuInput, 'true anomaly (ν)');

      const RE = 6378.137;
      if (aKm <= RE) {
        showKepStatus('Semi-major axis must be larger than Earth radius (6378.137 km).', 'error');
        kepAInput?.focus();
        return;
      }
      if (e < 0 || e >= 1) {
        showKepStatus('Eccentricity must be in [0, 1).', 'error');
        kepEInput?.focus();
        return;
      }

      const proposedName = (satNameInput?.value?.trim() || 'GENERATED-SAT').toUpperCase();
      const noradVal = Number(satNoradInput?.value);
      const noradId = Number.isFinite(noradVal) && noradVal > 0 ? noradVal : 99999;

      const { tle, elements } = classicalElementsToTLE({
        aKm, e, iDeg, raanDeg, argpDeg, trueAnomalyDeg,
        utcDate,
        options: { name: proposedName, noradId, intlDesignator: '99999A  ', bstar: 0 },
      });

      if (satTleInput) satTleInput.value = tle.threeLine;

      const altMean = elements.a - RE;
      const meta =
        `Semi-major axis: ${elements.a.toFixed(3)} km (mean alt ${altMean.toFixed(1)} km)\n` +
        `Eccentricity: ${elements.e.toExponential(3)}\n` +
        `Inclination: ${(elements.i * 180 / Math.PI).toFixed(4)}°\n` +
        `RAAN: ${(elements.raan * 180 / Math.PI).toFixed(4)}°\n` +
        `Arg of perigee: ${(elements.argp * 180 / Math.PI).toFixed(4)}°\n` +
        `True anomaly: ${(elements.trueAnomaly * 180 / Math.PI).toFixed(4)}°\n` +
        `Mean anomaly: ${(elements.meanAnomaly * 180 / Math.PI).toFixed(4)}°\n` +
        `Mean motion: ${elements.meanMotionRevPerDay.toFixed(8)} rev/day\n` +
        `Period: ${elements.periodMin.toFixed(2)} min`;

      if (kepResult) {
        kepResult.style.display = '';
        kepResult.innerHTML =
          `<div>${escapeHtml(tle.line1)}\n${escapeHtml(tle.line2)}</div>` +
          `<div class="cfg-sepvec-result-meta">${escapeHtml(meta)}</div>`;
      }
      showKepStatus('TLE generated and inserted into the form above.', 'success');
    } catch (err) {
      showKepStatus(err instanceof Error ? err.message : 'Failed to generate TLE.', 'error');
    }
  }

  if (satSearchResults) {
    satSearchResults.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest('[data-norad-id]');
      if (!row) return;

      const noradId = Number(row.getAttribute('data-norad-id'));
      const satName = row.getAttribute('data-sat-name') || '';

      showSearchStatus(`Fetching TLE for ${escapeHtml(satName)}…`, 'info');

      try {
        const tle = await fetchLatestTLE(noradId);
        const lines = tle.split('\n').map(l => l.trim()).filter(Boolean);
        const line0 = lines.length === 3 ? lines[0] : satName;
        const safeName = satName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();

        // Auto-fill the form
        satIdInput.value = safeName;
        satIdInput.readOnly = false;
        satNameInput.value = satName;
        satNoradInput.value = String(noradId);
        satTleInput.value = tle;
        satGroupInput.value = 'custom';

        showSearchStatus(`TLE loaded for ${escapeHtml(satName)}. Fill remaining fields and click Save.`, 'success');
        hideSearchResults();
      } catch (error) {
        showSearchStatus(error instanceof Error ? error.message : 'Failed to fetch TLE.', 'error');
      }
    });
  }

  function showSearchStatus(msg, type) {
    if (!satSearchStatus) return;
    satSearchStatus.textContent = msg;
    satSearchStatus.className = `cfg-search-status cfg-search-status-${type}`;
    satSearchStatus.style.display = '';
  }

  function hideSearchResults() {
    if (satSearchResults) satSearchResults.style.display = 'none';
  }

  function renderSearchResults(results) {
    if (!satSearchResults) return;
    const maxResults = 50;
    const truncated = results.length > maxResults;
    const display = results.slice(0, maxResults);

    satSearchResults.innerHTML = display.map((r) => {
      const periodStr = r.period ? `${r.period.toFixed(1)} min` : '—';
      const incStr = r.inclination != null ? `${r.inclination.toFixed(1)}°` : '—';
      return `<div class="cfg-search-item" data-norad-id="${r.noradId}" data-sat-name="${escapeHtmlAttr(r.name)}">
        <div class="cfg-search-item-name">${escapeHtml(r.name)}</div>
        <div class="cfg-search-item-meta">
          <span>NORAD: ${r.noradId}</span>
          <span>${r.objectId || ''}</span>
          <span>Inc: ${incStr}</span>
          <span>Period: ${periodStr}</span>
        </div>
      </div>`;
    }).join('') + (truncated ? `<div class="cfg-search-more">${results.length - maxResults} more results not shown. Refine your search.</div>` : '');

    satSearchResults.style.display = '';
  }

  satColorInput.addEventListener('input', () => {
    satColorHex.textContent = normalizeHexColor(satColorInput.value);
  });

  satSaveBtn.addEventListener('click', async () => {
    if (satBusy) return;
    const id = satIdInput.value.trim();
    const name = satNameInput.value.trim();
    const groupName = satGroupInput.value.trim();
    const color = normalizeHexColor(satColorInput.value);
    const enabled = satEnabledInput.checked;
    const noradId = normalizeOptionalInteger(satNoradInput.value);
    const tleLines = splitTleText(satTleInput.value);

    if (!id) { window.alert('Satellite ID is required.'); satIdInput.focus(); return; }
    if (!name) { window.alert('Satellite name is required.'); satNameInput.focus(); return; }
    if (!tleLines.line1 || !tleLines.line2) {
      window.alert('TLE must include line 1 and line 2.');
      satTleInput.focus();
      return;
    }

    satBusy = true;
    satSaveBtn.disabled = true;
    try {
      const payload = {
        id,
        name,
        noradId,
        groupName,
        tleLine0: tleLines.line0,
        tleLine1: tleLines.line1,
        tleLine2: tleLines.line2,
        color,
        enabled,
      };
      if (satFormMode === 'edit') await updateSatellite(satEditingId || id, payload);
      else await createSatellite(payload);
      await refreshAll();
      hideSatelliteForm();
    } catch (error) {
      console.error('Failed to save satellite:', error);
      window.alert(error instanceof Error ? error.message : 'Failed to save satellite.');
    } finally {
      satBusy = false;
      satSaveBtn.disabled = false;
    }
  });

  satFetchAllBtn.addEventListener('click', async () => {
    if (satBusy) return;
    const satellites = Object.values(getState().satellites || {})
      .filter((sat) => sat?.enabled !== false)
      .filter((sat) => Number.isFinite(Number(sat?.noradId)));

    if (satellites.length === 0) {
      window.alert('No enabled satellites with NORAD IDs found.');
      return;
    }

    satBusy = true;
    satFetchAllBtn.disabled = true;
    satFetchAllBtn.textContent = 'Fetching...';
    try {
      const ok = await checkConnection();
      if (!ok) throw new Error('CelesTrak is unreachable. Check internet connection and try again.');

      let updatedCount = 0;
      let failedCount = 0;
      let rateLimited = false;

      for (const sat of satellites) {
        try {
          const tleText = await fetchLatestTLE(Number(sat.noradId));
          const lines = splitTleText(tleText);
          if (!lines.line1 || !lines.line2) { failedCount += 1; continue; }

          await updateSatellite(sat.id, {
            id: sat.id,
            name: sat.name,
            noradId: Number.isFinite(Number(sat.noradId)) ? Number(sat.noradId) : null,
            groupName: sat.groupName || '',
            color: normalizeHexColor(sat.color || '#7dd3fc'),
            enabled: sat.enabled !== false,
            tleLine0: lines.line0,
            tleLine1: lines.line1,
            tleLine2: lines.line2,
          });
          updatedCount += 1;
        } catch (error) {
          console.warn(`Failed TLE fetch for ${sat.id}:`, error);
          failedCount += 1;
          // CelesTrak rate limit (HTTP 403): stop the batch so we don't keep
          // hammering CelesTrak into a firewall block.
          if (error && error.isRateLimited) { rateLimited = true; break; }
        }
      }

      await refreshAll();
      window.alert(
        rateLimited
          ? `Stopped: CelesTrak rate limit reached (HTTP 403). Updated ${updatedCount} before stopping. GP data updates every 2h — try again later.`
          : `Fetch complete. Updated: ${updatedCount}, Failed: ${failedCount}`,
      );
    } catch (error) {
      console.error('Failed fetching all TLEs:', error);
      window.alert(error instanceof Error ? error.message : 'Failed to fetch all TLEs.');
    } finally {
      satBusy = false;
      satFetchAllBtn.disabled = false;
      satFetchAllBtn.textContent = 'Fetch All TLEs';
    }
  });

  satList.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const editBtn = target.closest('[data-action="edit-satellite"]');
    if (editBtn) {
      const satId = editBtn.getAttribute('data-satellite-id') || '';
      const sat = getState().satellites?.[satId];
      if (!sat) return;

      satFormMode = 'edit';
      satEditingId = sat.id;
      satFormTitle.textContent = 'Edit Satellite';
      satIdInput.value = sat.id || '';
      satIdInput.readOnly = true;
      satNameInput.value = sat.name || '';
      satNoradInput.value = sat.noradId != null ? String(sat.noradId) : '';
      satGroupInput.value = sat.groupName || 'custom';
      satColorInput.value = normalizeHexColor(sat.color || '#7dd3fc');
      satColorHex.textContent = normalizeHexColor(sat.color || '#7dd3fc');
      satEnabledInput.checked = sat.enabled !== false;
      satTleInput.value = buildTleText(sat);
      // Hide search in edit mode
      if (satSearchWrap) satSearchWrap.style.display = 'none';
      showSatelliteForm();
      return;
    }

    const deleteBtn = target.closest('[data-action="delete-satellite"]');
    if (deleteBtn) {
      const satId = deleteBtn.getAttribute('data-satellite-id') || '';
      const sat = getState().satellites?.[satId];
      if (!sat) return;

      if (!window.confirm(`Delete satellite "${sat.name || sat.id}"?`)) return;

      try {
        await deleteSatellite(satId);
        await refreshAll();
        if (satEditingId === satId) hideSatelliteForm();
      } catch (error) {
        console.error('Failed to delete satellite:', error);
        window.alert(error instanceof Error ? error.message : 'Failed to delete satellite.');
      }
    }
  });

  satList.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.matches('[data-action="toggle-satellite-enabled"]')) return;

    const satId = target.getAttribute('data-satellite-id') || '';
    const sat = getState().satellites?.[satId];
    if (!sat) return;

    const enabled = target.checked;
    try {
      await updateSatellite(sat.id, {
        id: sat.id,
        name: sat.name,
        noradId: Number.isFinite(Number(sat.noradId)) ? Number(sat.noradId) : null,
        groupName: sat.groupName || '',
        color: normalizeHexColor(sat.color || '#7dd3fc'),
        enabled,
        tleLine0: sat.tleLine0 || '',
        tleLine1: sat.tleLine1 || '',
        tleLine2: sat.tleLine2 || '',
      });
      await refreshAll();
    } catch (error) {
      console.error('Failed toggling satellite enabled state:', error);
      target.checked = !enabled;
      window.alert(error instanceof Error ? error.message : 'Failed to update satellite.');
    }
  });

  stationAddBtn.addEventListener('click', () => {
    stationFormMode = 'add';
    stationEditingId = '';
    stationFormTitle.textContent = 'Add Ground Station';
    stationNameInput.value = '';
    stationLatInput.value = '';
    stationLonInput.value = '';
    stationElevInput.value = '5';
    showStationForm();
  });

  stationCancelBtn.addEventListener('click', hideStationForm);

  stationSaveBtn.addEventListener('click', async () => {
    if (stationBusy) return;

    const name = stationNameInput.value.trim();
    const lat = Number(stationLatInput.value);
    const lon = Number(stationLonInput.value);
    const minElevDeg = clampElev(Number(stationElevInput.value));

    if (!name) { window.alert('Station name is required.'); stationNameInput.focus(); return; }
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      window.alert('Valid latitude and longitude are required.');
      return;
    }

    stationBusy = true;
    stationSaveBtn.disabled = true;
    try {
      if (stationFormMode === 'edit') {
        await updateStation(stationEditingId, { name, lat, lon, minElevDeg });
      } else {
        const stationId = generateStationId();
        await createStation({ id: stationId, name, lat, lon, minElevDeg });
        await createAntenna({
          id: `${stationId}_ant1`,
          stationId,
          name: `${name} Primary`,
          type: 'primary',
        });
      }

      await refreshAll();
      hideStationForm();
    } catch (error) {
      console.error('Failed to save station:', error);
      window.alert(error instanceof Error ? error.message : 'Failed to save station.');
    } finally {
      stationBusy = false;
      stationSaveBtn.disabled = false;
    }
  });

  stationList.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const editBtn = target.closest('[data-action="edit-station"]');
    if (editBtn) {
      const stationId = editBtn.getAttribute('data-station-id') || '';
      const station = getState().stations?.[stationId];
      if (!station) return;

      stationFormMode = 'edit';
      stationEditingId = station.id;
      stationFormTitle.textContent = 'Edit Ground Station';
      stationNameInput.value = station.name || '';
      stationLatInput.value = station.lat != null ? String(station.lat) : '';
      stationLonInput.value = station.lon != null ? String(station.lon) : '';
      stationElevInput.value = station.minElevDeg != null ? String(station.minElevDeg) : '5';
      showStationForm();
      return;
    }

    const deleteBtn = target.closest('[data-action="delete-station"]');
    if (deleteBtn) {
      const stationId = deleteBtn.getAttribute('data-station-id') || '';
      const station = getState().stations?.[stationId];
      if (!station) return;

      const ok = window.confirm(`Delete station "${station.name || station.id}"?\nThis will also remove related antennas and mappings.`);
      if (!ok) return;

      try {
        await deleteStation(station.id);
        await refreshAll();
        if (stationEditingId === station.id) hideStationForm();
        if (selectedAntennaStationId === station.id) {
          selectedAntennaStationId = '';
          antennaStationSel.value = '';
          hideAntennaForm();
          renderAntennaList();
        }
      } catch (error) {
        console.error('Failed to delete station:', error);
        window.alert(error instanceof Error ? error.message : 'Failed to delete station.');
      }
    }
  });

  // ─── Groups CRUD ───

  if (groupAddBtn) {
    groupAddBtn.addEventListener('click', () => {
      groupFormMode = 'add';
      groupEditingId = '';
      groupFormTitle.textContent = 'Add Group';
      groupNameInput.value = '';
      groupNameInput.readOnly = false;
      groupLabelInput.value = '';
      groupColorInput.value = '#7dd3fc';
      groupColorHex.textContent = '#7dd3fc';
      const existing = getSortedGroups();
      const maxSort = existing.reduce((m, g) => Math.max(m, g.sortOrder || 0), 0);
      groupSortInput.value = String(maxSort + 10);
      groupSchedulableInput.checked = true;
      showGroupForm();
    });
  }

  if (groupCancelBtn) {
    groupCancelBtn.addEventListener('click', hideGroupForm);
  }

  if (groupColorInput && groupColorHex) {
    groupColorInput.addEventListener('input', () => {
      groupColorHex.textContent = groupColorInput.value;
    });
  }

  if (groupSaveBtn) {
    groupSaveBtn.addEventListener('click', async () => {
      if (groupBusy) return;
      const label = (groupLabelInput.value || '').trim();
      if (!label) {
        window.alert('Label is required.');
        return;
      }
      const nameRaw = (groupNameInput.value || '').trim();
      const color = groupColorInput.value || '#7dd3fc';
      const sortOrderNum = Number(groupSortInput.value);
      const sortOrder = Number.isFinite(sortOrderNum) ? sortOrderNum : 0;
      const schedulable = !!groupSchedulableInput.checked;

      const payload = { label, color, sortOrder, schedulable };
      if (nameRaw) payload.name = nameRaw;
      else if (groupFormMode === 'add') payload.name = label;

      groupBusy = true;
      groupSaveBtn.disabled = true;
      try {
        if (groupFormMode === 'add') {
          await createGroup(payload);
        } else {
          await updateGroup(groupEditingId, payload);
        }
        await refreshAll();
        hideGroupForm();
      } catch (error) {
        console.error('Failed to save group:', error);
        window.alert(error instanceof Error ? error.message : 'Failed to save group.');
      } finally {
        groupBusy = false;
        groupSaveBtn.disabled = false;
      }
    });
  }

  if (groupList) {
    groupList.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const editBtn = target.closest('[data-action="edit-group"]');
      if (editBtn) {
        const id = editBtn.getAttribute('data-group-id') || '';
        const group = getState().groups?.[id];
        if (!group) return;
        groupFormMode = 'edit';
        groupEditingId = id;
        groupFormTitle.textContent = 'Edit Group';
        groupNameInput.value = group.name || '';
        groupNameInput.readOnly = false;
        groupLabelInput.value = group.label || '';
        const color = group.color || '#7dd3fc';
        groupColorInput.value = color;
        groupColorHex.textContent = color;
        groupSortInput.value = String(group.sortOrder ?? 0);
        groupSchedulableInput.checked = group.schedulable === true;
        showGroupForm();
        return;
      }

      const deleteBtn = target.closest('[data-action="delete-group"]');
      if (deleteBtn) {
        const id = deleteBtn.getAttribute('data-group-id') || '';
        const group = getState().groups?.[id];
        if (!group) return;
        const memberCount = Object.values(getState().satellites || {}).filter((s) => s?.groupName === group.name).length;
        if (id === 'custom' && memberCount > 0) {
          window.alert(`Cannot delete the "Custom" group while it has ${memberCount} satellite(s). Reassign them first.`);
          return;
        }
        const reassignMsg = id === 'custom'
          ? `Delete group "${group.label}"? It currently has no members.`
          : `Delete group "${group.label}"? ${memberCount} satellite(s) will be reassigned to "Custom".`;
        if (!window.confirm(reassignMsg)) return;
        try {
          await deleteGroup(id);
          await refreshAll();
          if (groupEditingId === id) hideGroupForm();
        } catch (error) {
          console.error('Failed to delete group:', error);
          window.alert(error instanceof Error ? error.message : 'Failed to delete group.');
        }
      }
    });
  }

  antennaStationSel.addEventListener('change', () => {
    selectedAntennaStationId = antennaStationSel.value || '';
    antennaAddBtn.disabled = !selectedAntennaStationId;
    hideAntennaForm();
    renderAntennaList();
  });

  antennaAddBtn.addEventListener('click', () => {
    if (!selectedAntennaStationId) return;
    antennaFormTitle.textContent = 'Add Antenna';
    antennaNameInput.value = '';
    antennaTypeInput.value = '';
    showAntennaForm();
  });

  antennaCancelBtn.addEventListener('click', hideAntennaForm);

  antennaSaveBtn.addEventListener('click', async () => {
    if (antennaBusy) return;
    if (!selectedAntennaStationId) {
      window.alert('Select a station first.');
      return;
    }

    const name = antennaNameInput.value.trim();
    const type = antennaTypeInput.value.trim();
    if (!name) { window.alert('Antenna name is required.'); antennaNameInput.focus(); return; }

    antennaBusy = true;
    antennaSaveBtn.disabled = true;
    try {
      await createAntenna({
        id: generateAntennaId(selectedAntennaStationId),
        stationId: selectedAntennaStationId,
        name,
        type,
      });
      await refreshAll();
      hideAntennaForm();
      renderAntennaList();
    } catch (error) {
      console.error('Failed to save antenna:', error);
      window.alert(error instanceof Error ? error.message : 'Failed to save antenna.');
    } finally {
      antennaBusy = false;
      antennaSaveBtn.disabled = false;
    }
  });

  antennaList.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const deleteBtn = target.closest('[data-action="delete-antenna"]');
    if (deleteBtn) {
      const antennaId = deleteBtn.getAttribute('data-antenna-id') || '';
      const antenna = getState().antennas?.[antennaId];
      if (!antenna) return;

      const ok = window.confirm(`Delete antenna "${antenna.name || antenna.id}"?\nMappings and mask will be removed.`);
      if (!ok) return;

      try {
        await deleteAntenna(antenna.id);
        await refreshAll();
      } catch (error) {
        console.error('Failed to delete antenna:', error);
        window.alert(error instanceof Error ? error.message : 'Failed to delete antenna.');
      }
      return;
    }

    const clearMaskBtn = target.closest('[data-action="clear-antenna-mask"]');
    if (clearMaskBtn) {
      const antennaId = clearMaskBtn.getAttribute('data-antenna-id') || '';
      if (!antennaId) return;
      if (!window.confirm('Clear azimuth mask for this antenna?')) return;

      try {
        await deleteAntennaMask(antennaId);
        await refreshAll();
      } catch (error) {
        console.error('Failed clearing mask:', error);
        window.alert(error instanceof Error ? error.message : 'Failed to clear mask.');
      }
    }
  });

  antennaList.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.matches('[data-action="import-antenna-mask"]')) return;

    const antennaId = target.getAttribute('data-antenna-id') || '';
    const file = target.files?.[0];
    if (!antennaId || !file) return;

    try {
      const csvText = await file.text();
      await uploadAntennaMask(antennaId, csvText);
      await refreshAll();
    } catch (error) {
      console.error('Failed importing mask CSV:', error);
      window.alert(error instanceof Error ? error.message : 'Failed to import mask CSV.');
    } finally {
      target.value = '';
    }
  });

  mappingTree.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const removeBtn = target.closest('[data-action="remove-mapping"]');
    if (removeBtn) {
      const mappingId = removeBtn.getAttribute('data-mapping-id') || '';
      if (!mappingId) return;
      try {
        await deleteMapping(mappingId);
        await refreshAll();
      } catch (error) {
        console.error('Failed removing mapping:', error);
        window.alert(error instanceof Error ? error.message : 'Failed to remove mapping.');
      }
      return;
    }

    const addBtn = target.closest('[data-action="add-mapping"]');
    if (addBtn) {
      const antennaId = addBtn.getAttribute('data-antenna-id') || '';
      if (!antennaId) return;
      const satSelect = mappingTree.querySelector(`.mapping-add-satellite-select[data-antenna-id="${cssEscape(antennaId)}"]`);
      const roleSelect = mappingTree.querySelector(`.mapping-add-role-select[data-antenna-id="${cssEscape(antennaId)}"]`);
      if (!(satSelect instanceof HTMLSelectElement) || !satSelect.value) return;
      const role = roleSelect instanceof HTMLSelectElement ? roleSelect.value : 'primary';

      try {
        await createMapping({ antennaId, satelliteId: satSelect.value, role });
        await refreshAll();
      } catch (error) {
        console.error('Failed creating mapping:', error);
        window.alert(error instanceof Error ? error.message : 'Failed to add mapping.');
      }
    }
  });

  mappingTree.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;

    if (target.getAttribute('data-action') === 'change-role') {
      const mappingId = target.getAttribute('data-mapping-id') || '';
      const newRole = target.value;
      if (!mappingId || !newRole) return;
      try {
        await updateMappingRole(mappingId, newRole);
        await refreshAll();
      } catch (error) {
        console.error('Failed changing role:', error);
        // Revert select to previous value
        await refreshAll();
      }
    }
  });

  subscribe('satellites', () => {
    renderSatelliteList();
    renderMappingTree();
  });

  subscribe('groups', () => {
    renderGroupList();
    renderSatGroupDropdown();
    renderImportTargetGroup();
    renderSatelliteList();
  });

  subscribe('stations', () => {
    syncSelectedAntennaStation();
    renderStationList();
    renderAntennaStationSelector();
    renderAntennaList();
    renderMappingTree();
  });

  subscribe('antennas', () => {
    renderStationList();
    renderAntennaList();
    renderMappingTree();
  });

  subscribe('antennaMappings', () => {
    renderMappingTree();
  });

  function setActiveSection(key) {
    navButtons.forEach((button) => {
      const k = button.getAttribute('data-cfg-section') || '';
      if (k === key) button.classList.add('active');
      else button.classList.remove('active');
    });
    for (const [k, panel] of Object.entries(sectionByKey)) {
      if (!panel) continue;
      panel.classList.toggle('cfg-section-active', k === key);
    }
  }

  function renderSatelliteList() {
    const satellites = Object.values(getState().satellites || {})
      .sort((a, b) => ((a.groupName || '').localeCompare(b.groupName || '') || (a.name || '').localeCompare(b.name || '')));

    if (satellites.length === 0) {
      satList.innerHTML = '<div class="cfg-empty">No satellites registered. Click <em>+ Add Satellite</em> to get started.</div>';
      return;
    }

    // Group by groupName
    const groups = new Map();
    for (const sat of satellites) {
      const g = sat.groupName || 'custom';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(sat);
    }

    let html = `<table class="cfg-tbl"><thead><tr>
      <th></th><th>Name</th><th>NORAD</th><th>Epoch</th><th>Active</th><th></th>
    </tr></thead><tbody>`;

    for (const [group, sats] of groups) {
      html += `<tr class="cfg-tbl-group"><td colspan="6">${escapeHtml(getGroupLabel(group))}<span class="cfg-tbl-group-count">${sats.length}</span></td></tr>`;
      for (const sat of sats) {
        const color = normalizeHexColor(sat.color || '#7dd3fc');
        const enabled = sat.enabled !== false;
        const epoch = extractTleEpochHint(sat.tleLine1 || sat.tle || '');
        html += `<tr class="cfg-tbl-row${enabled ? '' : ' is-disabled'}">
          <td><span class="cfg-dot" style="--c:${color}"></span></td>
          <td class="cfg-tbl-name">${escapeHtml(sat.name || sat.id)}</td>
          <td class="cfg-tbl-mono">${sat.noradId != null ? sat.noradId : '—'}</td>
          <td class="cfg-tbl-mono cfg-tbl-dim">${escapeHtml(epoch || '—')}</td>
          <td><label class="cfg-toggle"><input type="checkbox" data-action="toggle-satellite-enabled" data-satellite-id="${escapeHtmlAttr(sat.id)}" ${enabled ? 'checked' : ''}><span class="cfg-toggle-track"></span></label></td>
          <td class="cfg-tbl-actions"><button class="cfg-btn cfg-btn-sm" data-action="edit-satellite" data-satellite-id="${escapeHtmlAttr(sat.id)}">Edit</button><button class="cfg-btn cfg-btn-sm cfg-btn-danger" data-action="delete-satellite" data-satellite-id="${escapeHtmlAttr(sat.id)}">Del</button></td>
        </tr>`;
      }
    }

    html += '</tbody></table>';
    satList.innerHTML = html;
  }

  function renderStationList() {
    const stations = Object.values(getState().stations || {})
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || ''));
    const antCount = countAntennasByStation(getState().antennas || {});

    if (stations.length === 0) {
      stationList.innerHTML = '<div class="cfg-empty">No ground stations registered.</div>';
      return;
    }

    let html = `<table class="cfg-tbl"><thead><tr>
      <th>Name</th><th>Lat</th><th>Lon</th><th>Min EL</th><th>Antennas</th><th></th>
    </tr></thead><tbody>`;

    for (const st of stations) {
      html += `<tr class="cfg-tbl-row">
        <td class="cfg-tbl-name">${escapeHtml(st.name || st.id)}</td>
        <td class="cfg-tbl-mono">${formatCoord(st.lat)}</td>
        <td class="cfg-tbl-mono">${formatCoord(st.lon)}</td>
        <td class="cfg-tbl-mono">${Number(st.minElevDeg || 0).toFixed(1)}°</td>
        <td class="cfg-tbl-mono">${antCount[st.id] || 0}</td>
        <td class="cfg-tbl-actions"><button class="cfg-btn cfg-btn-sm" data-action="edit-station" data-station-id="${escapeHtmlAttr(st.id)}">Edit</button><button class="cfg-btn cfg-btn-sm cfg-btn-danger" data-action="delete-station" data-station-id="${escapeHtmlAttr(st.id)}">Del</button></td>
      </tr>`;
    }

    html += '</tbody></table>';
    stationList.innerHTML = html;
  }

  function renderAntennaStationSelector() {
    const stations = Object.values(getState().stations || {})
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || ''));

    const selected = selectedAntennaStationId || antennaStationSel.value || '';
    antennaStationSel.innerHTML = `<option value="">Select station…</option>${stations
      .map((station) => `<option value="${escapeHtmlAttr(station.id)}">${escapeHtml(station.name || station.id)}</option>`)
      .join('')}`;

    if (selected && stations.some((station) => station.id === selected)) {
      antennaStationSel.value = selected;
      selectedAntennaStationId = selected;
    } else {
      antennaStationSel.value = '';
      selectedAntennaStationId = '';
    }

    antennaAddBtn.disabled = !selectedAntennaStationId;
  }

  function renderAntennaList() {
    if (!selectedAntennaStationId) {
      antennaList.innerHTML = '<div class="sm-empty">Select a station to view antennas.</div>';
      return;
    }

    const station = getState().stations?.[selectedAntennaStationId];
    if (!station) {
      antennaList.innerHTML = '<div class="sm-empty">Selected station not found.</div>';
      return;
    }

    const antennas = Object.values(getState().antennas || {})
      .filter((antenna) => antenna.stationId === selectedAntennaStationId)
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || ''));

    if (antennas.length === 0) {
      antennaList.innerHTML = `<div class="sm-empty">No antennas found for ${escapeHtml(station.name || station.id)}.</div>`;
      return;
    }

    let html = `<table class="cfg-tbl"><thead><tr>
      <th>Name</th><th>Type</th><th>Mask</th><th></th>
    </tr></thead><tbody>`;

    for (const antenna of antennas) {
      const maskCount = Array.isArray(antenna.mask) ? antenna.mask.length : 0;
      html += `<tr class="cfg-tbl-row">
        <td class="cfg-tbl-name">${escapeHtml(antenna.name || antenna.id)}</td>
        <td><span class="cfg-badge cfg-badge-group">${escapeHtml(antenna.type || '—')}</span></td>
        <td>${maskCount > 0 ? `<span class="cfg-badge cfg-badge-enabled">${maskCount} pts</span>` : '<span class="cfg-tbl-dim">None</span>'}</td>
        <td class="cfg-tbl-actions">
          <label class="cfg-btn cfg-btn-sm cfg-mask-label cfg-mask-import">
            <input type="file" accept=".csv,text/csv" data-action="import-antenna-mask" data-antenna-id="${escapeHtmlAttr(antenna.id)}">CSV
          </label>
          ${maskCount > 0 ? `<button class="cfg-btn cfg-btn-sm" data-action="clear-antenna-mask" data-antenna-id="${escapeHtmlAttr(antenna.id)}">Clear</button>` : ''}
          <button class="cfg-btn cfg-btn-sm cfg-btn-danger" data-action="delete-antenna" data-antenna-id="${escapeHtmlAttr(antenna.id)}">Del</button>
        </td>
      </tr>`;
    }

    html += '</tbody></table>';
    antennaList.innerHTML = html;
  }

  function saveOpenState() {
    openDetails.clear();
    mappingTree.querySelectorAll('details[open]').forEach((el) => {
      const key = el.getAttribute('data-key');
      if (key) openDetails.add(key);
    });
  }

  function restoreOpenState() {
    mappingTree.querySelectorAll('details[data-key]').forEach((el) => {
      if (openDetails.has(el.getAttribute('data-key'))) el.open = true;
    });
  }

  function renderMappingTree() {
    const stations = Object.values(getState().stations || {})
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || ''));
    const antennas = getState().antennas || {};
    const mappings = Array.isArray(getState().antennaMappings) ? getState().antennaMappings : [];
    const allSatellites = Object.values(getState().satellites || {})
      .filter((s) => s?.enabled !== false)
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || ''));

    if (stations.length === 0) {
      mappingTree.innerHTML = '<div class="cfg-empty">No stations loaded.</div>';
      return;
    }

    saveOpenState();

    mappingTree.innerHTML = stations.map((station) => {
      const stationAntennas = Object.values(antennas)
        .filter((antenna) => antenna.stationId === station.id)
        .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || ''));

      const antennaHtml = stationAntennas.map((antenna) => {
        const antennaMappings = mappings.filter((m) => m?.antennaId === antenna.id && m?.satelliteId);
        const mappedSatIds = new Set(antennaMappings.map((m) => m.satelliteId));
        const addOptions = allSatellites
          .filter((sat) => !mappedSatIds.has(sat.id))
          .map((sat) => `<option value="${escapeHtmlAttr(sat.id)}">${escapeHtml(sat.name || sat.id)}</option>`)
          .join('');
        const maskCount = Array.isArray(antenna.mask) ? antenna.mask.length : 0;

        return `
          <details class="mapping-antenna" data-key="ant-${escapeHtmlAttr(antenna.id)}">
            <summary>
              <span>${escapeHtml(antenna.name || antenna.id)}</span>
              <span class="mapping-mask-indicator ${maskCount > 0 ? 'has-mask' : ''}">${maskCount > 0 ? `Mask: ${maskCount}` : 'No mask'}</span>
              <span class="mapping-count">[${antennaMappings.length} sats]</span>
            </summary>
            <div class="mapping-antenna-body">
              ${antennaMappings.map((mapping) => {
                const sat = allSatellites.find((s) => s.id === mapping.satelliteId);
                if (!sat) return '';
                const role = mapping.role || 'primary';
                return `
                  <div class="mapping-sat-item">
                    <span class="cfg-dot" style="--c:${normalizeHexColor(sat.color || '#7dd3fc')}"></span>
                    <span class="mapping-sat-name">${escapeHtml(sat.name || sat.id)}</span>
                    <select class="cfg-role-select cfg-role-${role}" data-action="change-role" data-mapping-id="${escapeHtmlAttr(String(mapping.id))}">
                      <option value="primary" ${role === 'primary' ? 'selected' : ''}>Primary</option>
                      <option value="backup" ${role === 'backup' ? 'selected' : ''}>Backup</option>
                    </select>
                    <button type="button" class="mapping-sat-remove" data-action="remove-mapping" data-mapping-id="${escapeHtmlAttr(String(mapping.id))}" title="Remove">×</button>
                  </div>
                `;
              }).join('') || '<div class="mapping-sat-item mapping-sat-empty">No satellite mappings</div>'}

              <div class="mapping-add-row">
                <select class="mapping-add-satellite-select" data-antenna-id="${escapeHtmlAttr(antenna.id || '')}">
                  <option value="">Select satellite…</option>
                  ${addOptions}
                </select>
                <select class="mapping-add-role-select" data-antenna-id="${escapeHtmlAttr(antenna.id || '')}">
                  <option value="primary">Primary</option>
                  <option value="backup">Backup</option>
                </select>
                <button type="button" data-action="add-mapping" data-antenna-id="${escapeHtmlAttr(antenna.id || '')}" ${addOptions ? '' : 'disabled'}>Add</button>
              </div>
            </div>
          </details>
        `;
      }).join('');

      return `
        <details class="mapping-station" data-key="sta-${escapeHtmlAttr(station.id)}" open>
          <summary>
            <span>${escapeHtml(station.name || station.id)}</span>
            <span class="mapping-count">[${stationAntennas.length} antennas]</span>
          </summary>
          <div class="mapping-station-body">
            ${antennaHtml || '<div class="mapping-sat-item mapping-sat-empty">No antennas configured</div>'}
          </div>
        </details>
      `;
    }).join('');

    restoreOpenState();
  }

  async function refreshAll() {
    try {
      const [stations, antennas, mappings, satellites, groups] = await Promise.all([
        fetchStations(), fetchAntennas(), fetchMappings(), fetchSatellites(), fetchGroups(),
      ]);

      const maskByAntennaId = await fetchMaskMapForAntennas(antennas);
      const parsed = parseStationsAndAntennas(stations, antennas, maskByAntennaId);
      replaceObjectSlice('stations', parsed.stationRecord);
      replaceObjectSlice('antennas', parsed.antennaRecord);
      patch('antennaMappings', Array.isArray(mappings) ? mappings : []);
      replaceObjectSlice('satellites', toSatelliteRecord(satellites));
      replaceObjectSlice('groups', toGroupRecord(groups));
    } catch (error) {
      console.error('Configuration refreshAll failed:', error);
    }
  }

  function replaceObjectSlice(sliceName, nextValue) {
    patch(sliceName, (current) => {
      for (const key of Object.keys(current)) delete current[key];
      return nextValue;
    });
  }

  function showSatelliteForm() { satForm.style.display = ''; }
  function hideSatelliteForm() { satForm.style.display = 'none'; satFormMode = 'add'; satEditingId = ''; }
  function showStationForm() { stationForm.style.display = ''; }
  function hideStationForm() { stationForm.style.display = 'none'; stationFormMode = 'add'; stationEditingId = ''; }
  function showAntennaForm() { antennaForm.style.display = ''; }
  function hideAntennaForm() { antennaForm.style.display = 'none'; }
  function showGroupForm() { if (groupForm) groupForm.style.display = ''; }
  function hideGroupForm() { if (groupForm) groupForm.style.display = 'none'; groupFormMode = 'add'; groupEditingId = ''; }

  function renderGroupList() {
    if (!groupList) return;
    const groups = getSortedGroups();
    if (groups.length === 0) {
      groupList.innerHTML = '<div class="cfg-empty">No groups defined.</div>';
      return;
    }
    const memberCountsByName = {};
    for (const sat of Object.values(getState().satellites || {})) {
      const key = sat?.groupName || '';
      if (!key) continue;
      memberCountsByName[key] = (memberCountsByName[key] || 0) + 1;
    }

    const rows = groups.map((g) => {
      const memberCount = memberCountsByName[g.name] || 0;
      const swatchColor = normalizeHexColor(g.color || '#7dd3fc');
      const schedBadge = g.schedulable
        ? '<span class="cfg-badge-yes">Yes</span>'
        : '<span class="cfg-badge-no">No</span>';
      const isCustomWithMembers = g.id === 'custom' && memberCount > 0;
      return `
        <tr class="cfg-tbl-row">
          <td><span class="cfg-color-swatch" style="background:${swatchColor}"></span><span class="cfg-tbl-name">${escapeHtml(g.label)}</span></td>
          <td class="cfg-tbl-mono">${escapeHtml(g.name)}</td>
          <td>${g.sortOrder ?? 0}</td>
          <td>${schedBadge}</td>
          <td>${memberCount}</td>
          <td class="cfg-tbl-actions">
            <button class="cfg-btn cfg-btn-sm" data-action="edit-group" data-group-id="${escapeHtmlAttr(g.id)}">Edit</button>
            <button class="cfg-btn cfg-btn-sm cfg-btn-danger" data-action="delete-group" data-group-id="${escapeHtmlAttr(g.id)}"${isCustomWithMembers ? ' title="Reassign members first"' : ''}>Delete</button>
          </td>
        </tr>
      `;
    }).join('');

    groupList.innerHTML = `<table class="cfg-tbl"><thead><tr>
      <th>Label</th><th>Name (id)</th><th>Sort</th><th>Schedulable</th><th>Members</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderSatGroupDropdown() {
    if (!satGroupInput) return;
    const groups = getSortedGroups();
    const currentVal = satGroupInput.value;
    if (groups.length === 0) {
      satGroupInput.innerHTML = '<option value="">(no groups)</option>';
      return;
    }
    satGroupInput.innerHTML = groups
      .map((g) => `<option value="${escapeHtmlAttr(g.name)}">${escapeHtml(g.label)}</option>`)
      .join('');
    if (currentVal && groups.some((g) => g.name === currentVal)) {
      satGroupInput.value = currentVal;
    }
  }

  function syncSelectedAntennaStation() {
    const stations = getState().stations || {};
    if (!selectedAntennaStationId || !stations[selectedAntennaStationId]) {
      selectedAntennaStationId = Object.keys(stations)[0] || '';
    }
    antennaAddBtn.disabled = !selectedAntennaStationId;
  }
}

function toSatelliteRecord(satellites) {
  return (Array.isArray(satellites) ? satellites : []).reduce((acc, sat) => {
    if (!sat?.id) return acc;
    const tleLine0 = String(sat.tleLine0 || '');
    const tleLine1 = String(sat.tleLine1 || '');
    const tleLine2 = String(sat.tleLine2 || '');
    acc[sat.id] = {
      id: sat.id,
      name: sat.name || sat.id,
      noradId: sat.noradId != null ? Number(sat.noradId) : null,
      groupName: sat.groupName || '',
      tleLine0,
      tleLine1,
      tleLine2,
      tle: [tleLine0, tleLine1, tleLine2].filter(Boolean).join('\n'),
      color: normalizeHexColor(sat.color || '#7dd3fc'),
      enabled: sat.enabled !== false,
    };
    return acc;
  }, {});
}

function toGroupRecord(groups) {
  return (Array.isArray(groups) ? groups : []).reduce((acc, g) => {
    if (!g?.id) return acc;
    acc[g.id] = {
      id: g.id,
      name: g.name,
      label: g.label,
      color: g.color || '',
      sortOrder: typeof g.sortOrder === 'number' ? g.sortOrder : 0,
      schedulable: g.schedulable === true,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
    return acc;
  }, {});
}

function parseStationsAndAntennas(stations, antennas = [], maskByAntennaId = {}) {
  const stationRecord = {};
  for (const station of Array.isArray(stations) ? stations : []) {
    if (!station?.id) continue;
    stationRecord[station.id] = {
      id: station.id,
      name: station.name,
      lat: Number(station.lat),
      lon: Number(station.lon),
      minElevDeg: Number.isFinite(Number(station.minElevDeg)) ? Number(station.minElevDeg) : 5,
      antennas: [],
    };
  }

  const antennaRecord = {};
  for (const antenna of Array.isArray(antennas) ? antennas : []) {
    if (!antenna?.id || !antenna?.stationId) continue;
    const normalized = {
      id: antenna.id,
      stationId: antenna.stationId,
      name: antenna.name || antenna.id,
      type: antenna.type || '',
      mask: Array.isArray(maskByAntennaId[antenna.id]) ? maskByAntennaId[antenna.id] : [],
    };
    antennaRecord[antenna.id] = normalized;
    if (stationRecord[antenna.stationId]) {
      stationRecord[antenna.stationId].antennas.push({
        id: normalized.id,
        name: normalized.name,
        type: normalized.type,
        mask: normalized.mask,
      });
    }
  }

  return { stationRecord, antennaRecord };
}

async function fetchMaskMapForAntennas(antennas = []) {
  const maskByAntennaId = {};
  await Promise.all((Array.isArray(antennas) ? antennas : []).map(async (antenna) => {
    if (!antenna?.id) return;
    try {
      const response = await fetchAntennaMask(antenna.id);
      maskByAntennaId[antenna.id] = Array.isArray(response?.entries) ? response.entries : [];
    } catch {
      maskByAntennaId[antenna.id] = [];
    }
  }));
  return maskByAntennaId;
}

function countAntennasByStation(antennas) {
  return Object.values(antennas || {}).reduce((acc, a) => {
    if (a?.stationId) acc[a.stationId] = (acc[a.stationId] || 0) + 1;
    return acc;
  }, {});
}

function splitTleText(tleText) {
  const lines = String(tleText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const line1 = lines.find((line) => line.startsWith('1 ')) || '';
  const line2 = lines.find((line) => line.startsWith('2 ')) || '';
  const line0 = lines[0] && lines[0] !== line1 && lines[0] !== line2 ? lines[0] : '';
  return { line0, line1, line2 };
}

function buildTleText(sat) {
  return [sat?.tleLine0 || '', sat?.tleLine1 || '', sat?.tleLine2 || ''].filter(Boolean).join('\n');
}

function extractTleEpochHint(line1OrTle) {
  const line1 = String(line1OrTle || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('1 ')) || '';
  if (line1.length < 32) return '';
  return line1.slice(18, 32).trim();
}

function normalizeOptionalInteger(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeHexColor(input) {
  const raw = String(input || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : '#7dd3fc';
}

function clampElev(value) { return Number.isFinite(value) ? Math.max(0, Math.min(90, value)) : 5; }
function formatCoord(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '—'; }
function generateStationId() { return `gs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`; }
function generateAntennaId(stationId) { return `${stationId}_ant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`; }
function cssEscape(value) { return String(value).replaceAll('"', '\\"'); }
function escapeHtmlAttr(text) { return escapeHtml(text).replaceAll('`', '&#096;'); }
function escapeHtml(text) { return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
