/**
 * Tab bar UI — switching between app sections.
 *
 * Uses the centralized store's ui.activeTab to drive visibility.
 * Cesium viewer container is shown only on 'orbit-viewer' tab.
 */

import { getState, patch, subscribe } from '../core/app-store.js';

const TABS = [
  { id: 'orbit-viewer',      label: 'Orbit Viewer',    icon: '&#128752;' },
  { id: 'schedule-manager',  label: 'Schedule Mgr',    icon: '&#128203;' },
  { id: 'configuration',     label: 'Configuration',   icon: '&#9881;' },
];

/**
 * Initialize the tab bar and wire up click handlers + store subscription.
 */
export function initTabBar() {
  const bar = document.getElementById('tabBar');
  if (!bar) return;

  // Render tab buttons
  bar.innerHTML = TABS.map(t =>
    `<button class="tab-btn" data-tab="${t.id}" title="${t.label}">
       <span class="tab-icon">${t.icon}</span>
       <span class="tab-label">${t.label}</span>
     </button>`,
  ).join('');

  // Click handlers
  bar.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      patch('ui', { activeTab: tabId });
    });
  });

  // React to store changes
  subscribe('ui', (ui) => {
    applyActiveTab(ui.activeTab);
  });

  // Apply initial state
  applyActiveTab(getState().ui.activeTab);
}

/**
 * Show/hide tab sections and update button active states.
 */
function applyActiveTab(activeId) {
  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === activeId);
  });

  // Tab content sections
  TABS.forEach(t => {
    const section = document.getElementById(`tab-${t.id}`);
    if (section) {
      section.style.display = t.id === activeId ? '' : 'none';
    }
  });

  // Cesium container: visible only on orbit-viewer
  const cesium = document.getElementById('cesiumContainer');
  if (cesium) {
    cesium.style.display = activeId === 'orbit-viewer' ? '' : 'none';
  }

  // Playback bar: visible only on orbit-viewer
  const pb = document.getElementById('playbackBar');
  if (pb) {
    pb.style.display = activeId === 'orbit-viewer' ? '' : 'none';
  }
}
