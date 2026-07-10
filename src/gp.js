/**
 * GP / OMM (Orbit Mean-Elements Message) support.
 *
 * CelesTrak is retiring the fixed-width TLE format: the 5-digit catalog number
 * space runs out at 69999 (~2026-07), after which objects get 6+ digit catalog
 * numbers that the TLE `FORMAT=TLE` query can no longer return. The forward-
 * compatible query is `FORMAT=JSON`, which returns CCSDS OMM records.
 *
 * This module is the bridge that lets the rest of the app keep speaking "TLE"
 * (its entire storage + SGP4 pipeline is TLE-based) while ingesting OMM:
 *
 *   - `ommToTLE(omm)` reconstructs a legacy-compatible 3-line TLE from an OMM
 *     record, using Alpha-5 encoding for catalog numbers 100000–339999 so the
 *     existing `satellite.twoline2satrec` path keeps working unchanged.
 *   - `alpha5Encode` / `alpha5Decode` implement the official Alpha-5 scheme.
 *   - `CelestrakError` carries the HTTP status so batch fetchers can stop on a
 *     rate-limit (403) instead of hammering CelesTrak into a firewall block.
 *
 * The module is intentionally PURE (no `satellite.js` import) so it can be
 * shared by the browser app, the Node/Express server, and the localStorage
 * demo adapter without pulling the SGP4 engine into the server bundle.
 *
 * OMM field reference (CelesTrak gp.php?...&FORMAT=JSON):
 *   OBJECT_NAME, OBJECT_ID, EPOCH (ISO 8601 UTC, no trailing Z),
 *   MEAN_MOTION (rev/day), ECCENTRICITY, INCLINATION/RA_OF_ASC_NODE/
 *   ARG_OF_PERICENTER/MEAN_ANOMALY (deg), EPHEMERIS_TYPE, CLASSIFICATION_TYPE,
 *   NORAD_CAT_ID, ELEMENT_SET_NO, REV_AT_EPOCH, BSTAR (1/earth-radii),
 *   MEAN_MOTION_DOT (rev/day^2), MEAN_MOTION_DDOT (rev/day^3).
 */

/** Alpha-5 alphabet: A–Z excluding I and O (24 letters). */
const ALPHA5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ALPHA5_MAX = 339999; // Z9999

/**
 * Error thrown by CelesTrak fetch/convert paths. Carries the HTTP status so
 * callers can distinguish rate-limiting (403) and not-found (404) from generic
 * failures, and an `unsupported` flag for values a TLE simply cannot represent.
 */
export class CelestrakError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, unsupported?: boolean, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'CelestrakError';
    this.status = typeof opts.status === 'number' ? opts.status : null;
    this.unsupported = opts.unsupported === true;
    // 403 = CelesTrak rate-limit / firewall response. Batch loops must stop.
    this.isRateLimited = this.status === 403;
    // 404 = no GP data for this object; retrying won't help.
    this.isNotFound = this.status === 404;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Encode a NORAD catalog number into a 5-character TLE catalog field.
 * 0–99999 → zero-padded digits; 100000–339999 → Alpha-5 (leading letter).
 * Throws for values above the Alpha-5 ceiling (a TLE cannot represent them).
 * @param {number|string} noradId
 * @returns {string} exactly 5 characters
 */
export function alpha5Encode(noradId) {
  const num = Number(noradId);
  if (!Number.isInteger(num) || num < 0) {
    throw new CelestrakError(`Invalid catalog number: ${noradId}`);
  }
  if (num <= 99999) return String(num).padStart(5, '0');
  if (num <= ALPHA5_MAX) {
    const high = Math.floor(num / 10000); // 10..33
    const letter = ALPHA5[high - 10];
    const last4 = String(num % 10000).padStart(4, '0');
    return `${letter}${last4}`;
  }
  throw new CelestrakError(
    `Catalog number ${num} exceeds the Alpha-5 range (max ${ALPHA5_MAX}); the TLE format cannot represent it. Use the OMM/JSON path.`,
    { unsupported: true },
  );
}

/**
 * Decode a 5-character TLE catalog field (numeric or Alpha-5) to a number.
 * Returns NaN for an unparseable field.
 * @param {string} field
 * @returns {number}
 */
export function alpha5Decode(field) {
  const str = String(field == null ? '' : field).trim();
  if (str === '') return NaN;
  if (/^\d{1,5}$/.test(str)) return Number(str);
  const letter = str[0].toUpperCase();
  const idx = ALPHA5.indexOf(letter);
  if (idx < 0) return NaN;
  const rest = str.slice(1);
  if (!/^\d{1,4}$/.test(rest)) return NaN;
  return (idx + 10) * 10000 + Number(rest);
}

/** Can this catalog number be represented as a (possibly Alpha-5) TLE? */
export function isTleRepresentable(noradId) {
  const num = Number(noradId);
  return Number.isInteger(num) && num >= 0 && num <= ALPHA5_MAX;
}

/**
 * Reconstruct a legacy-compatible 3-line TLE from a CelesTrak OMM record.
 * The generated lines use the exact fixed-column layout that
 * `satellite.twoline2satrec` parses, so the app's existing SGP4 pipeline
 * consumes the result unchanged.
 *
 * @param {Record<string, unknown>} omm - a single CelesTrak OMM JSON object
 * @returns {{ line0: string, line1: string, line2: string, threeLine: string }}
 * @throws {CelestrakError} if required fields are missing or the catalog number
 *   is not TLE-representable.
 */
export function ommToTLE(omm) {
  if (!omm || typeof omm !== 'object') {
    throw new CelestrakError('Invalid OMM record');
  }

  const noradId = Number(omm.NORAD_CAT_ID);
  if (!Number.isFinite(noradId)) {
    throw new CelestrakError('OMM record missing NORAD_CAT_ID');
  }
  const cat = alpha5Encode(noradId); // 5 chars (throws if > Alpha-5 range)

  const cls = (String(omm.CLASSIFICATION_TYPE || 'U').trim()[0] || 'U'); // 1
  const intl = formatIntlDesignator(omm.OBJECT_ID); // 8
  const epoch = formatEpoch(omm.EPOCH); // 14
  const ndot = formatNdot(numOr0(omm.MEAN_MOTION_DOT)); // 10
  const nddot = encodeTleExp(numOr0(omm.MEAN_MOTION_DDOT)); // 8
  const bstar = encodeTleExp(numOr0(omm.BSTAR)); // 8
  const ephType = String(Math.trunc(numOr0(omm.EPHEMERIS_TYPE)) % 10); // 1
  const elset = String(Math.trunc(numOr0(omm.ELEMENT_SET_NO))).padStart(4, ' ').slice(-4); // 4

  // Columns (1-indexed): 1='1' 2=' ' 3-7=cat 8=cls 9=' ' 10-17=intl 18=' '
  // 19-32=epoch 33=' ' 34-43=ndot 44=' ' 45-52=nddot 53=' ' 54-61=bstar
  // 62=' ' 63=ephType 64=' ' 65-68=elset
  const line1Body = `1 ${cat}${cls} ${intl} ${epoch} ${ndot} ${nddot} ${bstar} ${ephType} ${elset}`;
  const line1 = withChecksum(line1Body, 'line1');

  const incl = pad8deg(numOr0(omm.INCLINATION)); // 8
  const raan = pad8deg(numOr0(omm.RA_OF_ASC_NODE)); // 8
  const ecc = formatEcc(numOr0(omm.ECCENTRICITY)); // 7 (implied leading '.')
  const argp = pad8deg(numOr0(omm.ARG_OF_PERICENTER)); // 8
  const ma = pad8deg(numOr0(omm.MEAN_ANOMALY)); // 8
  const mm = (numOr0(omm.MEAN_MOTION)).toFixed(8).padStart(11, ' '); // 11
  const rev = String(Math.trunc(numOr0(omm.REV_AT_EPOCH))).padStart(5, ' ').slice(-5); // 5

  // Columns: 1='2' 2=' ' 3-7=cat 8=' ' 9-16=incl 17=' ' 18-25=raan 26=' '
  // 27-33=ecc 34=' ' 35-42=argp 43=' ' 44-51=ma 52=' ' 53-63=mm 64-68=rev
  const line2Body = `2 ${cat} ${incl} ${raan} ${ecc} ${argp} ${ma} ${mm}${rev}`;
  const line2 = withChecksum(line2Body, 'line2');

  const name = String(omm.OBJECT_NAME || '').trim();
  return {
    line0: name,
    line1,
    line2,
    threeLine: name ? `${name}\n${line1}\n${line2}` : `${line1}\n${line2}`,
  };
}

/**
 * Slugify a satellite name + catalog number into a stable, unique id
 * (e.g. "ISS (ZARYA)" + 25544 → "iss_zarya_25544"). Used by bulk import.
 * @param {string} name
 * @param {number|string} noradId
 * @returns {string}
 */
export function makeSatelliteId(name, noradId) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base ? `${base}_${noradId}` : `norad_${noradId}`;
}

/**
 * Convert a CelesTrak OMM record into a createSatellite() payload, using
 * ommToTLE() for the legacy TLE lines. Throws (CelestrakError) when the catalog
 * number is not TLE-representable, so bulk importers can skip that record.
 *
 * @param {Record<string, unknown>} omm
 * @param {{ id?: string, groupName?: string, color?: string, enabled?: boolean }} [opts]
 * @returns {{ id:string, name:string, noradId:number|null, groupName:string,
 *   tleLine0:string, tleLine1:string, tleLine2:string, color:string, enabled:boolean }}
 */
export function ommToSatellitePayload(omm, opts = {}) {
  const tle = ommToTLE(omm);
  const noradId = Number(omm && omm.NORAD_CAT_ID);
  const name = (String((omm && omm.OBJECT_NAME) || '').trim()) || `NORAD ${noradId}`;
  return {
    id: opts.id || makeSatelliteId(name, noradId),
    name,
    noradId: Number.isFinite(noradId) ? noradId : null,
    groupName: opts.groupName || 'custom',
    tleLine0: tle.line0 || name,
    tleLine1: tle.line1,
    tleLine2: tle.line2,
    color: opts.color || '#7dd3fc',
    enabled: opts.enabled !== false,
  };
}

// ── formatting helpers ──────────────────────────────────────────────────────

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Assemble a 68-char body, verify width, and append the mod-10 checksum. */
function withChecksum(body, which) {
  if (body.length !== 68) {
    throw new CelestrakError(
      `Internal TLE formatting error: ${which} is ${body.length} chars (expected 68): "${body}"`,
    );
  }
  return body + tleChecksum(body);
}

/**
 * International Designator (OBJECT_ID "YYYY-NNNP...") → 8-char TLE field
 * "YYNNNPPP" (2-digit launch year, 3-digit launch number, up to 3-char piece).
 * Blank (8 spaces) when unavailable (e.g. analyst objects).
 */
function formatIntlDesignator(objectId) {
  const raw = String(objectId == null ? '' : objectId).trim();
  const m = raw.match(/^(\d{4})-(\d{1,3})([A-Z]{0,3})$/i);
  if (!m) return ' '.repeat(8);
  const yy = m[1].slice(-2);
  const num = m[2].padStart(3, '0').slice(-3);
  const piece = (m[3] || '').toUpperCase().padEnd(3, ' ');
  return `${yy}${num}${piece}`.slice(0, 8).padEnd(8, ' ');
}

/** ISO 8601 UTC epoch → "YYDDD.DDDDDDDD" (14 chars). CelesTrak omits the Z. */
function formatEpoch(epochIso) {
  const raw = String(epochIso == null ? '' : epochIso).trim();
  const iso = raw && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? `${raw}Z` : raw;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new CelestrakError(`Invalid OMM EPOCH: "${epochIso}"`);
  }
  const year = d.getUTCFullYear();
  const yy = String(year % 100).padStart(2, '0');
  const startOfYear = Date.UTC(year, 0, 1);
  const dayOfYear = (d.getTime() - startOfYear) / 86400000 + 1; // 1.0 = Jan 1 00:00
  const dayStr = dayOfYear.toFixed(8).padStart(12, '0'); // "DDD.DDDDDDDD"
  return `${yy}${dayStr}`; // 2 + 12 = 14
}

/** First derivative of mean motion → " .NNNNNNNN" / "-.NNNNNNNN" (10 chars). */
function formatNdot(value) {
  const sign = value < 0 ? '-' : ' ';
  const abs = Math.abs(value);
  // 8 fractional digits, drop the leading "0"; clamp pathological values.
  let frac = abs.toFixed(8); // "0.00005994"
  if (frac.startsWith('0.')) frac = frac.slice(1); // ".00005994"
  else frac = `.${'0'.repeat(8)}`; // |ndot| >= 1 is nonsense for this field
  frac = frac.slice(0, 9).padEnd(9, '0'); // exactly ".dddddddd" (9)
  return `${sign}${frac}`; // 10
}

/**
 * TLE "assumed decimal" exponent field ±MMMMM±E (8 chars) for BSTAR / nddot.
 * Represents ±0.MMMMM × 10^(±E). Returns " 00000-0" for 0 or unrepresentable.
 */
function encodeTleExp(value) {
  if (!value || !Number.isFinite(value)) return ' 00000-0';
  const sign = value < 0 ? '-' : ' ';
  const abs = Math.abs(value);
  let exp = Math.floor(Math.log10(abs)) + 1; // 0.MMMMM × 10^exp
  let mantissa = Math.round(abs * Math.pow(10, 5 - exp));
  // Rounding can carry mantissa to 100000 → renormalize.
  if (mantissa >= 100000) { mantissa = Math.round(mantissa / 10); exp += 1; }
  if (Math.abs(exp) > 9) return ' 00000-0'; // keep the field at 8 chars
  const expSign = exp < 0 ? '-' : '+';
  return `${sign}${String(mantissa).padStart(5, '0').slice(0, 5)}${expSign}${Math.abs(exp)}`;
}

/** Degrees → 8-char right-justified with 4 decimals (e.g. " 51.6305"). */
function pad8deg(value) {
  let s = value.toFixed(4);
  if (s.length > 8) s = s.slice(0, 8); // guard (angles are 0..360 → max 8)
  return s.padStart(8, ' ');
}

/** Eccentricity → 7-digit field with the leading "0." implied (e.g. "0006690"). */
function formatEcc(value) {
  const clamped = Math.min(Math.max(value, 0), 0.9999999);
  return Math.round(clamped * 1e7).toString().padStart(7, '0').slice(0, 7);
}

/** Standard TLE checksum: sum of digits (+1 per '-') over cols 1–68, mod 10. */
function tleChecksum(line) {
  let sum = 0;
  for (let i = 0; i < line.length && i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return String(sum % 10);
}
