import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateLevel } from '../../../packages/game-core/src/level.ts';
import type { Level } from '../../../packages/game-core/src/types.ts';

export type LevelSummary = Pick<Level, 'id' | 'version' | 'name' | 'width' | 'height'>;

/** Filenames are discovered locally; API requests select IDs, never filesystem paths. */
export async function loadLevels(directory: string): Promise<Level[]> {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
  const levels: Level[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    try {
      const level = validateLevel(JSON.parse(await readFile(join(directory, file), 'utf8')));
      if (ids.has(level.id)) throw new Error(`地图 ID 重复：${level.id}`);
      ids.add(level.id); levels.push(level);
    } catch (error) { throw new Error(`${file}：${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!levels.length) throw new Error('关卡目录中没有地图 JSON');
  return levels;
}
