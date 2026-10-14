import { GameEngine } from '../packages/game-core/src/engine.ts';
import type { Action, Level, Position } from '../packages/game-core/src/types.ts';

export function runRescueRoute(level: Level, variant: 'upper' | 'lower'): GameEngine {
  const engine = new GameEngine(level);
  const act = (action: Action): void => {
    const outcome = engine.perform(action);
    if (!outcome.accepted || engine.state.phase === 'failure') throw new Error(`${variant}: ${action.kind}: ${outcome.message}`);
  };
  const walk = (target: Position): void => {
    while (engine.state.robot.position.x !== target.x) act({ kind: 'move', target: { x: engine.state.robot.position.x + Math.sign(target.x - engine.state.robot.position.x), y: engine.state.robot.position.y } });
    while (engine.state.robot.position.y !== target.y) act({ kind: 'move', target: { x: engine.state.robot.position.x, y: engine.state.robot.position.y + Math.sign(target.y - engine.state.robot.position.y) } });
  };
  walk({ x: 3, y: 9 }); act({ kind: 'collect', targetId: 's-01' });
  walk({ x: 4, y: 9 }); act({ kind: 'collect', targetId: 's-02' });
  walk({ x: 2, y: 9 }); act({ kind: 'repair', targetId: 'human' });
  walk({ x: 4, y: 9 }); walk({ x: 4, y: 3 });
  act({ kind: 'scan', targetId: 'c-01' });
  walk({ x: 4, y: 2 }); walk({ x: 6, y: 2 });
  act({ kind: 'circuit', targetId: 'sw-01', on: true });
  walk({ x: 5, y: 2 });
  act({ kind: 'open', targetId: 'c-01' }); act({ kind: 'collect', targetId: 's-04' });
  act({ kind: 'use_item', itemId: 's-04', targetId: 'robot' });
  if (variant === 'upper') {
    walk({ x: 6, y: 2 }); walk({ x: 6, y: 3 }); act({ kind: 'open', targetId: 'd-01' });
    walk({ x: 6, y: 2 }); act({ kind: 'circuit', targetId: 'sw-01', on: false }); walk({ x: 6, y: 3 }); walk({ x: 7, y: 3 });
    walk({ x: 9, y: 3 }); walk({ x: 9, y: 2 }); act({ kind: 'repair', targetId: 'a-01' });
    walk({ x: 9, y: 3 }); walk({ x: 6, y: 3 }); walk({ x: 6, y: 4 }); walk({ x: 4, y: 4 }); walk({ x: 4, y: 9 }); walk({ x: 1, y: 9 });
    act({ kind: 'pickup_human' });
    walk({ x: 4, y: 9 }); walk({ x: 4, y: 4 }); walk({ x: 6, y: 4 }); walk({ x: 6, y: 3 }); walk({ x: 10, y: 3 }); walk({ x: 10, y: 1 });
  } else {
    walk({ x: 6, y: 2 }); act({ kind: 'circuit', targetId: 'sw-01', on: false }); walk({ x: 4, y: 2 }); walk({ x: 4, y: 9 }); walk({ x: 6, y: 9 }); walk({ x: 6, y: 10 });
    act({ kind: 'clear', targetId: 'o-01' }); walk({ x: 8, y: 10 }); walk({ x: 8, y: 2 }); walk({ x: 9, y: 2 }); act({ kind: 'repair', targetId: 'a-01' });
    walk({ x: 8, y: 2 }); walk({ x: 8, y: 10 }); walk({ x: 1, y: 10 }); walk({ x: 1, y: 9 }); act({ kind: 'pickup_human' });
    walk({ x: 1, y: 10 }); walk({ x: 8, y: 10 }); walk({ x: 8, y: 1 }); walk({ x: 10, y: 1 });
  }
  act({ kind: 'extract' });
  return engine;
}
