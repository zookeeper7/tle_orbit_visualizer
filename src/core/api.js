/**
 * Backend router — picks the implementation at build time.
 *
 * - Default (development server, self-hosted production):
 *   talks to the Express + SQLite server defined in server.js via /api/*.
 *
 * - Demo build (VITE_BACKEND=local):
 *   uses the localStorage adapter so the app can be served as a 100% static
 *   site (e.g. GitHub Pages) with per-visitor isolated state.
 *
 * The two implementations export the exact same function names with the
 * same shapes, so callers never need to know which backend they're on.
 */

import * as restApi from './api-rest.js';
import * as localApi from './api-local.js';

const impl = import.meta.env.VITE_BACKEND === 'local' ? localApi : restApi;

export const {
  // Stations
  fetchStations,
  createStation,
  updateStation,
  deleteStation,
  // Antennas
  fetchAntennas,
  createAntenna,
  updateAntenna,
  deleteAntenna,
  // Antenna masks
  fetchAntennaMask,
  uploadAntennaMask,
  deleteAntennaMask,
  // Antenna mappings
  fetchMappings,
  createMapping,
  updateMappingRole,
  deleteMapping,
  // Passes
  fetchPasses,
  bulkUpsertPasses,
  updatePass,
  // Satellites
  fetchSatellites,
  createSatellite,
  updateSatellite,
  deleteSatellite,
  // Settings
  getSetting,
  putSetting,
  // Groups
  fetchGroups,
  createGroup,
  updateGroup,
  deleteGroup,
} = impl;
