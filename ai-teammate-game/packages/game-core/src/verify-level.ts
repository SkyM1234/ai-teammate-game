import { defaultConstraints, GameEngine } from './engine.ts';
import type { Level } from './types.ts';

/** A data-defined solution verifies resource budgets using the real rule engine. */
export function verifyLevelRoute(level: Level): GameEngine | null {
  if (!level.verification) return null;
  const engine = new GameEngine(level);
  const constraints = defaultConstraints();
  constraints.authorizedHazardIds = level.entities.filter(entity => entity.type === 'hazard').map(entity => entity.id);
  for (const [index, action] of level.verification.actions.entries()) {
    const result = engine.perform(action, `verify:${index}`, constraints);
    if (!result.accepted || engine.state.phase === 'failure') throw new Error(`第 ${index + 1} 步：${result.message}`);
  }
  if (engine.state.phase !== 'success') throw new Error('验证路线未完成救援撤离');
  return engine;
}
