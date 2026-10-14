import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { runRescueRoute } from './routes.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
const routes = (['upper', 'lower'] as const).map(variant => {
  const engine = runRescueRoute(level, variant);
  if (engine.state.phase !== 'success') throw new Error(`${variant} 未成功撤离`);
  return { variant, elapsedTU: engine.state.elapsedTU, remainingOxygen: engine.state.human.oxygen, remainingBattery: engine.state.robot.battery, actions: engine.state.ledger };
});
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/route-ledgers.json', import.meta.url), JSON.stringify({ levelId: level.id, rules: level.rules, routes }, null, 2) + '\n');
for (const route of routes) console.log(`${route.variant}: 救援成功 · ${route.elapsedTU} TU · 氧气 ${route.remainingOxygen} · 电量 ${route.remainingBattery}`);
