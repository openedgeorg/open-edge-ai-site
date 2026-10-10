/**
 * Arrow-key navigation on the Atlas map, as plain geometry (no DOM, so node can test it).
 *
 * An arrow key follows a drawn path to a neighbouring place that lies in its direction. Several
 * neighbours can lie the same way, so candidates are ranked by angle AND distance together: a
 * near neighbour a little off the axis beats a far one dead on the axis. A path only counts when
 * it lies within a cone around the key's direction (see ARROW_MIN_COS).
 *
 * Four keys cannot name every neighbour of a place with many paths, so pressing the opposite arrow
 * goes back to where the last arrow came from, and the next press of the first arrow then takes the
 * next-best neighbour that way: right, left, right, left tries each place to the right in turn.
 * Together this reaches every path from at least one of its ends (PageUp and PageDown still step
 * through every visible place in order).
 */

/** An arrow key only follows a path that lies within about 66 degrees of its direction. */
export const ARROW_MIN_COS = 0.4;

export const ARROW_KEYS = Object.freeze({
  ArrowRight: Object.freeze({ x: 1, y: 0 }),
  ArrowLeft: Object.freeze({ x: -1, y: 0 }),
  ArrowDown: Object.freeze({ x: 0, y: 1 }),
  ArrowUp: Object.freeze({ x: 0, y: -1 }),
});

const OPPOSITE = Object.freeze({
  ArrowRight: "ArrowLeft",
  ArrowLeft: "ArrowRight",
  ArrowDown: "ArrowUp",
  ArrowUp: "ArrowDown",
});

/**
 * The candidates inside the cone of `dir`, best first. The score is the distance stretched by how
 * far the path leans off the axis: dist * (1 + 2 * (1 - cos)).
 * @param {{x: number, y: number}} from
 * @param {Array<{id: string, x: number, y: number}>} candidates
 * @param {{x: number, y: number}} dir a unit vector
 * @param {number} [minCos]
 * @returns {string[]} candidate ids
 */
export function rankInDirection(from, candidates, dir, minCos = ARROW_MIN_COS) {
  const ranked = [];
  for (const other of candidates) {
    const dx = other.x - from.x;
    const dy = other.y - from.y;
    const dist = Math.hypot(dx, dy) || 1;
    const cos = (dx * dir.x + dy * dir.y) / dist;
    if (cos < minCos) continue;
    ranked.push({ id: other.id, dist, score: dist * (1 + 2 * (1 - cos)) });
  }
  ranked.sort((p, q) => p.score - q.score || p.dist - q.dist || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  return ranked.map((entry) => entry.id);
}

/**
 * The best candidate in a direction, or null.
 * @param {{x: number, y: number}} from
 * @param {Array<{id: string, x: number, y: number}>} candidates
 * @param {{x: number, y: number}} dir
 * @param {number} [minCos]
 * @returns {string|null}
 */
export function pickNeighbour(from, candidates, dir, minCos = ARROW_MIN_COS) {
  return rankInDirection(from, candidates, dir, minCos)[0] ?? null;
}

/**
 * Arrow-key state for one map.
 * @param {object} options
 * @param {{byId: Map<string, {id: string, x: number, y: number}>, neighbours: Map<string, Set<string>>}} options.index
 * @param {(fromId: string, otherId: string) => boolean} options.usable whether the path from
 *   `fromId` to `otherId` is drawn and both ends can take focus right now
 * @param {number} [options.minCos]
 */
export function createArrowNav({ index, usable, minCos = ARROW_MIN_COS }) {
  /** We arrived at `at` from `from` by `key`, taking the neighbour of rank `rank`. */
  let trail = null;
  /** We went back to `at`: the next `key` press there takes rank `rank`. */
  let back = null;

  /** @returns {string[]} the usable neighbours of `id` that lie in the direction of `key`, best first */
  function ranked(id, key) {
    const from = index.byId.get(id);
    const dir = ARROW_KEYS[key];
    if (!from || !dir) return [];
    const near = [];
    for (const otherId of index.neighbours.get(id) || []) {
      const other = index.byId.get(otherId);
      if (other && usable(id, otherId)) near.push(other);
    }
    return rankInDirection(from, near, dir, minCos);
  }

  return {
    ranked,
    /**
     * Handle an arrow key at `id`.
     * @param {string} id the place that has focus
     * @param {string} key "ArrowRight" | "ArrowLeft" | "ArrowDown" | "ArrowUp"
     * @returns {string|null} the place to move to, or null when no path leads that way
     */
    press(id, key) {
      if (!ARROW_KEYS[key]) return null;
      if (trail && trail.at === id && OPPOSITE[trail.key] === key && usable(id, trail.from)) {
        const origin = trail;
        trail = null;
        back = { at: origin.from, key: origin.key, rank: origin.rank + 1 };
        return origin.from;
      }
      const list = ranked(id, key);
      if (!list.length) return null;
      const rank = back && back.at === id && back.key === key ? back.rank % list.length : 0;
      back = null;
      trail = { from: id, key, rank, at: list[rank] };
      return list[rank];
    },
    /** Call whenever focus lands on `id`: a move the arrows did not make ends the back-and-forth. */
    observe(id) {
      if (trail && trail.at !== id) trail = null;
      if (back && back.at !== id) back = null;
    },
    forget() {
      trail = null;
      back = null;
    },
  };
}
