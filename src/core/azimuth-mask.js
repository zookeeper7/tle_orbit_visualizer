const EPS = 1e-9;

/**
 * Parse CSV text into sorted mask entries.
 * @param {string} csvText
 * @returns {Array<{azDeg: number, minElDeg: number}>}
 */
export function parseMaskCSV(csvText) {
  if (typeof csvText !== 'string') {
    throw new Error('CSV content must be a string');
  }

  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  let startIndex = 0;
  if (looksLikeHeader(lines[0])) {
    startIndex = 1;
  }

  /** @type {Map<number, number>} */
  const byAzimuth = new Map();

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 2) {
      throw new Error(`Invalid CSV row at line ${i + 1}`);
    }

    const azDegRaw = Number(parts[0]);
    const minElRaw = Number(parts[1]);

    if (!Number.isFinite(azDegRaw) || !Number.isFinite(minElRaw)) {
      throw new Error(`Non-numeric value at line ${i + 1}`);
    }

    if (azDegRaw < 0 || azDegRaw > 360) {
      throw new Error(`azimuth_deg out of range [0,360] at line ${i + 1}`);
    }
    if (minElRaw < 0 || minElRaw > 90) {
      throw new Error(`min_elev_deg out of range [0,90] at line ${i + 1}`);
    }

    const azDeg = normalizeAzimuthDeg(azDegRaw);
    byAzimuth.set(azDeg, minElRaw);
  }

  return Array.from(byAzimuth.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([azDeg, minElDeg]) => ({ azDeg, minElDeg }));
}

/**
 * Piecewise-linear interpolation with 360°→0° wrap.
 * @param {Array<{azDeg: number, minElDeg: number}>} mask
 * @param {number} azDeg
 * @returns {number}
 */
export function getMaskMinElev(mask, azDeg) {
  const points = Array.isArray(mask) ? mask : [];
  if (points.length === 0) return 0;
  if (points.length === 1) return Number(points[0].minElDeg) || 0;

  const q = normalizeAzimuthDeg(azDeg);

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];

    const aAz = normalizeAzimuthDeg(a.azDeg);
    let bAz = normalizeAzimuthDeg(b.azDeg);
    let qSeg = q;

    if (i === points.length - 1) {
      bAz += 360;
      if (qSeg < aAz) qSeg += 360;
    }

    if (qSeg + EPS < aAz || qSeg - EPS > bAz) continue;

    const span = bAz - aAz;
    if (Math.abs(span) < EPS) {
      return Number(b.minElDeg) || Number(a.minElDeg) || 0;
    }

    const t = (qSeg - aAz) / span;
    const y0 = Number(a.minElDeg) || 0;
    const y1 = Number(b.minElDeg) || 0;
    return y0 + (y1 - y0) * t;
  }

  return Number(points[0].minElDeg) || 0;
}

function looksLikeHeader(line) {
  const normalized = String(line).toLowerCase().replaceAll(' ', '');
  return normalized.includes('azimuth_deg') && normalized.includes('min_elev_deg');
}

function normalizeAzimuthDeg(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const wrapped = ((n % 360) + 360) % 360;
  return wrapped === 360 ? 0 : wrapped;
}
