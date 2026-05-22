/**
 * Detect overlapping passes per antenna.
 *
 * Complexity: O(n log n) due to sorting by AOS per antenna.
 *
 * @param {Array<{id:string, stationId:string, antennaId:string|null, aos:Date, los:Date}>} passes
 * @returns {Array<{antennaId:string, stationId:string, passIds:[string,string], overlapSec:number}>}
 */
export function detectConflicts(passes) {
  if (!Array.isArray(passes) || passes.length < 2) return [];

  /** @type {Map<string, Array<{id:string, stationId:string, antennaId:string, aos:Date, los:Date}>>} */
  const byAntenna = new Map();

  for (const pass of passes) {
    if (!pass || !pass.stationId || !pass.antennaId || !(pass.aos instanceof Date) || !(pass.los instanceof Date)) {
      continue;
    }
    if (!byAntenna.has(pass.antennaId)) {
      byAntenna.set(pass.antennaId, []);
    }
    byAntenna.get(pass.antennaId).push(pass);
  }

  /** @type {Array<{antennaId:string, stationId:string, passIds:[string,string], overlapSec:number}>} */
  const conflicts = [];

  for (const [antennaId, antennaPasses] of byAntenna.entries()) {
    if (antennaPasses.length < 2) continue;

    antennaPasses.sort((a, b) => a.aos.getTime() - b.aos.getTime());

    for (let i = 0; i < antennaPasses.length - 1; i++) {
      const left = antennaPasses[i];

      for (let j = i + 1; j < antennaPasses.length; j++) {
        const right = antennaPasses[j];

        if (right.aos.getTime() >= left.los.getTime()) {
          break;
        }

        const overlapMs = Math.min(left.los.getTime(), right.los.getTime()) - right.aos.getTime();
        if (overlapMs <= 0) continue;

        conflicts.push({
          antennaId,
          stationId: left.stationId,
          passIds: [left.id, right.id],
          overlapSec: overlapMs / 1000,
        });
      }
    }
  }

  return conflicts;
}
