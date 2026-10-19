import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadLevels } from '../apps/server/src/levels.ts';
import { levelRoutes, verifyLevelRoute } from '../packages/game-core/src/verify-level.ts';

const levels = await loadLevels(fileURLToPath(new URL('../content/levels/', import.meta.url)));
const reports = levels.map(level => {
  const ids = Object.keys(levelRoutes(level));
  if (!ids.length) throw new Error(`${level.id} 未配置通关路线`);
  const routes = ids.map(id => {
    try {
      const engine = verifyLevelRoute(level, id)!;
      return { id, elapsedTU: engine.state.elapsedTU, remainingOxygen: engine.state.human.oxygen, remainingBattery: engine.state.robot.battery, actions: engine.state.ledger };
    } catch (error) { throw new Error(`${level.id}/${id}：${error instanceof Error ? error.message : String(error)}`); }
  });
  const interactionCosts = { human: level.human.actionCosts, exit: level.exit.actionCosts, entities: Object.fromEntries(level.entities.filter(entity => entity.actionCosts).map(entity => [entity.id, entity.actionCosts])) };
  return { levelId: level.id, levelVersion: level.version, rules: level.rules, interactionCosts, routes };
});
await mkdir(new URL('../docs/maps/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/maps/route-ledgers.json', import.meta.url), JSON.stringify({ levels: reports }, null, 2) + '\n');
for (const level of reports) for (const route of level.routes) console.log(`${level.levelId}/${route.id}: 救援成功 · ${route.elapsedTU} TU · 氧气 ${route.remainingOxygen} · 电量 ${route.remainingBattery}`);
