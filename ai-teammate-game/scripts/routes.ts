import { verifyLevelRoute } from '../packages/game-core/src/verify-level.ts';
import type { Level } from '../packages/game-core/src/types.ts';

/** Compatibility for the original upper/lower regression tests; routes live in map JSON. */
export function runRescueRoute(level: Level, variant: 'upper' | 'lower') {
  const engine = verifyLevelRoute(level, variant === 'upper' ? 'main' : 'lower');
  if (!engine) throw new Error(`${level.id} 未配置通关路线`);
  return engine;
}
