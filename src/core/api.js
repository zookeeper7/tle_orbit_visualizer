const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!res.ok) {
    let message = `API error (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // no-op
    }
    throw new Error(message);
  }

  if (res.status === 204) return null;
  return res.json();
}

export async function fetchStations() {
  return request('/stations');
}

export async function createStation(data) {
  return request('/stations', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateStation(id, data) {
  return request(`/stations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteStation(id) {
  return request(`/stations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchAntennas(stationId) {
  const params = stationId ? `?stationId=${encodeURIComponent(stationId)}` : '';
  return request(`/antennas${params}`);
}

export async function createAntenna(data) {
  return request('/antennas', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateAntenna(id, data) {
  return request(`/antennas/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteAntenna(id) {
  return request(`/antennas/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchAntennaMask(antennaId) {
  return request(`/antennas/${encodeURIComponent(antennaId)}/mask`);
}

export async function uploadAntennaMask(antennaId, csvText) {
  return request(`/antennas/${encodeURIComponent(antennaId)}/mask/csv`, {
    method: 'POST',
    body: JSON.stringify({ csvText }),
  });
}

export async function deleteAntennaMask(antennaId) {
  return request(`/antennas/${encodeURIComponent(antennaId)}/mask`, {
    method: 'DELETE',
  });
}

export async function fetchMappings() {
  return request('/antenna-mappings');
}

export async function createMapping(data) {
  return request('/antenna-mappings', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateMappingRole(id, role) {
  return request(`/antenna-mappings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export async function deleteMapping(id) {
  return request(`/antenna-mappings/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchPasses(filters = {}) {
  const query = new URLSearchParams();
  if (filters.satelliteId) query.set('satelliteId', filters.satelliteId);
  if (filters.stationId) query.set('stationId', filters.stationId);
  if (filters.status) query.set('status', filters.status);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request(`/passes${suffix}`);
}

export async function bulkUpsertPasses(passes) {
  return request('/passes/bulk', {
    method: 'POST',
    body: JSON.stringify({
      passes: (Array.isArray(passes) ? passes : []).map((pass) => ({
        ...pass,
        aos: pass?.aos instanceof Date ? pass.aos.toISOString() : pass?.aos,
        los: pass?.los instanceof Date ? pass.los.toISOString() : pass?.los,
      })),
    }),
  });
}

export async function updatePass(id, data) {
  return request(`/passes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ─── Satellites ───

export async function fetchSatellites() {
  return request('/satellites');
}

export async function createSatellite(data) {
  return request('/satellites', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateSatellite(id, data) {
  return request(`/satellites/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteSatellite(id) {
  return request(`/satellites/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ─── Settings (convenience wrappers) ───

export async function getSetting(key) {
  return request(`/settings/${encodeURIComponent(key)}`);
}

export async function putSetting(key, value) {
  return request(`/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify(value),
  });
}

// ─── Groups (CRUD) ───

export async function fetchGroups() {
  return request('/groups');
}

export async function createGroup(data) {
  return request('/groups', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateGroup(id, data) {
  return request(`/groups/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteGroup(id) {
  return request(`/groups/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
