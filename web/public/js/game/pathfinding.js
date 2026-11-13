// Grid pathfinding over the map's walkability flags, in the eight directions the
// protocol knows. Directions use the packet values of OpenMU's Direction enum minus
// one (GameLogic/DirectionExtensions.cs).

import { TERRAIN_SIZE, TerrainFlag } from '../formats.js';

// [dx, dy] for packet direction 0..7: West, SouthWest, South, SouthEast, East, NorthEast, North, NorthWest.
export const DIRECTION_OFFSETS = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const BLOCKING = TerrainFlag.NOMOVE | TerrainFlag.NOGROUND;
const MAX_SEARCHED_CELLS = 4000;
const DIAGONAL_COST = 1.4142;

export function directionBetween(from, to) {
  const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  return DIRECTION_OFFSETS.findIndex(([x, y]) => x === dx && y === dy);
}

export function isWalkableCell(flags, x, y) {
  if (x < 0 || y < 0 || x >= TERRAIN_SIZE || y >= TERRAIN_SIZE) return false;
  return (flags[y * TERRAIN_SIZE + x] & BLOCKING) === 0;
}

// A* from start to goal; returns the cells after start, or [] when there's no way.
export function findPath(flags, start, goal) {
  if (!isWalkableCell(flags, goal.x, goal.y)) return [];
  const key = (x, y) => y * TERRAIN_SIZE + x;
  const heuristic = (x, y) => Math.max(Math.abs(goal.x - x), Math.abs(goal.y - y));
  const open = [{ x: start.x, y: start.y, cost: 0, score: heuristic(start.x, start.y) }];
  const cameFrom = new Map();
  const bestCost = new Map([[key(start.x, start.y), 0]]);
  let searched = 0;
  while (open.length && searched++ < MAX_SEARCHED_CELLS) {
    let bestIndex = 0;
    for (let i = 1; i < open.length; i++) if (open[i].score < open[bestIndex].score) bestIndex = i;
    const current = open.splice(bestIndex, 1)[0];
    if (current.x === goal.x && current.y === goal.y) return rebuildPath(cameFrom, key, current);
    for (const [dx, dy] of DIRECTION_OFFSETS) {
      const x = current.x + dx, y = current.y + dy;
      if (!isWalkableCell(flags, x, y)) continue;
      const cost = current.cost + (dx && dy ? DIAGONAL_COST : 1);
      const k = key(x, y);
      if (cost >= (bestCost.get(k) ?? Infinity)) continue;
      bestCost.set(k, cost);
      cameFrom.set(k, current);
      open.push({ x, y, cost, score: cost + heuristic(x, y) });
    }
  }
  return [];
}

function rebuildPath(cameFrom, key, end) {
  const path = [];
  let node = end;
  while (cameFrom.has(key(node.x, node.y))) {
    path.unshift({ x: node.x, y: node.y });
    node = cameFrom.get(key(node.x, node.y));
  }
  return path;
}
