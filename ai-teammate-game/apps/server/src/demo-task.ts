import { defaultConstraints } from '../../../packages/game-core/src/engine.ts';
import type { Constraints, Level, Position } from '../../../packages/game-core/src/types.ts';

export type DemoGoal = { kind: 'goto' | 'scan' | 'collect' | 'repair' | 'pickup' | 'extract' | 'circuit' | 'custom'; position?: Position; targetId?: string; itemType?: string; returnHome?: boolean; on?: boolean };
export interface DemoCommand {
  goal: DemoGoal; constraints: Constraints; supported: boolean;
}
export const demoHelp = '规则演示只支持简单目标，如“前往 (4,8)”“修补我的供氧管”“去设备间找电池并回来”“开启辅助电路”。否定、条件和多步骤指令请切换真实模型，或拆成明确的简单指令。';

// A finite local grammar, deliberately independent of live model instructions.
export function parseDemoCommand(text: string, level: Level, home: Position, selected?: Position): DemoCommand {
  const command: DemoCommand = { goal: { kind: 'custom' }, constraints: defaultConstraints(), supported: false };
  const input = text.trim().replace(/[。！!]+$/, '').replace(/^请/, '');
  // Decline unsupported language instead of extracting an affirmative keyword from it.
  if (/不|别|禁止|不得|除非|如果|否则|然后|之后|先|再|并且|接着/.test(input)) return command;
  let goal: DemoGoal | null = null;
  if (/^(抱起|搬起)(我|玩家)$/.test(input)) goal = { kind: 'pickup' };
  else if (/^(修补|维修|修复)(我的|玩家的)?(供氧管|氧气管)$/.test(input)) {
    goal = { kind: 'repair', targetId: 'human' }; command.constraints.allowedRepairs.push('human');
  } else if (/^(维修|修复)(气闸|气闸控制器|控制器)$/.test(input)) {
    goal = { kind: 'repair', targetId: 'airlock' }; command.constraints.allowedRepairs.push('airlock');
  } else if (/^(去设备间)?(找|寻找|拿|取)(备用)?电池(并(回来|返回))?$/.test(input)) goal = { kind: 'collect', itemType: 'battery', returnHome: /并(回来|返回)$/.test(input) };
  else if (/^(去维修区)?(找|寻找|拿|取)(维修材料|材料)(并(回来|返回))?$/.test(input)) goal = { kind: 'collect', itemType: 'repair', returnHome: /并(回来|返回)$/.test(input) };
  else if (/^((关闭|切断|断开)(辅助)?电路|断电)$/.test(input)) goal = { kind: 'circuit', on: false };
  else if (/^((开启|打开|接通)(辅助)?电路|通电)$/.test(input)) {
    goal = { kind: 'circuit', on: true };
  } else if (/^(撤离|启动气闸)$/.test(input)) goal = { kind: 'extract' };
  else if (/^(回来|返回|回到我|回到我身边)$/.test(input)) goal = { kind: 'goto', position: { ...home } };
  else {
    const coordinate = input.match(/^(前往|去|移动到)\s*[(（]?\s*(\d{1,2})\s*[,，]\s*(\d{1,2})\s*[)）]?$/);
    const room = level.rooms.find(room => input === `去${room.name}` || input === `前往${room.name}`);
    if (coordinate) goal = { kind: 'goto', position: { x: Number(coordinate[2]), y: Number(coordinate[3]) } };
    else if (room) goal = { kind: 'goto', position: { ...room.position } };
    else if (selected && /^(过去|检查标记|去那里)$/.test(input)) goal = { kind: 'goto', position: { ...selected } };
  }
  if (goal) { command.goal = goal; command.supported = true; }
  return command;
}
