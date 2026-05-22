/**
 * Application shell — thin entry point.
 *
 * Creates the shared Cesium Viewer, initializes the tab bar,
 * and delegates to tab modules. All business logic lives in
 * tabs/ and core/ modules.
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';

import { patch } from './core/app-store.js';
import {
  fetchGroups,
  fetchStations,
  fetchAntennas,
  fetchMappings,
  fetchAntennaMask,
  fetchSatellites,
} from './core/api.js';
import { initTabBar } from './ui/tab-bar.js';
import { initOrbitViewer } from './tabs/orbit-viewer.js';
import { initScheduleManager } from './tabs/schedule-manager.js';
import { initTimeline } from './tabs/timeline-view.js';
import { initConfiguration } from './tabs/configuration.js';

// ─── Cesium Viewer Setup (shared singleton) ───
const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
    ),
  ),
  baseLayerPicker: false,
  geocoder: false,
  homeButton: true,
  sceneModePicker: true,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: true,
  scene3DOnly: false,
  shouldAnimate: true,
  // requestRenderMode skips rendering when nothing is changing (paused playback,
  // scrub idle, no camera/entity changes). maximumRenderTimeChange=0 means any
  // simulation-time advance triggers a render, so active playback is unchanged.
  // Net effect: zero GPU during pauses, identical fluidity during playback.
  requestRenderMode: true,
  maximumRenderTimeChange: 0,
  shadows: false,
  // Use single-Earth 2D rendering instead of infinite-scroll. INFINITE_SCROLL
  // (the default) re-renders the scene multiple times to fake horizontal
  // tiling and is the dominant 2D bottleneck — see CesiumGS/cesium#5026.
  mapMode2D: Cesium.MapMode2D.ROTATE,
  contextOptions: {
    webgl: {
      preserveDrawingBuffer: true, // required for canvas capture/recording
    },
  },
});

// FXAA is a cheap single-pass post-process AA. Keep it on in both modes.
viewer.scene.fxaa = true;

// ─── Per-scene-mode quality profile ────────────────────────────────────────
// 2D scene mode fills the entire canvas with flat imagery; horizon/frustum
// culling cannot help, and CesiumJS's MSAA (default 4×) compounds with our
// native-DPR resolutionScale to produce a 4–9× pixel-fill workload. Lighting
// and atmospheric effects are essentially invisible in 2D but still cost
// shader / draw-call time. Apply a tighter profile when the user morphs to 2D
// and restore the 3D profile when they morph back.
const HI_DPR = window.devicePixelRatio || 1;

function applyQualityForMode(mode) {
  const is2D = mode === Cesium.SceneMode.SCENE2D;

  viewer.resolutionScale = is2D ? 1.0 : HI_DPR;
  if (typeof viewer.scene.msaaSamples === 'number') {
    viewer.scene.msaaSamples = is2D ? 1 : 4;
  }
  viewer.scene.globe.enableLighting = !is2D;
  viewer.scene.skyAtmosphere.show = !is2D;
  viewer.scene.fog.enabled = !is2D;
  viewer.scene.globe.showGroundAtmosphere = !is2D;

  // Force one render so the new quality profile is visible immediately,
  // not delayed until the next user interaction. requestRender() is a
  // no-op when a frame is already pending.
  viewer.scene.requestRender();
}

// Initial application — viewer starts in 3D by default.
applyQualityForMode(viewer.scene.mode);

// During morph animation itself, drop to low quality preemptively so the
// transition itself doesn't stutter (it can render at full quality once the
// destination mode is reached).
viewer.scene.morphStart.addEventListener(() => {
  viewer.resolutionScale = 1.0;
  if (typeof viewer.scene.msaaSamples === 'number') viewer.scene.msaaSamples = 1;
});

viewer.scene.morphComplete.addEventListener(() => {
  applyQualityForMode(viewer.scene.mode);
});

// Home button flies to South Korea (does NOT affect initial startup view)
viewer.homeButton.viewModel.command.beforeExecute.addEventListener((e) => {
  e.cancel = true;
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(124.5, 33.0, 132.0, 43.0),
    duration: 1.5,
  });
});

// ─── Initialize Tab Bar ───
initTabBar();

bootstrap();

async function bootstrap() {
  await Promise.all([
    loadGroupsIntoStore(),
    loadStationsIntoStore(),
    loadSatellitesIntoStore(),
  ]);
  // Must initialize tab modules after shared station/antenna/mapping data is loaded.
  initOrbitViewer(viewer);
  initScheduleManager();
  initTimeline();
  initConfiguration();
}

async function loadStationsIntoStore() {
  try {
    const [stations, antennas, mappings] = await Promise.all([
      fetchStations(),
      fetchAntennas(),
      fetchMappings(),
    ]);

    const maskByAntennaId = await fetchMaskMapForAntennas(antennas);
    applyStationBootstrap(parseStationsAndAntennas(stations, antennas, maskByAntennaId), mappings);
  } catch (error) {
    console.error('Failed to load stations/antennas/mappings from API:', error);
  }
}

function applyStationBootstrap(data, mappings = []) {
  replaceObjectSlice('stations', data.stationRecord);
  replaceObjectSlice('antennas', data.antennaRecord);
  patch('antennaMappings', Array.isArray(mappings) ? mappings : []);
}

function parseStationsAndAntennas(stations, antennas = [], maskByAntennaId = {}) {
  const stationRecord = stations.reduce((acc, station) => {
    if (!station?.id) return acc;
    const antennas = Array.isArray(station.antennas) ? station.antennas : [];
    acc[station.id] = {
      ...station,
      antennas: antennas.map((ant) => ({
        id: ant.id,
        name: ant.name,
        type: ant.type || '',
        mask: Array.isArray(maskByAntennaId[ant.id]) ? maskByAntennaId[ant.id] : [],
      })),
    };
    return acc;
  }, {});

  const antennaList = antennas.length > 0
    ? antennas
    : Object.values(stationRecord).flatMap((station) => (
      (station.antennas || []).map((antenna) => ({
        ...antenna,
        stationId: station.id,
      }))
    ));

  const antennaRecord = {};
  for (const antenna of antennaList) {
    if (!antenna?.id || !antenna?.stationId) continue;
    antennaRecord[antenna.id] = {
      id: antenna.id,
      stationId: antenna.stationId,
      name: antenna.name || antenna.id,
      type: antenna.type || '',
      mask: Array.isArray(maskByAntennaId[antenna.id]) ? maskByAntennaId[antenna.id] : [],
    };
  }

  return { stationRecord, antennaRecord };
}

async function fetchMaskMapForAntennas(antennas = []) {
  const antennaList = Array.isArray(antennas) ? antennas : [];
  const maskByAntennaId = {};

  await Promise.all(antennaList.map(async (antenna) => {
    if (!antenna?.id) return;
    try {
      const response = await fetchAntennaMask(antenna.id);
      maskByAntennaId[antenna.id] = Array.isArray(response?.entries) ? response.entries : [];
    } catch (error) {
      console.warn(`Failed to fetch mask for antenna ${antenna.id}:`, error);
      maskByAntennaId[antenna.id] = [];
    }
  }));

  return maskByAntennaId;
}

function replaceObjectSlice(sliceName, nextValue) {
  patch(sliceName, (current) => {
    for (const key of Object.keys(current)) {
      delete current[key];
    }
    return nextValue;
  });
}

async function loadGroupsIntoStore() {
  try {
    const groups = await fetchGroups();
    const record = (Array.isArray(groups) ? groups : []).reduce((acc, group) => {
      if (!group?.id) return acc;
      acc[group.id] = {
        id: group.id,
        name: group.name,
        label: group.label,
        color: group.color || '',
        sortOrder: typeof group.sortOrder === 'number' ? group.sortOrder : 0,
        schedulable: group.schedulable === true,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      };
      return acc;
    }, {});
    replaceObjectSlice('groups', record);
  } catch (error) {
    console.error('Failed to load groups from API:', error);
  }
}

async function loadSatellitesIntoStore() {
  try {
    const satellites = await fetchSatellites();
    const record = (Array.isArray(satellites) ? satellites : []).reduce((acc, sat) => {
      if (!sat?.id) return acc;
      acc[sat.id] = {
        id: sat.id,
        name: sat.name,
        noradId: sat.noradId,
        groupName: sat.groupName || '',
        tle: [sat.tleLine0, sat.tleLine1, sat.tleLine2].filter(Boolean).join('\n'),
        tleLine0: sat.tleLine0 || '',
        tleLine1: sat.tleLine1,
        tleLine2: sat.tleLine2,
        color: sat.color || '#7dd3fc',
        enabled: sat.enabled !== false,
      };
      return acc;
    }, {});
    replaceObjectSlice('satellites', record);
  } catch (error) {
    console.error('Failed to load satellites from API:', error);
  }
}
