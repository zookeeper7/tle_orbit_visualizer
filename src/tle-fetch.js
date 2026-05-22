/**
 * Internet connectivity check, live TLE fetching, and satellite search from CelesTrak.
 *
 * CelesTrak GP API:
 *   https://celestrak.org/NORAD/elements/gp.php?CATNR={noradId}&FORMAT=TLE
 *   https://celestrak.org/NORAD/elements/gp.php?NAME={query}&FORMAT=JSON
 *
 * Returns standard 3-line TLE (name + line1 + line2) or JSON orbital elements.
 */

const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';

/**
 * Check internet connectivity by sending a lightweight HEAD request to CelesTrak.
 * @returns {Promise<boolean>} true if CelesTrak is reachable
 */
export async function checkConnection() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${CELESTRAK_BASE}?CATNR=25544&FORMAT=TLE`, {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-store',
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the latest TLE for a satellite from CelesTrak.
 * @param {number} noradId - NORAD catalog number
 * @returns {Promise<string>} 3-line TLE string (name\nline1\nline2)
 * @throws {Error} on network failure or invalid response
 */
export async function fetchLatestTLE(noradId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let response;
  try {
    response = await fetch(
      `${CELESTRAK_BASE}?CATNR=${noradId}&FORMAT=TLE`,
      { signal: controller.signal, cache: 'no-store' },
    );
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out — check your internet connection.');
    }
    throw new Error(`Network error: ${err.message}`);
  }

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`CelesTrak returned HTTP ${response.status}`);
  }

  const text = (await response.text()).trim();

  if (!text || text.startsWith('No GP')) {
    throw new Error(`No TLE found for NORAD ID ${noradId}`);
  }

  // Validate: should be 3 lines (name + line1 + line2)
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) {
    throw new Error('Invalid TLE response from CelesTrak');
  }

  return lines.slice(0, 3).join('\n');
}

/**
 * Search satellites by name on CelesTrak (partial match).
 * @param {string} query - Search query (e.g. "KOMPSAT", "ISS", "NOAA")
 * @returns {Promise<Array<{name:string, noradId:number, objectId:string}>>}
 * @throws {Error} on network failure or invalid response
 */
export async function searchSatellitesByName(query) {
  if (!query || query.trim().length < 2) return [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let response;
  try {
    response = await fetch(
      `${CELESTRAK_BASE}?NAME=${encodeURIComponent(query.trim())}&FORMAT=JSON`,
      { signal: controller.signal, cache: 'no-store' },
    );
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Search timed out.');
    throw new Error(`Network error: ${err.message}`);
  }

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`CelesTrak returned HTTP ${response.status}`);
  }

  const text = (await response.text()).trim();
  if (!text || text.startsWith('No GP')) return [];

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  if (!Array.isArray(data)) return [];

  return data.map((item) => ({
    name: item.OBJECT_NAME || '',
    noradId: item.NORAD_CAT_ID || 0,
    objectId: item.OBJECT_ID || '',
    inclination: item.INCLINATION,
    period: item.MEAN_MOTION ? (1440 / item.MEAN_MOTION) : null,
  }));
}

/**
 * Search satellites by NORAD catalog number on CelesTrak.
 * @param {number} noradId - NORAD catalog number
 * @returns {Promise<Array<{name:string, noradId:number, objectId:string}>>}
 */
export async function searchSatellitesByNorad(noradId) {
  if (!Number.isFinite(noradId) || noradId <= 0) return [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let response;
  try {
    response = await fetch(
      `${CELESTRAK_BASE}?CATNR=${noradId}&FORMAT=JSON`,
      { signal: controller.signal, cache: 'no-store' },
    );
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Search timed out.');
    throw new Error(`Network error: ${err.message}`);
  }

  clearTimeout(timeoutId);

  if (!response.ok) return [];

  const text = (await response.text()).trim();
  if (!text || text.startsWith('No GP')) return [];

  let data;
  try { data = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(data)) return [];

  return data.map((item) => ({
    name: item.OBJECT_NAME || '',
    noradId: item.NORAD_CAT_ID || 0,
    objectId: item.OBJECT_ID || '',
    inclination: item.INCLINATION,
    period: item.MEAN_MOTION ? (1440 / item.MEAN_MOTION) : null,
  }));
}
