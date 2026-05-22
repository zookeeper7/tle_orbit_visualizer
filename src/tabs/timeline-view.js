import { getState, patch, subscribe } from '../core/app-store.js';

const SAT_COLORS = [
  '#7dd3fc', '#fbbf24', '#fb7185', '#34d399', '#a78bfa',
  '#f97316', '#38bdf8', '#f472b6', '#4ade80', '#c084fc',
  '#fb923c', '#22d3ee', '#e879f9', '#a3e635', '#fca5a5',
  '#67e8f9', '#d946ef', '#bef264',
];

const STATUS_OPACITY = {
  predicted: 0.5,
  selected: 0.7,
  confirmed: 1,
  rejected: 0.3,
  cancelled: 0.3,
};

const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 34;
const ROW_INNER_PAD = 7;
const ZOOM_MIN = 40;
const ZOOM_MAX = 800;

export function initTimeline() {
  const ganttWrap = document.getElementById('smGanttView');
  const stationCol = document.getElementById('tlStationCol');
  const canvasWrap = document.getElementById('tlCanvasWrap');
  const timeHeader = document.getElementById('tlTimeHeader');
  const rowsEl = document.getElementById('tlRows');
  const zoomInBtn = document.getElementById('tlZoomIn');
  const zoomOutBtn = document.getElementById('tlZoomOut');
  const fitBtn = document.getElementById('tlFitAll');
  const selCount = document.getElementById('tlSelCount');
  const detail = document.getElementById('tlDetail');

  if (!ganttWrap || !stationCol || !canvasWrap || !timeHeader || !rowsEl || !zoomInBtn || !zoomOutBtn || !fitBtn || !selCount || !detail) {
    return;
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'tl-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  let pxPerHour = 160;
  let dirty = true;
  let statusFilter = 'all'; // 'all' | 'no-rejected' | 'confirmed' | 'selected+'
  let hasRendered = false;
  let windowRange = null;

  /** @type {Set<string>} */
  const selectedPassIds = new Set();
  let activePassId = null;
  /** @type {Map<string, object>} */
  let passById = new Map();

  subscribe('passes', markDirtyAndRenderIfVisible);
  subscribe('conflicts', markDirtyAndRenderIfVisible);
  subscribe('ui', () => {
    if (isGanttVisible() && (dirty || !hasRendered)) renderTimeline();
  });

  // Watch for gantt view becoming visible via MutationObserver
  const ganttObserver = new MutationObserver(() => {
    if (isGanttVisible() && (dirty || !hasRendered)) renderTimeline();
  });
  ganttObserver.observe(ganttWrap, { attributes: true, attributeFilter: ['style'] });

  zoomInBtn.addEventListener('click', () => zoomAtCenter(1.2));
  zoomOutBtn.addEventListener('click', () => zoomAtCenter(1 / 1.2));
  fitBtn.addEventListener('click', fitAll);

  // Status filter buttons
  ganttWrap.querySelectorAll('.tl-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      statusFilter = btn.getAttribute('data-tl-filter') || 'all';
      ganttWrap.querySelectorAll('.tl-filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
      dirty = true;
      renderTimeline();
    });
  });

  canvasWrap.addEventListener('scroll', () => {
    const stationRows = stationCol.querySelector('.tl-station-rows');
    if (stationRows) {
      stationRows.style.transform = `translateY(${-canvasWrap.scrollTop}px)`;
    }
  });

  canvasWrap.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAtPoint(factor, event.clientX);
  }, { passive: false });

  rowsEl.addEventListener('click', onBarClick);
  rowsEl.addEventListener('mouseover', onBarOver);
  rowsEl.addEventListener('mousemove', onBarMove);
  rowsEl.addEventListener('mouseout', onBarOut);

  window.addEventListener('resize', () => {
    if (isGanttVisible()) renderTimeline();
  });

  function isGanttVisible() {
    return getState().ui?.activeTab === 'schedule-manager' && ganttWrap.style.display !== 'none';
  }

  function markDirtyAndRenderIfVisible() {
    dirty = true;
    if (isGanttVisible()) renderTimeline();
  }

  function renderTimeline() {
    const state = getState();
    let passList = Object.values(state.passes || {}).map((pass) => ({
      ...pass,
      aos: toDate(pass.aos),
      los: toDate(pass.los),
    })).filter((pass) => pass.aos && pass.los && pass.los.getTime() > pass.aos.getTime());

    // Apply status filter
    if (statusFilter === 'no-rejected') {
      passList = passList.filter((p) => p.status !== 'rejected' && p.status !== 'cancelled');
    } else if (statusFilter === 'confirmed') {
      passList = passList.filter((p) => p.status === 'confirmed');
    } else if (statusFilter === 'selected+') {
      passList = passList.filter((p) => p.status === 'selected' || p.status === 'confirmed');
    }

    passById = new Map(passList.map((pass) => [pass.id, pass]));
    passList.sort((a, b) => a.aos.getTime() - b.aos.getTime());

    if (passList.length === 0) {
      windowRange = null;
      stationCol.innerHTML = '<div class="tl-station-empty">No stations</div>';
      timeHeader.innerHTML = '<div class="tl-time-empty">No passes computed yet</div>';
      rowsEl.innerHTML = '<div class="tl-empty">Compute passes in Schedule Manager to populate timeline.</div>';
      detail.style.display = 'none';
      updateSelectionUi();
      dirty = false;
      hasRendered = true;
      return;
    }

    const minMs = Math.min(...passList.map((p) => p.aos.getTime())) - (30 * MINUTE_MS);
    const maxMs = Math.max(...passList.map((p) => p.los.getTime())) + (30 * MINUTE_MS);
    windowRange = { startMs: minMs, endMs: maxMs, rangeMs: Math.max(HOUR_MS, maxMs - minMs) };

    const contentWidth = Math.max(800, Math.round((windowRange.rangeMs / HOUR_MS) * pxPerHour));

    const stations = state.stations || {};
    const antennas = state.antennas || {};
    const stationNameById = Object.values(stations).reduce((acc, station) => {
      if (station?.id) acc[station.id] = station.name || station.id;
      return acc;
    }, {});
    const antennaNameById = Object.values(antennas).reduce((acc, ant) => {
      if (ant?.id) acc[ant.id] = ant.name || ant.id;
      return acc;
    }, {});

    // Build row keys: "stationId::antennaId" per pass
    // Falls back to "stationId::" for passes without antenna assignment
    /** @type {Map<string, Array<object>>} */
    const passesByRow = new Map();
    /** @type {Map<string, {stationId:string, antennaId:string|null, label:string}>} */
    const rowMeta = new Map();

    for (const pass of passList) {
      const antennaId = pass.antennaId || null;
      const rowKey = `${pass.stationId}::${antennaId || ''}`;
      if (!passesByRow.has(rowKey)) {
        passesByRow.set(rowKey, []);
        const stationName = stationNameById[pass.stationId] || pass.stationId;
        const antennaName = antennaId ? (antennaNameById[antennaId] || antennaId) : null;
        rowMeta.set(rowKey, {
          stationId: pass.stationId,
          antennaId,
          label: antennaName ? `${stationName} › ${antennaName}` : stationName,
        });
      }
      passesByRow.get(rowKey).push(pass);
    }

    const rowKeys = Array.from(passesByRow.keys()).sort((a, b) => {
      const ma = rowMeta.get(a);
      const mb = rowMeta.get(b);
      const cmp = (stationNameById[ma.stationId] || '').localeCompare(stationNameById[mb.stationId] || '');
      if (cmp !== 0) return cmp;
      return (ma.label).localeCompare(mb.label);
    });

    const satelliteOrder = Object.keys(state.satellites || {});
    const satNameById = Object.values(state.satellites || {}).reduce((acc, sat) => {
      if (sat?.id) acc[sat.id] = sat.name || sat.id;
      return acc;
    }, {});

    const conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
    const conflictPassIds = new Set(conflicts.flatMap((c) => c.passIds || []));
    const conflictRangesByStation = buildConflictRanges(conflicts, passById);

    stationCol.innerHTML = `
      <div class="tl-station-rows">
        <div class="tl-station-head" style="height:${HEADER_HEIGHT}px"></div>
        ${rowKeys.map((rowKey) => {
          const meta = rowMeta.get(rowKey);
          return `<div class="tl-station-row" style="height:${ROW_HEIGHT}px">${escapeHtml(meta.label)}</div>`;
        }).join('')}
      </div>
    `;

    timeHeader.style.width = `${contentWidth}px`;
    rowsEl.style.width = `${contentWidth}px`;
    renderTicks(timeHeader, windowRange.startMs, windowRange.endMs, pxPerHour, contentWidth);

    rowsEl.innerHTML = rowKeys.map((rowKey) => {
      const meta = rowMeta.get(rowKey);
      const stationPasses = passesByRow.get(rowKey) || [];
      const overlays = conflictRangesByStation.get(meta.stationId) || [];
      const bars = stationPasses.map((pass) => {
        const satIdx = Math.max(0, satelliteOrder.indexOf(pass.satelliteId));
        const color = pass.satelliteColor || SAT_COLORS[satIdx % SAT_COLORS.length];
        const left = msToPx(pass.aos.getTime(), windowRange, contentWidth);
        const width = Math.max(3, msDeltaToPx(pass.los.getTime() - pass.aos.getTime(), windowRange, contentWidth));
        const opacity = STATUS_OPACITY[pass.status] ?? 0.6;
        const satName = satNameById[pass.satelliteId] || pass.satelliteName || pass.satelliteId;
        const text = width > 60 ? escapeHtml(satName) : '';
        const classes = [
          'tl-bar',
          selectedPassIds.has(pass.id) ? 'selected' : '',
          conflictPassIds.has(pass.id) ? 'conflict' : '',
        ].filter(Boolean).join(' ');

        return `
          <div
            class="${classes}"
            data-pass-id="${pass.id}"
            style="left:${left}px;width:${width}px;top:${ROW_INNER_PAD}px;height:${ROW_HEIGHT - (ROW_INNER_PAD * 2)}px;--tl-bar:${color};opacity:${opacity};"
          >${text}</div>
        `;
      }).join('');

      const conflictZones = overlays.map(({ startMs, endMs }) => {
        const left = msToPx(startMs, windowRange, contentWidth);
        const width = Math.max(2, msDeltaToPx(endMs - startMs, windowRange, contentWidth));
        return `<div class="tl-conflict-zone" style="left:${left}px;width:${width}px;top:${ROW_INNER_PAD}px;height:${ROW_HEIGHT - (ROW_INNER_PAD * 2)}px;"></div>`;
      }).join('');

      return `
        <div class="tl-row" data-station-id="${meta.stationId}" data-antenna-id="${meta.antennaId || ''}" style="height:${ROW_HEIGHT}px">
          ${conflictZones}
          ${bars}
        </div>
      `;
    }).join('');

    if (activePassId && !passById.has(activePassId)) {
      selectedPassIds.delete(activePassId);
      activePassId = null;
    }

    syncDetailPanel();
    updateSelectionUi();
    dirty = false;
    hasRendered = true;
  }

  function onBarClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const bar = target.closest('.tl-bar');
    if (!bar) return;
    const passId = bar.getAttribute('data-pass-id');
    if (!passId || !passById.has(passId)) return;

    if (event.shiftKey) {
      if (selectedPassIds.has(passId)) selectedPassIds.delete(passId);
      else selectedPassIds.add(passId);
    } else {
      selectedPassIds.clear();
      selectedPassIds.add(passId);
    }

    activePassId = passId;
    patch('ui', { selectedPasses: Array.from(selectedPassIds) });
    syncBarSelectionClass();
    syncDetailPanel();
    updateSelectionUi();
  }

  function onBarOver(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const bar = target.closest('.tl-bar');
    if (!bar) return;
    const passId = bar.getAttribute('data-pass-id');
    if (!passId) return;
    const pass = passById.get(passId);
    if (!pass) return;

    const satName = getState().satellites?.[pass.satelliteId]?.name || pass.satelliteName || pass.satelliteId;
    const stationName = getState().stations?.[pass.stationId]?.name || pass.stationName || pass.stationId;
    const antennaName = pass.antennaId
      ? (getState().antennas?.[pass.antennaId]?.name || pass.antennaId)
      : 'unassigned';

    tooltip.innerHTML =
      `<div class="tl-tip-title">${escapeHtml(satName)}</div>` +
      `<div class="tl-tip-row"><span class="tl-tip-label">Station</span><span class="tl-tip-val">${escapeHtml(stationName)}</span></div>` +
      `<div class="tl-tip-row"><span class="tl-tip-label">Antenna</span><span class="tl-tip-val">${escapeHtml(antennaName)}</span></div>` +
      `<div class="tl-tip-sep"></div>` +
      `<div class="tl-tip-row"><span class="tl-tip-label">AOS</span><span class="tl-tip-val tl-tip-mono">${formatUtc(pass.aos)}</span></div>` +
      `<div class="tl-tip-row"><span class="tl-tip-label">LOS</span><span class="tl-tip-val tl-tip-mono">${formatUtc(pass.los)}</span></div>` +
      `<div class="tl-tip-row"><span class="tl-tip-label">Duration</span><span class="tl-tip-val tl-tip-mono">${formatDuration(pass.durationSec)}</span></div>` +
      `<div class="tl-tip-row"><span class="tl-tip-label">Max EL</span><span class="tl-tip-val tl-tip-mono">${Number(pass.maxElDeg || 0).toFixed(1)}°</span></div>` +
      `<div class="tl-tip-sep"></div>` +
      `<div class="tl-tip-status tl-tip-status-${pass.status || 'predicted'}">${escapeHtml(pass.status || 'predicted')}</div>`;
    tooltip.style.display = 'block';
  }

  function onBarMove(event) {
    if (tooltip.style.display === 'none') return;
    tooltip.style.left = `${event.clientX + 12}px`;
    tooltip.style.top = `${event.clientY + 12}px`;
  }

  function onBarOut(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const bar = target.closest('.tl-bar');
    if (!bar) return;
    tooltip.style.display = 'none';
  }

  function syncBarSelectionClass() {
    rowsEl.querySelectorAll('.tl-bar').forEach((bar) => {
      const passId = bar.getAttribute('data-pass-id');
      bar.classList.toggle('selected', !!passId && selectedPassIds.has(passId));
    });
  }

  function updateSelectionUi() {
    selCount.textContent = String(selectedPassIds.size);
  }

  function syncDetailPanel() {
    const pass = activePassId ? passById.get(activePassId) : null;
    if (!pass) {
      detail.style.display = 'none';
      detail.innerHTML = '';
      return;
    }

    const satName = getState().satellites?.[pass.satelliteId]?.name || pass.satelliteName || pass.satelliteId;
    const stationName = getState().stations?.[pass.stationId]?.name || pass.stationName || pass.stationId;
    const antennaName = pass.antennaId
      ? (getState().antennas?.[pass.antennaId]?.name || pass.antennaId)
      : 'unassigned';

    detail.innerHTML = `
      <div class="tl-detail-title">${escapeHtml(satName)} · ${escapeHtml(stationName)}</div>
      <div class="tl-detail-grid">
        <div><span>AOS</span><strong>${formatUtc(pass.aos)}</strong></div>
        <div><span>LOS</span><strong>${formatUtc(pass.los)}</strong></div>
        <div><span>Duration</span><strong>${formatDuration(pass.durationSec)}</strong></div>
        <div><span>Max EL</span><strong>${Number(pass.maxElDeg || 0).toFixed(1)}°</strong></div>
        <div><span>Status</span><strong>${escapeHtml(pass.status || 'predicted')}</strong></div>
        <div><span>Antenna</span><strong>${escapeHtml(antennaName)}</strong></div>
      </div>
      <div class="tl-detail-hint">Shift+click bars to multi-select.</div>
    `;
    detail.style.display = '';
  }

  function zoomAtCenter(factor) {
    const rect = canvasWrap.getBoundingClientRect();
    zoomAtPoint(factor, rect.left + rect.width / 2);
  }

  function zoomAtPoint(factor, clientX) {
    if (!windowRange) return;
    const oldPxPerHour = pxPerHour;
    const oldWidth = (windowRange.rangeMs / HOUR_MS) * oldPxPerHour;
    const wrapRect = canvasWrap.getBoundingClientRect();
    const anchorX = canvasWrap.scrollLeft + (clientX - wrapRect.left);
    const anchorRatio = oldWidth > 0 ? anchorX / oldWidth : 0;

    pxPerHour = clamp(pxPerHour * factor, ZOOM_MIN, ZOOM_MAX);
    renderTimeline();

    const newWidth = (windowRange.rangeMs / HOUR_MS) * pxPerHour;
    const nextAnchor = newWidth * anchorRatio;
    canvasWrap.scrollLeft = Math.max(0, nextAnchor - (clientX - wrapRect.left));
  }

  function fitAll() {
    if (!windowRange) return;
    const hours = windowRange.rangeMs / HOUR_MS;
    const target = Math.max(1, canvasWrap.clientWidth - 36) / Math.max(1, hours);
    pxPerHour = clamp(target, ZOOM_MIN, ZOOM_MAX);
    renderTimeline();
    canvasWrap.scrollLeft = 0;
  }
}

function renderTicks(container, startMs, endMs, pxPerHour, contentWidth) {
  const interval = pickTickInterval(pxPerHour);
  const first = Math.floor(startMs / interval) * interval;
  const range = Math.max(1, endMs - startMs);
  let html = '';

  for (let t = first; t <= endMs + interval; t += interval) {
    const pct = ((t - startMs) / range) * 100;
    if (pct < -2 || pct > 102) continue;
    const dt = new Date(t);
    const isDayBoundary = dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0;
    const label = formatTickLabel(dt, interval);
    html += `<div class="tl-tick ${isDayBoundary ? 'day-boundary' : ''}" style="left:${pct}%;"><span>${escapeHtml(label)}</span></div>`;
  }

  container.innerHTML = `<div class="tl-time-axis" style="width:${contentWidth}px">${html}</div>`;
}

function pickTickInterval(pxPerHour) {
  if (pxPerHour < 60) return 6 * HOUR_MS;
  if (pxPerHour < 100) return 3 * HOUR_MS;
  if (pxPerHour < 160) return 2 * HOUR_MS;
  if (pxPerHour < 260) return 1 * HOUR_MS;
  if (pxPerHour < 420) return 30 * MINUTE_MS;
  return 15 * MINUTE_MS;
}

function buildConflictRanges(conflicts, passById) {
  /** @type {Map<string, Array<{startMs:number,endMs:number}>>} */
  const rangesByStation = new Map();
  for (const conflict of conflicts) {
    const passIds = Array.isArray(conflict?.passIds) ? conflict.passIds : [];
    if (passIds.length < 2) continue;
    const left = passById.get(passIds[0]);
    const right = passById.get(passIds[1]);
    if (!left || !right || left.stationId !== right.stationId) continue;

    const startMs = Math.max(toDate(left.aos)?.getTime() || 0, toDate(right.aos)?.getTime() || 0);
    const endMs = Math.min(toDate(left.los)?.getTime() || 0, toDate(right.los)?.getTime() || 0);
    if (endMs <= startMs) continue;

    if (!rangesByStation.has(left.stationId)) rangesByStation.set(left.stationId, []);
    rangesByStation.get(left.stationId).push({ startMs, endMs });
  }
  return rangesByStation;
}

function formatTickLabel(date, interval) {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  if (interval >= HOUR_MS) {
    const day = `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
    return date.getUTCHours() === 0 ? `${day} 00:00` : `${hh}:00`;
  }
  return `${hh}:${mm}`;
}

function msToPx(ms, windowRange, width) {
  return ((ms - windowRange.startMs) / windowRange.rangeMs) * width;
}

function msDeltaToPx(delta, windowRange, width) {
  return (delta / windowRange.rangeMs) * width;
}

function formatUtc(value) {
  const date = toDate(value);
  if (!date) return '—';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatDuration(sec = 0) {
  const value = Number(sec) || 0;
  const min = Math.floor(value / 60);
  const rem = Math.floor(value % 60);
  return `${min}:${String(rem).padStart(2, '0')}`;
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
