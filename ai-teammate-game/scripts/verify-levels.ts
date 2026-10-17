import { fileURLToPath } from 'node:url';
import { loadLevels } from '../apps/server/src/levels.ts';
import { levelRoutes, verifyLevelRoute } from '../packages/game-core/src/verify-level.ts';

const levels = await loadLevels(fileURLToPath(new URL('../content/levels/', import.meta.url)));
for (const level of levels) {
  try {
    const routes = Object.keys(levelRoutes(level));
    if (!routes.length) console.log(`${level.id} · ${level.width}×${level.height} · 格式通过；未配置 verification，尚未验证可完成救援`);
    for (const id of routes) {
      try {
        const engine = verifyLevelRoute(level, id)!;
        console.log(`${level.id}/${id} · ${level.width}×${level.height} · 救援路线通过，${engine.state.elapsedTU} TU，氧气 ${engine.state.human.oxygen}，电量 ${engine.state.robot.battery}`);
      } catch (error) { throw new Error(`${id}：${error instanceof Error ? error.message : String(error)}`); }
    }
  } catch (error) {
    console.error(`${level.id}：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
  }
}
