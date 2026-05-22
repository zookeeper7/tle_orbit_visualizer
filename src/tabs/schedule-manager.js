import { getState, patch, subscribe } from '../core/app-store.js';
import { isGroupSchedulable } from '../core/groups.js';
import { parseTLE } from '../orbit.js';
import { computePasses } from '../pass-prediction.js';
import { detectConflicts } from '../core/conflict-detection.js';
import {
  bulkUpsertPasses,
  getSetting,
  putSetting,
  updatePass,
} from '../core/api.js';

const STATUS_FLOW = ['predicted', 'selected', 'confirmed'];
const SCHEDULE_SELECTION_KEY = 'schedule-manager-selection';

/**
 * @typedef {'predicted'|'selected'|'confirmed'|'rejected'|'cancelled'} PassStatus
 */

export function initScheduleManager() {
  const section = document.getElementById('tab-schedule-manager');
  if (!section) return;

  const satSelector = document.getElementById('smSatelliteSelector');
  const startInput = document.getElementById('smStartDate');
  const endInput = document.getElementById('smEndDate');
  const startDateManual = document.getElementById('smStartDateManual');
  const startHourSelect = document.getElementById('smStartHour');
  const startMinuteSelect = document.getElementById('smStartMinute');
  const endDateManual = document.getElementById('smEndDateManual');
  const endHourSelect = document.getElementById('smEndHour');
  const endMinuteSelect = document.getElementById('smEndMinute');
  const shiftPrevDayBtn = document.getElementById('smShiftPrevDayBtn');
  const shiftNextDayBtn = document.getElementById('smShiftNextDayBtn');
  const startPrevDayBtn = document.getElementById('smStartPrevDayBtn');
  const startNextDayBtn = document.getElementById('smStartNextDayBtn');
  const endPrevDayBtn = document.getElementById('smEndPrevDayBtn');
  const endNextDayBtn = document.getElementById('smEndNextDayBtn');
  const windowDuration = document.getElementById('smWindowDuration');
  const windowHint = document.getElementById('smWindowHint');
  const computeBtn = document.getElementById('smComputeBtn');
  const recomputeBtn = document.getElementById('smRecomputeBtn');
  const resultsPrevDayBtn = document.getElementById('smResultsPrevDayBtn');
  const resultsNextDayBtn = document.getElementById('smResultsNextDayBtn');
  const resultsWindowLabel = document.getElementById('smResultsWindowLabel');
  const saveDefaultBtn = document.getElementById('smSaveDefaultBtn');
  const mappingToggle = document.getElementById('smMappingToggle');
  const mappingPanel = document.getElementById('smMappingPanel');
  const mappingTree = document.getElementById('smMappingTree');
  const passCount = document.getElementById('smPassCount');
  const conflictCount = document.getElementById('smConflictCount');
  const exportCsvBtn = document.getElementById('smExportCsvBtn');
  const tableView = document.getElementById('smTableView');
  const ganttView = document.getElementById('smGanttView');
  const table = document.getElementById('smPassTable');
  const passBody = document.getElementById('smPassBody');
  const empty = document.getElementById('smPassEmpty');

  // Column filter DOM (multi-checkbox dropdowns)
  const mcfSat = document.getElementById('smColFilterSat');
  const mcfStation = document.getElementById('smColFilterStation');
  const mcfAntenna = document.getElementById('smColFilterAntenna');
  const colFilterMinEl = document.getElementById('smColFilterMinEl');
  const mcfStatus = document.getElementById('smColFilterStatus');
  const mcfConflict = document.getElementById('smColFilterConflict');

  // Bulk selection
  const bulkBar = document.getElementById('smBulkBar');
  const bulkCount = document.getElementById('smBulkCount');
  const bulkClear = document.getElementById('smBulkClear');
  const selectedPassIds = new Set();
  let lastClickedPassId = '';
  let renderedPassIds = []; // ordered pass IDs as currently rendered in the table

  /** @type {Record<string, Set<string>>} Multi-select filter state */
  const mcfState = {
    sat: new Set(),
    station: new Set(),
    antenna: new Set(),
    status: new Set(),
    conflict: new Set(),
  };

  if (!satSelector || !startInput || !endInput || !startDateManual || !startHourSelect || !startMinuteSelect || !endDateManual || !endHourSelect || !endMinuteSelect || !shiftPrevDayBtn || !shiftNextDayBtn || !startPrevDayBtn || !startNextDayBtn || !endPrevDayBtn || !endNextDayBtn || !windowDuration || !windowHint || !computeBtn || !mappingToggle || !mappingPanel || !mappingTree || !passCount || !conflictCount || !exportCsvBtn || !table || !passBody || !empty) {
    return;
  }

  let satellites = buildSatelliteListFromStore();

  const defaultSatIds = satellites.slice(0, Math.min(4, satellites.length)).map((sat) => sat.id);
  const now = new Date();
  const plus24h = new Date(now.getTime() + 24 * 3600 * 1000);

  populateTimeSelectOptions(startHourSelect, 24);
  populateTimeSelectOptions(endHourSelect, 24);
  populateTimeSelectOptions(startMinuteSelect, 60);
  populateTimeSelectOptions(endMinuteSelect, 60);

  setManualTimeFields(now, startDateManual, startHourSelect, startMinuteSelect);
  setManualTimeFields(plus24h, endDateManual, endHourSelect, endMinuteSelect);
  syncHiddenTimeInputs();

  /** @type {{key:string,dir:'asc'|'desc'}} */
  let sort = { key: 'aos', dir: 'asc' };
  /** @type {Set<string>} */
  let selectedSatIds = new Set(defaultSatIds);
  /** @type {Set<string>} */
  let lastComputeCacheKey = '';

  renderSatelliteSelector();
  syncStoreUiState();
  renderMappingTree();
  renderTable();
  initializeDefaultSelection();
  refreshTimeWindowUi();

  computeBtn.addEventListener('click', () => {
    computeSchedule();
  });

  const emptyComputeLink = document.getElementById('smEmptyComputeLink');
  if (emptyComputeLink) {
    emptyComputeLink.addEventListener('click', (e) => {
      e.preventDefault();
      computeSchedule();
    });
  }

  section.querySelectorAll('.sm-time-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTimePreset(btn.getAttribute('data-sm-preset') || '24h');
    });
  });

  shiftPrevDayBtn.addEventListener('click', () => {
    shiftWindowByDays(-1);
  });

  shiftNextDayBtn.addEventListener('click', () => {
    shiftWindowByDays(1);
  });

  startPrevDayBtn.addEventListener('click', () => {
    shiftBoundaryByDays('start', -1);
  });

  startNextDayBtn.addEventListener('click', () => {
    shiftBoundaryByDays('start', 1);
  });

  endPrevDayBtn.addEventListener('click', () => {
    shiftBoundaryByDays('end', -1);
  });

  endNextDayBtn.addEventListener('click', () => {
    shiftBoundaryByDays('end', 1);
  });

  if (saveDefaultBtn) {
    saveDefaultBtn.addEventListener('click', () => {
      saveDefaultSelection();
    });
  }

  exportCsvBtn.addEventListener('click', () => {
    exportPassesCsv();
  });

  satSelector.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name !== 'sm-sat-select') return;

    if (target.checked) selectedSatIds.add(target.value);
    else selectedSatIds.delete(target.value);

    renderSatelliteSelector();
    syncStoreUiState();
  });

  satSelector.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const actionBtn = target.closest('[data-sm-sat-action]');
    if (!actionBtn) return;

    const action = actionBtn.getAttribute('data-sm-sat-action');
    if (action === 'all') {
      selectedSatIds = new Set(satellites.map((sat) => sat.id));
    } else if (action === 'none') {
      selectedSatIds.clear();
    }

    renderSatelliteSelector();
    syncStoreUiState();
  });

  // Satellite/Station sidebar filters removed — use column header filters instead

  // View toggle: Table ↔ Gantt
  let currentView = 'table';
  const viewBtns = section.querySelectorAll('.sm-view-btn');
  viewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view') || 'table';
      if (view === currentView) return;
      currentView = view;
      viewBtns.forEach((b) => b.classList.toggle('active', b === btn));
      if (tableView) tableView.style.display = view === 'table' ? '' : 'none';
      if (ganttView) ganttView.style.display = view === 'gantt' ? '' : 'none';
    });
  });

  mappingToggle.addEventListener('click', () => {
    mappingPanel.classList.toggle('collapsed');
    const expanded = !mappingPanel.classList.contains('collapsed');
    mappingToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const iconBtn = mappingToggle.querySelector('.sm-section-toggle');
    if (iconBtn) iconBtn.textContent = expanded ? '▾' : '▸';
  });

  // Mapping/antenna/mask CRUD is now in Configuration tab (read-only view here)

  table.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (!key) return;
      if (sort.key === key) {
        sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sort = { key, dir: 'asc' };
      }
      applySortHeaders();
      renderTable();
    });
  });

  passBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const row = target.closest('tr[data-pass-id]');
    if (!row) return;
    const passId = row.getAttribute('data-pass-id');
    if (!passId) return;

    // Status/reject buttons work on individual rows (bypass selection)
    if (target.closest('.sm-status-btn')) {
      await cycleStatus(passId);
      return;
    }
    if (target.closest('.sm-reject-btn')) {
      await setRejected(passId);
      return;
    }

    // Row click = selection
    let deselectedByPlainClick = false;
    if (event.shiftKey && lastClickedPassId) {
      // Shift+click: range select from last clicked to current
      const fromIdx = renderedPassIds.indexOf(lastClickedPassId);
      const toIdx = renderedPassIds.indexOf(passId);
      if (fromIdx !== -1 && toIdx !== -1) {
        const lo = Math.min(fromIdx, toIdx);
        const hi = Math.max(fromIdx, toIdx);
        for (let i = lo; i <= hi; i++) {
          selectedPassIds.add(renderedPassIds[i]);
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      // Ctrl+click: toggle individual
      if (selectedPassIds.has(passId)) selectedPassIds.delete(passId);
      else selectedPassIds.add(passId);
    } else {
      // Plain click: toggle off when re-clicking the same single-selected row
      if (selectedPassIds.size === 1 && selectedPassIds.has(passId)) {
        selectedPassIds.clear();
        deselectedByPlainClick = true;
      } else {
        selectedPassIds.clear();
        selectedPassIds.add(passId);
      }
    }

    lastClickedPassId = deselectedByPlainClick ? '' : passId;
    applyRowSelection();
    updateBulkBar();
  });

  // Bulk action buttons
  if (bulkBar) {
    bulkBar.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const statusBtn = target.closest('[data-bulk-status]');
      if (statusBtn) {
        const newStatus = statusBtn.getAttribute('data-bulk-status');
        if (!newStatus || selectedPassIds.size === 0) return;
        await bulkSetStatus(newStatus);
        return;
      }

      if (target.closest('#smBulkClear')) {
        clearSelection();
      }
    });
  }

  // ─── Context menu (right-click) ───

  let ctxMenu = null;

  function showContextMenu(x, y) {
    hideContextMenu();
    const count = selectedPassIds.size;
    if (count === 0) return;

    ctxMenu = document.createElement('div');
    ctxMenu.className = 'sm-ctx-menu';
    ctxMenu.innerHTML = `
      <div class="sm-ctx-header">${count} pass${count > 1 ? 'es' : ''} selected</div>
      <button class="sm-ctx-item" data-ctx-status="predicted"><span class="sm-ctx-dot sm-status-predicted"></span>Predicted</button>
      <button class="sm-ctx-item" data-ctx-status="selected"><span class="sm-ctx-dot sm-status-selected"></span>Selected</button>
      <button class="sm-ctx-item" data-ctx-status="confirmed"><span class="sm-ctx-dot sm-status-confirmed"></span>Confirmed</button>
      <button class="sm-ctx-item" data-ctx-status="rejected"><span class="sm-ctx-dot sm-status-rejected"></span>Rejected</button>
      <div class="sm-ctx-sep"></div>
      <button class="sm-ctx-item sm-ctx-clear">Clear Selection</button>
    `;
    document.body.appendChild(ctxMenu);

    // Position: keep within viewport
    const rect = ctxMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    ctxMenu.style.left = `${Math.min(x, maxX)}px`;
    ctxMenu.style.top = `${Math.min(y, maxY)}px`;

    ctxMenu.addEventListener('click', async (e) => {
      const target = e.target instanceof HTMLElement ? e.target.closest('[data-ctx-status]') : null;
      if (target) {
        const status = target.getAttribute('data-ctx-status');
        if (status) {
          hideContextMenu();
          await bulkSetStatus(status);
        }
        return;
      }
      const clearBtn = e.target instanceof HTMLElement ? e.target.closest('.sm-ctx-clear') : null;
      if (clearBtn) {
        hideContextMenu();
        clearSelection();
      }
    });

    // Close on any outside click or Escape
    setTimeout(() => {
      document.addEventListener('click', onCtxOutsideClick, { once: true });
      document.addEventListener('keydown', onCtxEscape);
    }, 0);
  }

  function hideContextMenu() {
    if (ctxMenu) {
      ctxMenu.remove();
      ctxMenu = null;
    }
    document.removeEventListener('click', onCtxOutsideClick);
    document.removeEventListener('keydown', onCtxEscape);
  }

  function onCtxOutsideClick(e) {
    if (ctxMenu && !ctxMenu.contains(e.target)) hideContextMenu();
    else if (ctxMenu) {
      // Re-attach if click was inside menu (menu handles its own clicks)
      setTimeout(() => document.addEventListener('click', onCtxOutsideClick, { once: true }), 0);
    }
  }

  function onCtxEscape(e) {
    if (e.key === 'Escape') hideContextMenu();
  }

  passBody.addEventListener('contextmenu', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const row = target.closest('tr[data-pass-id]');
    if (!row) return;
    const passId = row.getAttribute('data-pass-id');
    if (!passId) return;

    event.preventDefault();

    // If right-clicked row is not in selection, select it alone
    if (!selectedPassIds.has(passId)) {
      selectedPassIds.clear();
      selectedPassIds.add(passId);
      lastClickedPassId = passId;
      applyRowSelection();
      updateBulkBar();
    }

    showContextMenu(event.clientX, event.clientY);
  });

  function applyRowSelection() {
    passBody.querySelectorAll('tr[data-pass-id]').forEach((row) => {
      const id = row.getAttribute('data-pass-id') || '';
      row.classList.toggle('is-selected', selectedPassIds.has(id));
    });
  }

  function updateBulkBar() {
    if (!bulkBar || !bulkCount) return;
    if (selectedPassIds.size === 0) {
      bulkBar.style.display = 'none';
    } else {
      bulkBar.style.display = '';
      bulkCount.textContent = `${selectedPassIds.size} selected`;
    }
  }

  function clearSelection() {
    selectedPassIds.clear();
    lastClickedPassId = '';
    applyRowSelection();
    updateBulkBar();
  }

  async function bulkSetStatus(newStatus) {
    const ids = [...selectedPassIds];
    const allPasses = getState().passes || {};
    const updates = {};
    const apiCalls = [];

    for (const id of ids) {
      const pass = allPasses[id];
      if (!pass || pass.status === newStatus) continue;
      updates[id] = { ...pass, status: newStatus };
      apiCalls.push(updatePass(id, { status: newStatus }));
    }

    if (apiCalls.length === 0) return;

    try {
      await Promise.all(apiCalls);
      patch('passes', updates);
      clearSelection();
    } catch (error) {
      console.error('Bulk status update failed:', error);
    }
  }

  [startDateManual, startHourSelect, startMinuteSelect, endDateManual, endHourSelect, endMinuteSelect].forEach((control) => {
    control.addEventListener('change', onManualTimeChange);
  });

  subscribe('passes', () => {
    renderTable();
  });

  subscribe('conflicts', () => {
    renderTable();
  });

  subscribe('stations', () => {
    renderMappingTree();
    reassignPassAntennasAndConflicts();
  });

  subscribe('antennas', () => {
    renderMappingTree();
    reassignPassAntennasAndConflicts();
  });

  subscribe('antennaMappings', () => {
    renderMappingTree();
    reassignPassAntennasAndConflicts();
  });

  subscribe('satellites', () => {
    satellites = buildSatelliteListFromStore();
    const satelliteIdSet = new Set(satellites.map((sat) => sat.id));
    selectedSatIds = new Set([...selectedSatIds].filter((id) => satelliteIdSet.has(id)));
    renderSatelliteSelector();
    renderMappingTree();
  });

  subscribe('groups', () => {
    // Re-build the satellite list because the schedulable flag may have flipped
    // and previously-included satellites may now need to be excluded (or vice versa).
    satellites = buildSatelliteListFromStore();
    const satelliteIdSet = new Set(satellites.map((sat) => sat.id));
    selectedSatIds = new Set([...selectedSatIds].filter((id) => satelliteIdSet.has(id)));
    renderSatelliteSelector();
    renderMappingTree();
  });

  applySortHeaders();

  // ─── Multi-checkbox filter dropdown helpers ───
  function setupMcf(containerEl, stateKey) {
    if (!containerEl) return;
    const btn = containerEl.querySelector('.sm-mcf-btn');
    const popup = containerEl.querySelector('.sm-mcf-popup');
    if (!btn || !popup) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close other open popups
      document.querySelectorAll('.sm-mcf-popup.open').forEach(p => { if (p !== popup) p.classList.remove('open'); });
      popup.classList.toggle('open');
    });

    popup.addEventListener('change', (e) => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement)) return;
      if (cb.checked) mcfState[stateKey].add(cb.value);
      else mcfState[stateKey].delete(cb.value);
      updateMcfBtnLabel(btn, mcfState[stateKey]);
      renderTable();
    });
  }

  function updateMcfBtnLabel(btn, selectedSet) {
    if (selectedSet.size === 0) btn.textContent = 'All';
    else if (selectedSet.size === 1) btn.textContent = [...selectedSet][0].length > 15 ? [...selectedSet][0].slice(0, 13) + '...' : [...selectedSet][0];
    else btn.textContent = `${selectedSet.size} selected`;
  }

  function populateMcf(containerEl, stateKey, items) {
    if (!containerEl) return;
    const popup = containerEl.querySelector('.sm-mcf-popup');
    const btn = containerEl.querySelector('.sm-mcf-btn');
    if (!popup || !btn) return;

    // Remove stale selections
    for (const v of mcfState[stateKey]) {
      if (!items.some(it => it.value === v)) mcfState[stateKey].delete(v);
    }

    popup.innerHTML = items.map(it =>
      `<label class="sm-mcf-item">
        <input type="checkbox" value="${it.value}" ${mcfState[stateKey].has(it.value) ? 'checked' : ''}>
        <span>${escapeHtml(it.label)}</span>
      </label>`
    ).join('') || '<div class="sm-mcf-empty">No options</div>';

    updateMcfBtnLabel(btn, mcfState[stateKey]);
  }

  setupMcf(mcfSat, 'sat');
  setupMcf(mcfStation, 'station');
  setupMcf(mcfAntenna, 'antenna');
  setupMcf(mcfStatus, 'status');
  setupMcf(mcfConflict, 'conflict');

  // Close popups on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.sm-mcf-popup.open').forEach(p => p.classList.remove('open'));
  });

  // MinEl filter
  if (colFilterMinEl) colFilterMinEl.addEventListener('input', () => renderTable());

  // Pre-populate status + conflict (static options)
  populateMcf(mcfStatus, 'status', [
    { value: 'predicted', label: 'predicted' },
    { value: 'selected', label: 'selected' },
    { value: 'confirmed', label: 'confirmed' },
    { value: 'rejected', label: 'rejected' },
  ]);
  populateMcf(mcfConflict, 'conflict', [
    { value: 'yes', label: 'Conflict' },
    { value: 'no', label: 'Clear' },
  ]);

  function applySortHeaders() {
    table.querySelectorAll('th[data-sort]').forEach((th) => {
      th.classList.remove('is-sort-asc', 'is-sort-desc');
      const key = th.getAttribute('data-sort');
      if (key !== sort.key) return;
      th.classList.add(sort.dir === 'asc' ? 'is-sort-asc' : 'is-sort-desc');
    });
  }

  function onManualTimeChange() {
    syncHiddenTimeInputs();
    refreshTimeWindowUi();
    syncStoreUiState();
    clearPresetSelection();
  }

  function shiftWindowByDays(days) {
    const start = parseInputDateTime(startInput.value);
    const end = parseInputDateTime(endInput.value);
    if (!start || !end) return;

    start.setUTCDate(start.getUTCDate() + days);
    end.setUTCDate(end.getUTCDate() + days);

    setManualTimeFields(start, startDateManual, startHourSelect, startMinuteSelect);
    setManualTimeFields(end, endDateManual, endHourSelect, endMinuteSelect);
    syncHiddenTimeInputs();
    refreshTimeWindowUi();
    syncStoreUiState();
    clearPresetSelection();
  }

  function shiftBoundaryByDays(boundary, days) {
    const targetInput = boundary === 'start' ? startInput : endInput;
    const targetDate = parseInputDateTime(targetInput.value);
    if (!targetDate) return;

    targetDate.setUTCDate(targetDate.getUTCDate() + days);

    if (boundary === 'start') {
      setManualTimeFields(targetDate, startDateManual, startHourSelect, startMinuteSelect);
    } else {
      setManualTimeFields(targetDate, endDateManual, endHourSelect, endMinuteSelect);
    }

    syncHiddenTimeInputs();
    refreshTimeWindowUi();
    syncStoreUiState();
    clearPresetSelection();
  }

  function applyTimePreset(preset) {
    const start = new Date();
    const end = new Date(start.getTime());

    if (preset === 'today') {
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(23, 59, 0, 0);
    } else if (preset === 'tomorrow') {
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() + 1);
      end.setTime(start.getTime());
      end.setUTCHours(23, 59, 0, 0);
    } else if (preset === '72h') {
      end.setUTCHours(end.getUTCHours() + 72);
    } else {
      end.setUTCHours(end.getUTCHours() + 24);
    }

    setManualTimeFields(start, startDateManual, startHourSelect, startMinuteSelect);
    setManualTimeFields(end, endDateManual, endHourSelect, endMinuteSelect);
    syncHiddenTimeInputs();
    refreshTimeWindowUi();
    syncStoreUiState();

    section.querySelectorAll('.sm-time-preset').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-sm-preset') === preset);
    });
  }

  function clearPresetSelection() {
    section.querySelectorAll('.sm-time-preset.active').forEach((btn) => {
      btn.classList.remove('active');
    });
  }

  function syncHiddenTimeInputs() {
    startInput.value = composeManualDateTime(startDateManual.value, startHourSelect.value, startMinuteSelect.value);
    endInput.value = composeManualDateTime(endDateManual.value, endHourSelect.value, endMinuteSelect.value);
  }

  function refreshTimeWindowUi() {
    const start = parseInputDateTime(startInput.value);
    const end = parseInputDateTime(endInput.value);
    if (!start || !end) {
      windowDuration.textContent = 'Window: —';
      windowHint.textContent = 'All inputs are UTC. Choose start/end day, hour, and minute.';
      windowHint.classList.remove('is-error');
      computeBtn.disabled = true;
      return;
    }

    const diffMs = end.getTime() - start.getTime();
    if (diffMs <= 0) {
      windowDuration.textContent = 'Window: invalid';
      windowHint.textContent = 'End time must be after start time.';
      windowHint.classList.add('is-error');
      computeBtn.disabled = true;
      return;
    }

    windowDuration.textContent = `Window: ${formatWindowDuration(diffMs)}`;
    windowHint.textContent = 'All inputs are UTC. Use presets, then fine-tune day / hour / minute.';
    windowHint.classList.remove('is-error');
    computeBtn.disabled = false;
    updateResultsWindowLabel();
  }

  function syncStoreUiState() {
    const start = parseInputDateTime(startInput.value);
    const end = parseInputDateTime(endInput.value);

    patch('ui', {
      timeWindow: { start, end },
      selectedSatellites: Array.from(selectedSatIds),
    });
  }

  async function saveDefaultSelection() {
    try {
      await putSetting(SCHEDULE_SELECTION_KEY, {
        satelliteIds: Array.from(selectedSatIds),
      });
      if (saveDefaultBtn) {
        const original = saveDefaultBtn.textContent || 'Save Default';
        saveDefaultBtn.textContent = 'Saved!';
        window.setTimeout(() => {
          saveDefaultBtn.textContent = original;
        }, 1500);
      }
    } catch (error) {
      console.warn('Failed to save schedule defaults:', error);
      if (saveDefaultBtn) {
        const original = saveDefaultBtn.textContent || 'Save Default';
        saveDefaultBtn.textContent = 'Save Failed';
        window.setTimeout(() => {
          saveDefaultBtn.textContent = original;
        }, 1700);
      }
    }
  }

  async function loadDefaultSelection() {
    try {
      const data = await getSetting(SCHEDULE_SELECTION_KEY);
      const ids = Array.isArray(data?.satelliteIds) ? data.satelliteIds : null;
      if (!ids || ids.length === 0) return null;
      const validIds = ids.filter((id) => satellites.some((sat) => sat.id === id));
      return validIds.length > 0 ? validIds : null;
    } catch (error) {
      console.warn('Failed to load schedule defaults:', error);
      return null;
    }
  }

  async function initializeDefaultSelection() {
    const savedIds = await loadDefaultSelection();
    if (!savedIds) return;
    selectedSatIds = new Set(savedIds);
    renderSatelliteSelector();
    syncStoreUiState();
  }

  function renderSatelliteSelector() {
    const selectedCount = satellites.reduce((count, sat) => count + (selectedSatIds.has(sat.id) ? 1 : 0), 0);
    const controls = `
      <div class="sm-check-actions">
        <button type="button" class="sm-check-action-btn" data-sm-sat-action="all" ${satellites.length === 0 || selectedCount === satellites.length ? 'disabled' : ''}>Select All</button>
        <button type="button" class="sm-check-action-btn" data-sm-sat-action="none" ${selectedCount === 0 ? 'disabled' : ''}>Clear</button>
        <span class="sm-check-meta">${selectedCount}/${satellites.length} selected</span>
      </div>
    `;

    const items = satellites.map((sat) => {
      const checked = selectedSatIds.has(sat.id) ? 'checked' : '';
      return `
        <label class="sm-check-item">
          <input type="checkbox" name="sm-sat-select" value="${sat.id}" ${checked}>
          <span class="sm-sat-dot" style="--sat-color: ${sat.color}"></span>
          <span class="sm-check-label">${escapeHtml(sat.name)}</span>
        </label>
      `;
    }).join('');

    satSelector.innerHTML = controls + items;
  }

  // Topology refresh is now handled by Configuration tab

  async function computeSchedule() {
    setComputeBusy(true);
    try {
    const stations = Object.values(getState().stations || {});
    const antennas = getState().antennas || {};
    const mappings = getState().antennaMappings || [];
    if (stations.length === 0) {
      empty.textContent = 'No ground stations loaded from API.';
      passBody.innerHTML = '';
      empty.style.display = '';
      replaceObjectSlice('passes', {});
      patch('conflicts', []);
      return;
    }

    const start = parseInputDateTime(startInput.value) || new Date();
    const end = parseInputDateTime(endInput.value) || new Date(start.getTime() + 24 * 3600 * 1000);

    if (end.getTime() <= start.getTime()) {
      empty.textContent = 'End time must be after start time.';
      passBody.innerHTML = '';
      empty.style.display = '';
      replaceObjectSlice('passes', {});
      patch('conflicts', []);
      return;
    }

    const selectedSats = satellites.filter((sat) => selectedSatIds.has(sat.id));
    const cacheKey = buildComputeCacheKey({
      satellites: selectedSats,
      stations,
      antennas,
      mappings,
      start,
      end,
    });

    if (cacheKey === lastComputeCacheKey && Object.keys(getState().passes || {}).length > 0) {
      empty.textContent = 'No passes match the current filters/time window.';
      renderTable();
      return;
    }

    const existingPasses = getState().passes || {};
    /** @type {Record<string, object>} */
    const nextPasses = {};
    /** @type {Array<object>} */
    const passList = [];
    const subPassCountByParent = new Map();

    for (const sat of selectedSats) {

      try {
        const { satrec } = parseTLE(sat.tle);
        const maskAwareStations = stations.map((station) => {
          const assignedAntennaId = selectAssignedAntennaId({
            stationId: station.id,
            satelliteId: sat.id,
            antennas,
            mappings,
          });

          const assignedAntenna = assignedAntennaId ? antennas[assignedAntennaId] : null;
          return {
            ...station,
            antennas: assignedAntenna
              ? [{
                id: assignedAntenna.id,
                name: assignedAntenna.name || assignedAntenna.id,
                type: assignedAntenna.type || '',
                mask: Array.isArray(assignedAntenna.mask) ? assignedAntenna.mask : [],
              }]
              : [],
          };
        });

        const satPasses = computePasses(satrec, maskAwareStations, start, end);

        for (const p of satPasses) {
          const parentId = p.parentPassId ? `${sat.id}_${p.parentPassId}` : null;
          let id;

          if (parentId) {
            const nextSubIdx = (subPassCountByParent.get(parentId) || 0) + 1;
            subPassCountByParent.set(parentId, nextSubIdx);
            id = `${parentId}_sub${nextSubIdx}`;
          } else {
            id = buildPassId(sat.id, p.stationId, p.aos, p.antennaId || null);
          }

          const prev = existingPasses[id];
          const pass = {
            id,
            satelliteId: sat.id,
            satelliteName: sat.name,
            satelliteColor: sat.color,
            stationId: p.stationId,
            stationName: p.stationName,
            antennaId: p.antennaId || selectAssignedAntennaId({
              stationId: p.stationId,
              satelliteId: sat.id,
              antennas,
              mappings,
            }),
            parentPassId: parentId,
            aos: p.aos,
            los: p.los,
            durationSec: p.durationSec,
            maxElDeg: p.maxElDeg,
            status: normalizeStatus(prev?.status),
            notes: prev?.notes ?? '',
          };
          nextPasses[id] = pass;
          passList.push(pass);
        }
      } catch (error) {
        console.error(`Failed to compute passes for ${sat.name}:`, error);
      }
    }

    const conflicts = detectConflicts(passList);
    replaceObjectSlice('passes', nextPasses);
    patch('conflicts', conflicts);
    lastComputeCacheKey = cacheKey;
    empty.textContent = 'No passes match the current filters/time window.';

    try {
      await bulkUpsertPasses(passList.map((pass) => ({
        id: pass.id,
        satelliteId: pass.satelliteId,
        stationId: pass.stationId,
        antennaId: pass.antennaId,
        aos: pass.aos,
        los: pass.los,
        durationSec: pass.durationSec,
        maxElDeg: pass.maxElDeg,
        status: pass.status,
        notes: pass.notes ?? '',
      })));
    } catch (error) {
      console.error('Failed to persist computed passes:', error);
    }
    } finally {
      setComputeBusy(false);
    }
  }

  if (recomputeBtn) {
    recomputeBtn.addEventListener('click', () => {
      computeSchedule();
    });
  }

  if (resultsPrevDayBtn) {
    resultsPrevDayBtn.addEventListener('click', () => {
      shiftWindowByDays(-1);
    });
  }

  if (resultsNextDayBtn) {
    resultsNextDayBtn.addEventListener('click', () => {
      shiftWindowByDays(1);
    });
  }

  function updateResultsWindowLabel() {
    if (!resultsWindowLabel) return;
    const start = parseInputDateTime(startInput.value);
    const end = parseInputDateTime(endInput.value);
    if (!start || !end) {
      resultsWindowLabel.textContent = '—';
      return;
    }
    const fmtDate = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    const fmtTime = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    resultsWindowLabel.textContent = `${fmtDate(start)} ${fmtTime(start)} – ${fmtDate(end)} ${fmtTime(end)} UTC`;
  }

  function setComputeBusy(isBusy) {
    computeBtn.disabled = isBusy;
    computeBtn.classList.toggle('is-loading', isBusy);
    computeBtn.textContent = isBusy ? '⏳ Computing…' : '▶ Compute Passes';
    if (recomputeBtn) {
      recomputeBtn.disabled = isBusy;
      recomputeBtn.classList.toggle('is-loading', isBusy);
    }
  }

  function exportPassesCsv() {
    const passes = Object.values(getState().passes || {}).map(hydratePassDates);
    if (passes.length === 0) {
      empty.textContent = 'No computed passes to export yet.';
      empty.style.display = '';
      return;
    }

    const antennas = getState().antennas || {};
    const conflicts = getState().conflicts || [];
    const conflictByPassId = new Map();
    for (const conflict of conflicts) {
      for (const passId of conflict.passIds || []) {
        if (!conflictByPassId.has(passId)) conflictByPassId.set(passId, []);
        conflictByPassId.get(passId).push(conflict);
      }
    }

    const rows = [
      ['Satellite', 'Station', 'Antenna', 'AOS (UTC)', 'LOS (UTC)', 'Duration (min)', 'Max EL (°)', 'Status', 'Conflict'],
      ...passes.map((pass) => {
        const conflictInfo = buildConflictInfo(pass, conflictByPassId.get(pass.id) || [], passes);
        return [
          pass.satelliteName,
          pass.stationName,
          getAntennaDisplayName(pass, antennas),
          formatUtc(ensureDate(pass.aos)),
          formatUtc(ensureDate(pass.los)),
          (Number(pass.durationSec || 0) / 60).toFixed(2),
          Number(pass.maxElDeg || 0).toFixed(1),
          pass.status || 'predicted',
          conflictInfo || 'none',
        ];
      }),
    ];

    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `schedule_${formatDateForFilename(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // renderFilters removed — column header filters handle all filtering

  function renderMappingTree() {
    const stations = getState().stations || {};
    const antennas = getState().antennas || {};
    const mappings = getState().antennaMappings || [];
    const storeSats = getState().satellites || {};

    const stationsSorted = Object.values(stations).sort((a, b) => a.name.localeCompare(b.name));

    if (stationsSorted.length === 0) {
      mappingTree.innerHTML = '<div class="sm-mapping-empty">No stations loaded</div>';
      return;
    }

    const html = stationsSorted.map((station) => {
      const stationAntennas = Object.values(antennas)
        .filter((ant) => ant.stationId === station.id)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

      const antennaItems = stationAntennas.map((antenna) => {
        const antennaMappings = mappings.filter((m) => m?.antennaId === antenna.id && m?.satelliteId);

        return `
          <details class="mapping-antenna">
            <summary>
              <span>${escapeHtml(antenna.name || antenna.id)}</span>
              <span class="mapping-mask-indicator ${Array.isArray(antenna.mask) && antenna.mask.length > 0 ? 'has-mask' : ''}">
                ${Array.isArray(antenna.mask) && antenna.mask.length > 0 ? `Mask: ${antenna.mask.length} points` : 'No mask'}
              </span>
              <span class="mapping-count">[${antennaMappings.length} satellites]</span>
            </summary>
            <div class="mapping-antenna-body">
              ${antennaMappings
                .map((mapping) => {
                  const sat = storeSats[mapping.satelliteId] || satellites.find((s) => s.id === mapping.satelliteId);
                  if (!sat) return '';
                  return `<div class="mapping-sat-item"><span>• ${escapeHtml(sat.name)}</span></div>`;
                })
                .join('') || '<div class="mapping-sat-item mapping-sat-empty">No satellite mappings</div>'}
            </div>
          </details>
        `;
      }).join('');

      return `
        <details class="mapping-station">
          <summary>
            <span>${escapeHtml(station.name)}</span>
            <span class="mapping-count">[${stationAntennas.length} antennas]</span>
          </summary>
          <div class="mapping-station-body">
            ${antennaItems || '<div class="mapping-sat-item mapping-sat-empty">No antennas configured</div>'}
          </div>
        </details>
      `;
    }).join('');

    mappingTree.innerHTML = html + '<div class="sm-mapping-config-link"><button class="gs-config-link" onclick="document.querySelector(\'[data-tab=configuration]\')?.click()">Manage in Configuration →</button></div>';
  }

  function reassignPassAntennasAndConflicts() {
    const currentPasses = getState().passes || {};
    const passIds = Object.keys(currentPasses);
    if (passIds.length === 0) {
      patch('conflicts', []);
      return;
    }

    const antennas = getState().antennas || {};
    const mappings = getState().antennaMappings || [];
    const nextPasses = {};

    for (const pass of Object.values(currentPasses)) {
      nextPasses[pass.id] = {
        ...pass,
        antennaId: selectAssignedAntennaId({
          stationId: pass.stationId,
          satelliteId: pass.satelliteId,
          antennas,
          mappings,
        }),
      };
    }

    replaceObjectSlice('passes', nextPasses);
    patch('conflicts', detectConflicts(Object.values(nextPasses)));
  }

  function renderTable() {
    const passes = Object.values(getState().passes || {}).map(hydratePassDates);
    const conflicts = getState().conflicts || [];
    const antennas = getState().antennas || {};

    // Populate multi-checkbox filter dropdowns from current pass data
    const satIdsAll = [...new Set(passes.map(p => p.satelliteId))];
    const stationIdsAll = [...new Set(passes.map(p => p.stationId))];
    const antennaIdsAll = [...new Set(passes.filter(p => p.antennaId).map(p => p.antennaId))];

    populateMcf(mcfSat, 'sat', satIdsAll.map(id => {
      const sat = satellites.find(s => s.id === id);
      return { value: id, label: sat ? sat.name : id };
    }));
    populateMcf(mcfStation, 'station', stationIdsAll.map(id => {
      const st = getState().stations?.[id];
      return { value: id, label: st ? st.name : id };
    }));
    populateMcf(mcfAntenna, 'antenna', antennaIdsAll.map(id => {
      const ant = antennas[id];
      return { value: id, label: ant ? (ant.name || id) : id };
    }));

    /** @type {Map<string, Array<object>>} */
    const conflictMap = new Map();
    for (const conflict of conflicts) {
      for (const passId of conflict.passIds) {
        if (!conflictMap.has(passId)) conflictMap.set(passId, []);
        conflictMap.get(passId).push(conflict);
      }
    }

    // Apply sidebar filters + multi-checkbox column filters
    const fSat = mcfState.sat;
    const fStation = mcfState.station;
    const fAntenna = mcfState.antenna;
    const fMinEl = colFilterMinEl?.value ? parseFloat(colFilterMinEl.value) : NaN;
    const fStatus = mcfState.status;
    const fConflict = mcfState.conflict;

    const filtered = passes
      .filter((p) => fSat.size === 0 || fSat.has(p.satelliteId))
      .filter((p) => fStation.size === 0 || fStation.has(p.stationId))
      .filter((p) => fAntenna.size === 0 || fAntenna.has(p.antennaId))
      .filter((p) => isNaN(fMinEl) || Number(p.maxElDeg) >= fMinEl)
      .filter((p) => fStatus.size === 0 || fStatus.has(p.status))
      .filter((p) => {
        if (fConflict.size === 0) return true;
        const hasConflict = (conflictMap.get(p.id) || []).length > 0;
        const wantsConflict = fConflict.has('yes');
        const wantsClear = fConflict.has('no');
        if (wantsConflict && wantsClear) return true;
        return wantsConflict ? hasConflict : !hasConflict;
      });

    const sorted = filtered.sort((a, b) => {
      const left = {
        ...a,
        conflictCount: (conflictMap.get(a.id) || []).length,
        antennaSortName: getAntennaDisplayName(a, antennas),
      };
      const right = {
        ...b,
        conflictCount: (conflictMap.get(b.id) || []).length,
        antennaSortName: getAntennaDisplayName(b, antennas),
      };
      return comparePasses(left, right, sort);
    });

    passCount.textContent = `${sorted.length}`;
    conflictCount.textContent = `${countUniqueConflictPairs(conflicts)}`;

    // Track rendered order for Shift+click range selection
    renderedPassIds = sorted.map((p) => p.id);

    // Prune selection: remove IDs no longer visible
    for (const id of [...selectedPassIds]) {
      if (!renderedPassIds.includes(id)) selectedPassIds.delete(id);
    }

    if (sorted.length === 0) {
      passBody.innerHTML = '';
      empty.style.display = '';
      updateBulkBar();
      return;
    }

    empty.style.display = 'none';

    passBody.innerHTML = sorted.map((pass) => {
      const conflictList = conflictMap.get(pass.id) || [];
      const conflictInfo = buildConflictInfo(pass, conflictList, passes);
      const sel = selectedPassIds.has(pass.id) ? ' is-selected' : '';
      return `
        <tr data-pass-id="${pass.id}" class="${conflictList.length > 0 ? 'sm-row-conflict' : ''}${sel}">
          <td>
            <span class="sm-sat-pill">
              <span class="sm-sat-dot" style="--sat-color: ${pass.satelliteColor}"></span>
              ${escapeHtml(pass.satelliteName)}
            </span>
          </td>
          <td>${escapeHtml(pass.stationName)}</td>
          <td class="${pass.antennaId ? '' : 'sm-antenna-unassigned'}">${escapeHtml(getAntennaDisplayName(pass, antennas))}</td>
          <td class="sm-mono">${formatUtc(ensureDate(pass.aos))}</td>
          <td class="sm-mono">${formatUtc(ensureDate(pass.los))}</td>
          <td class="sm-mono">${formatDuration(pass.durationSec)}</td>
          <td class="sm-mono">${Number(pass.maxElDeg).toFixed(1)}°</td>
          <td>
            <button type="button" class="sm-status-btn sm-status-${pass.status}" title="Click to cycle status">
              ${pass.status}
            </button>
            <button type="button" class="sm-reject-btn" title="Reject pass">Reject</button>
          </td>
          <td>
            ${conflictList.length > 0 ? `<span class="sm-conflict-dot" title="${escapeHtml(conflictInfo)}">⚠</span>` : '<span class="sm-conflict-clear">—</span>'}
          </td>
        </tr>
      `;
    }).join('');

    updateBulkBar();
  }

  async function cycleStatus(passId) {
    const pass = getState().passes?.[passId];
    if (!pass) return;

    const currentIndex = STATUS_FLOW.indexOf(pass.status);
    const nextStatus = STATUS_FLOW[(currentIndex + 1) % STATUS_FLOW.length] || 'predicted';

    try {
      await updatePass(passId, { status: nextStatus });
      patch('passes', {
        [passId]: {
          ...pass,
          status: /** @type {PassStatus} */ (nextStatus),
        },
      });
    } catch (error) {
      console.error('Failed to persist pass status:', error);
    }
  }

  async function setRejected(passId) {
    const pass = getState().passes?.[passId];
    if (!pass) return;

    const nextStatus = pass.status === 'rejected' ? 'predicted' : 'rejected';
    try {
      await updatePass(passId, { status: nextStatus });
      patch('passes', {
        [passId]: {
          ...pass,
          status: /** @type {PassStatus} */ (nextStatus),
        },
      });
    } catch (error) {
      console.error('Failed to persist pass status:', error);
    }
  }

  function replaceObjectSlice(sliceName, nextValue) {
    patch(sliceName, (current) => {
      for (const key of Object.keys(current)) {
        delete current[key];
      }
      return nextValue;
    });
  }
}

function buildSatelliteListFromStore() {
  const storeSats = getState().satellites || {};
  return Object.values(storeSats)
    .filter((sat) => isGroupSchedulable(sat?.groupName) && sat?.enabled !== false)
    .map((sat) => ({
      id: sat.id,
      name: sat.name,
      tle: sat.tle || [sat.tleLine0, sat.tleLine1, sat.tleLine2].filter(Boolean).join('\n'),
      color: sat.color || '#7dd3fc',
    }));
}

function toStationRecord(stations, antennas = [], maskByAntennaId = {}) {
  const antennaByStation = {};
  for (const antenna of antennas || []) {
    if (!antenna?.id || !antenna?.stationId) continue;
    if (!antennaByStation[antenna.stationId]) antennaByStation[antenna.stationId] = [];
    antennaByStation[antenna.stationId].push({
      id: antenna.id,
      name: antenna.name || antenna.id,
      type: antenna.type || '',
      mask: Array.isArray(maskByAntennaId[antenna.id]) ? maskByAntennaId[antenna.id] : [],
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
      antennas: antennaByStation[station.id] || [],
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
        mask: Array.isArray(antenna.mask) ? antenna.mask : [],
      };
    }
  }
  return antennas;
}

// fetchMaskMapForAntennas removed — masks loaded via Configuration tab / main bootstrap

function countUniqueConflictPairs(conflicts) {
  const keys = new Set(conflicts.map((c) => `${c.passIds[0]}::${c.passIds[1]}`));
  return keys.size;
}

function buildPassId(satelliteId, stationId, aos, antennaId = null) {
  const base = `${satelliteId}_${stationId}_${Math.floor(aos.getTime() / 1000)}`;
  return antennaId ? `${base}_${antennaId}` : base;
}

function normalizeStatus(status) {
  if (status === 'selected' || status === 'confirmed' || status === 'rejected' || status === 'cancelled') {
    return status;
  }
  return 'predicted';
}

function parseInputDateTime(value) {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toInputDateTime(date) {
  if (!(date instanceof Date)) return '';
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function composeManualDateTime(dateValue, hourValue, minuteValue) {
  if (!dateValue) return '';
  const hh = String(Number(hourValue || 0)).padStart(2, '0');
  const mm = String(Number(minuteValue || 0)).padStart(2, '0');
  return `${dateValue}T${hh}:${mm}`;
}

function setManualTimeFields(date, dateInput, hourSelect, minuteSelect) {
  if (!(date instanceof Date)) return;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  dateInput.value = `${yyyy}-${mm}-${dd}`;
  hourSelect.value = String(date.getUTCHours()).padStart(2, '0');
  minuteSelect.value = String(date.getUTCMinutes()).padStart(2, '0');
}

function populateTimeSelectOptions(select, count) {
  select.innerHTML = Array.from({ length: count }, (_, idx) => {
    const value = String(idx).padStart(2, '0');
    return `<option value="${value}">${value}</option>`;
  }).join('');
}

function formatWindowDuration(diffMs) {
  const totalMinutes = Math.max(0, Math.round(diffMs / 60000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function comparePasses(a, b, sort) {
  const factor = sort.dir === 'asc' ? 1 : -1;
  const values = {
    satellite: [a.satelliteName, b.satelliteName],
    station: [a.stationName, b.stationName],
    antenna: [a.antennaSortName || '', b.antennaSortName || ''],
    aos: [ensureDate(a.aos).getTime(), ensureDate(b.aos).getTime()],
    los: [ensureDate(a.los).getTime(), ensureDate(b.los).getTime()],
    duration: [a.durationSec, b.durationSec],
    maxEl: [a.maxElDeg, b.maxElDeg],
    status: [a.status, b.status],
    conflict: [Number(a.conflictCount || 0), Number(b.conflictCount || 0)],
  };

  if (!Object.hasOwn(values, sort.key)) {
    return (ensureDate(a.aos).getTime() - ensureDate(b.aos).getTime()) * factor;
  }

  const [left, right] = values[sort.key];
  if (typeof left === 'string' && typeof right === 'string') {
    return left.localeCompare(right) * factor;
  }
  return (left - right) * factor;
}

function buildConflictInfo(pass, conflictList, passList) {
  const passById = new Map(passList.map((p) => [p.id, p]));
  const chunks = conflictList.map((c) => {
    const otherId = c.passIds[0] === pass.id ? c.passIds[1] : c.passIds[0];
    const otherPass = passById.get(otherId);
    const satName = otherPass?.satelliteName || otherId;
    return `${satName} on antenna ${c.antennaId || 'unassigned'} (${Math.round(c.overlapSec)}s overlap)`;
  });
  return chunks.join(' | ');
}

function getAntennaDisplayName(pass, antennas) {
  if (!pass.antennaId) return '—';
  const antenna = antennas[pass.antennaId];
  if (!antenna) return pass.antennaId;
  return `${antenna.name}`;
}

function selectAssignedAntennaId({ stationId, satelliteId, antennas, mappings }) {
  const antennaById = antennas || {};
  const allMappings = Array.isArray(mappings) ? mappings : [];

  // Collect candidate mappings for this satellite at this station
  const candidateMappings = allMappings
    .filter((m) => m?.satelliteId === satelliteId && antennaById[m.antennaId]?.stationId === stationId);

  if (candidateMappings.length === 0) return null;

  // Prefer primary over backup, then sort by antenna name
  candidateMappings.sort((a, b) => {
    const roleA = (a.role || 'primary') === 'primary' ? 0 : 1;
    const roleB = (b.role || 'primary') === 'primary' ? 0 : 1;
    if (roleA !== roleB) return roleA - roleB;
    const nameA = (antennaById[a.antennaId]?.name || a.antennaId);
    const nameB = (antennaById[b.antennaId]?.name || b.antennaId);
    return nameA.localeCompare(nameB);
  });

  return candidateMappings[0]?.antennaId || null;
}

function generateAntennaId(stationId) {
  return `${stationId}_ant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

function ensureDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function hydratePassDates(pass) {
  return {
    ...pass,
    aos: ensureDate(pass.aos),
    los: ensureDate(pass.los),
  };
}

function formatUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatDuration(sec) {
  const minutes = Math.floor(sec / 60);
  const seconds = Math.round(sec % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function cssEscape(value) {
  return String(value).replaceAll('"', '\\"');
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

function formatDateForFilename(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildComputeCacheKey({ satellites, stations, antennas, mappings, start, end }) {
  const payload = {
    startMs: start.getTime(),
    endMs: end.getTime(),
    satellites: (satellites || []).map((sat) => ({ id: sat.id, tle: sat.tle || '' })),
    stations: (stations || [])
      .map((s) => ({ id: s.id, lat: Number(s.lat), lon: Number(s.lon), minElevDeg: Number(s.minElevDeg) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    antennas: Object.values(antennas || {})
      .map((a) => ({ id: a.id, stationId: a.stationId, maskCount: Array.isArray(a.mask) ? a.mask.length : 0 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    mappings: (mappings || [])
      .map((m) => ({ antennaId: m.antennaId, satelliteId: m.satelliteId }))
      .sort((a, b) => `${a.antennaId}_${a.satelliteId}`.localeCompare(`${b.antennaId}_${b.satelliteId}`)),
  };

  return hashString(JSON.stringify(payload));
}

function hashString(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return String(hash >>> 0);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
