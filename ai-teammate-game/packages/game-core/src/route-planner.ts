import { positionKey, samePosition } from './types.ts';
import type { Knowledge, Level, Position } from './types.ts';

type Metric = 'steps' | 'battery' | 'hazards';
interface SearchNode { position: Position; steps: number; battery: number; hazards: number; previous: SearchNode | null }

// These bounds limit the preview work and UI size, rather than defining route categories.
const maxRoutes = 4;
const maxDetourSearches = 32;

export function findKnownRoutes(level: Level, knowledge: Knowledge, start: Position, target: Position, circuitOn: boolean, carried: boolean, exitBlocked: boolean): Position[][] {
  const blocked = new Set<string>();
  const hazards = new Set<string>();
  for (const entity of Object.values(knowledge.entities)) {
    const key = positionKey(entity.position);
    if (['cabinet', 'airlock', 'switch'].includes(entity.type) || entity.type === 'door' && entity.state !== 'opened' || entity.type === 'obstacle' && entity.state !== 'cleared') blocked.add(key);
    if (circuitOn && entity.type === 'hazard') hazards.add(key);
  }
  if (exitBlocked) blocked.add(positionKey(level.exit));
  const passable = (p: Position) => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < level.width && p.y < level.height && level.tiles[p.y][p.x] !== '#' && !blocked.has(positionKey(p));
  if (!passable(target)) return [];
  if (samePosition(start, target)) return [[]];
  const neighbors = (p: Position) => [{ x: p.x, y: p.y - 1 }, { x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }].filter(passable);
  const base = level.rules.actionCosts[carried ? 'carry_move' : 'move'];
  const compare = (a: SearchNode, b: SearchNode, metric: Metric) => a[metric] - b[metric] || a.steps - b.steps || a.battery - b.battery || a.hazards - b.hazards;
  const search = (metric: Metric, excluded = new Set<string>()): Position[] | null => {
    const first: SearchNode = { position: start, steps: 0, battery: 0, hazards: 0, previous: null };
    const frontier = [first];
    const best = new Map<string, SearchNode>([[positionKey(start), first]]);
    while (frontier.length) {
      frontier.sort((a, b) => compare(a, b, metric));
      const current = frontier.shift()!;
      if (best.get(positionKey(current.position)) !== current) continue;
      if (samePosition(current.position, target)) {
        const path: Position[] = [];
        for (let node = current; node.previous; node = node.previous) path.push(node.position);
        return path.reverse();
      }
      for (const position of neighbors(current.position)) {
        const key = positionKey(position);
        if (excluded.has(key)) continue;
        const hazard = hazards.has(key) ? 1 : 0;
        const next: SearchNode = { position, steps: current.steps + 1, battery: current.battery + base.battery + hazard * level.rules.leakCost, hazards: current.hazards + hazard, previous: current };
        const old = best.get(key);
        if (old && compare(next, old, metric) >= 0) continue;
        best.set(key, next); frontier.push(next);
      }
    }
    return null;
  };

  const routes: Position[][] = [];
  const signatures = new Set<string>();
  const add = (path: Position[] | null) => {
    if (!path) return;
    const signature = path.map(positionKey).join(';');
    if (!signatures.has(signature)) { signatures.add(signature); routes.push(path); }
  };
  // Authorization is a property of a route, not a filter on which alternatives exist.
  add(search('hazards')); add(search('battery')); add(search('steps'));
  if (!routes.length) return [];

  // Probe one cell per corridor (degree-two chain), not every permutation across open rooms.
  const corridorCells = (path: Position[]) => {
    const cells: string[] = [];
    let inCorridor = false;
    for (const position of path) {
      const corridor = !samePosition(position, target) && neighbors(position).length === 2;
      if (corridor && !inCorridor) cells.push(positionKey(position));
      inCorridor = corridor;
    }
    return cells;
  };
  const probes: Set<string>[] = [];
  const probed = new Set<string>();
  const enqueue = (path: Position[], excluded = new Set<string>()) => {
    for (const key of corridorCells(path)) {
      if (probes.length >= maxDetourSearches) return;
      const next = new Set([...excluded, key]);
      const signature = [...next].sort().join(';');
      if (!probed.has(signature)) { probed.add(signature); probes.push(next); }
    }
  };
  for (const path of routes) enqueue(path);
  const shortest = Math.min(...routes.map(path => path.length));
  const alternatives: Position[][] = [];
  for (let index = 0; index < probes.length && index < maxDetourSearches; index++) {
    const path = search('steps', probes[index]);
    if (path && path.length <= Math.floor(shortest * 1.5)) {
      alternatives.push(path);
      enqueue(path, probes[index]);
    }
  }
  alternatives.sort((a, b) => a.length - b.length);
  for (const path of alternatives) {
    if (routes.length >= maxRoutes) break;
    const keys = new Set(path.map(positionKey));
    // Suppress tiny detours; preserve alternatives that traverse substantially different cells.
    if (routes.every(other => other.filter(p => keys.has(positionKey(p))).length / Math.min(path.length, other.length) <= 0.7)) add(path);
  }
  return routes;
}
