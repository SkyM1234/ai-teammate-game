import { distance, positionKey, samePosition } from './types.ts';
import type { Knowledge, Level, Position } from './types.ts';

export function sensorCells(level: Level, start: Position, radius: number): Position[] {
  const found: Position[] = [start];
  for (const direction of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
    for (let step = 1; step <= radius; step++) {
      const p = { x: start.x + direction.x * step, y: start.y + direction.y * step };
      if (p.x < 0 || p.x >= level.width || p.y < 0 || p.y >= level.height || level.tiles[p.y][p.x] === '#') break;
      found.push(p);
      if (level.entities.some(e => e.type === 'door' && samePosition(e.position, p))) break;
    }
  }
  return found;
}

export function findKnownPath(level: Pick<Level, 'width' | 'height' | 'tiles'>, knowledge: Knowledge, start: Position, target: Position, circuitOn: boolean, authorizedHazardIds: string[] = []): Position[] | null {
  if (!Number.isInteger(target.x) || !Number.isInteger(target.y) || target.x < 0 || target.y < 0 || target.x >= level.width || target.y >= level.height || level.tiles[target.y][target.x] === '#') return null;
  const queue: Position[] = [start];
  const previous = new Map<string, Position | null>([[positionKey(start), null]]);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (samePosition(current, target)) {
      const route: Position[] = [];
      let cursor: Position | null = current;
      while (cursor && !samePosition(cursor, start)) { route.unshift(cursor); cursor = previous.get(positionKey(cursor)) ?? null; }
      return route;
    }
    for (const p of [{ x: current.x, y: current.y - 1 }, { x: current.x + 1, y: current.y }, { x: current.x, y: current.y + 1 }, { x: current.x - 1, y: current.y }]) {
      if (p.x < 0 || p.x >= level.width || p.y < 0 || p.y >= level.height || level.tiles[p.y][p.x] === '#' || previous.has(positionKey(p))) continue;
      const blocked = Object.values(knowledge.entities).some(e => samePosition(e.position, p) && (
        e.type === 'cabinet' || (e.type === 'door' && e.state !== 'opened') || (e.type === 'obstacle' && e.state !== 'cleared') ||
        (e.type === 'hazard' && circuitOn && !authorizedHazardIds.includes(e.id))
      ));
      if (blocked) continue;
      previous.set(positionKey(p), current); queue.push(p);
    }
  }
  return null;
}

export function canObserve(level: Level, knowledge: Knowledge, start: Position, target: Position): boolean {
  if (distance(start, target) > level.rules.sensorRadius) return false;
  if (level.rules.sensorRadius === 1) return true;
  return sensorCells(level, start, level.rules.sensorRadius).some(p => samePosition(p, target)) && !Object.values(knowledge.entities).some(e => e.type === 'door' && e.state !== 'opened' && !samePosition(e.position, target) && distance(start, e.position) < distance(start, target) && (e.position.x === start.x && start.x === target.x || e.position.y === start.y && start.y === target.y));
}
