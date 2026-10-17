import { fileURLToPath } from 'node:url';
import { loadLevels } from '../apps/server/src/levels.ts';
import { verifyLevelRoute } from '../packages/game-core/src/verify-level.ts';

const levels = await loadLevels(fileURLToPath(new URL('../content/levels/', import.meta.url)));
for (const level of levels) {
  try {
    const engine = verifyLevelRoute(level);
    console.log(`${level.id} · ${level.width}×${level.height} · ${engine ? `救援路线通过，${engine.state.elapsedTU} TU，氧气 ${engine.state.human.oxygen}，电量 ${engine.state.robot.battery}` : '格式通过；未配置 verification，尚未验证可完成救援'}`);
  } catch (error) {
    console.error(`${level.id}：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
  }
}
