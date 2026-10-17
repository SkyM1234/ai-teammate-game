import type { Level, Position } from './types.ts';

export function validateLevel(value: unknown): Level {
  if (!value || typeof value !== 'object') throw new Error('关卡必须是对象');
  const level = value as Level;
  if (!Number.isInteger(level.width) || !Number.isInteger(level.height) || level.width < 3 || level.height < 3) throw new Error('地图尺寸非法');
  if (!Array.isArray(level.tiles) || level.tiles.length !== level.height || level.tiles.some(row => typeof row !== 'string' || row.length !== level.width || /[^#.DEX]/.test(row))) throw new Error('地图行长度或字符非法');
  if (!Array.isArray(level.entities) || !level.rules || typeof level.id !== 'string' || !level.id.trim() || typeof level.name !== 'string' || !level.name.trim() || !Number.isInteger(level.version) || level.version < 1 || !Array.isArray(level.rooms)) throw new Error('关卡字段不完整');
  for (const name of ['oxygen', 'oxygenMax', 'oxygenRate', 'repairedOxygenRate', 'battery', 'batteryMax', 'batteryRefill', 'oxygenRefill', 'inventorySlots', 'sensorRadius', 'radarRadius', 'leakCost', 'moveLimit', 'toolLimit', 'requestLimit', 'actionTULimit'] as const) {
    if (!Number.isInteger(level.rules[name]) || level.rules[name] < 0) throw new Error(`规则 ${name} 非法`);
  }
  for (const [name, amount] of Object.entries(level.rules)) if (name !== 'actionCosts' && (!Number.isInteger(amount) || amount < 0)) throw new Error(`规则 ${name} 非法`);
  for (const name of ['move', 'carry_move', 'scan', 'open', 'collect', 'drop_item', 'use_battery', 'use_oxygen', 'repair_human', 'repair_airlock', 'clear', 'pickup_human', 'drop_human', 'circuit', 'extract'] as const) {
    const cost = level.rules.actionCosts?.[name];
    if (!cost || !Number.isInteger(cost.tu) || cost.tu < 0 || !Number.isInteger(cost.battery) || cost.battery < 0) throw new Error(`动作消耗 ${name} 非法`);
  }
  for (const name of ['repair_human', 'repair_airlock'] as const) {
    const amount = level.rules.actionCosts[name].materials;
    if (!Number.isInteger(amount) || amount < 0) throw new Error(`维修材料消耗 ${name} 非法`);
  }
  if (level.rules.oxygen <= 0 || level.rules.battery <= 0 || level.rules.oxygen > level.rules.oxygenMax || level.rules.battery > level.rules.batteryMax) throw new Error('初始资源非法');
  const inside = (p: Position): boolean => !!p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < level.width && p.y >= 0 && p.y < level.height && level.tiles[p.y][p.x] !== '#';
  for (const p of [level.humanStart, level.robotStart, level.exit]) if (!inside(p)) throw new Error('起点或出口非法');
  for (const room of level.rooms) {
    const bounds = room?.bounds;
    if (!room || typeof room.name !== 'string' || !room.name || !bounds ||
      ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isInteger) ||
      bounds.minX < 0 || bounds.minY < 0 || bounds.maxX >= level.width || bounds.maxY >= level.height ||
      bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) throw new Error('房间范围非法');
  }
  const ids = new Set<string>();
  for (const entity of level.entities) {
    if (!inside(entity.position) || ids.has(entity.id) || !['supply', 'cabinet', 'door', 'hazard', 'obstacle', 'airlock', 'switch'].includes(entity.type)) throw new Error('实体位置、类型或 ID 非法');
    if (entity.type === 'supply' && !['repair', 'battery', 'oxygen'].includes(entity.itemType ?? '')) throw new Error('补给类型非法');
    ids.add(entity.id);
  }
  for (const entity of level.entities) if (entity.containerId && !level.entities.some(container => container.id === entity.containerId && container.type === 'cabinet')) throw new Error('物品容器引用非法');
  if (level.verification !== undefined && (!level.verification || !Array.isArray(level.verification.actions))) throw new Error('验证路线必须包含 actions 数组');
  const alternatives = level.verification?.alternatives;
  if (alternatives !== undefined && (!alternatives || typeof alternatives !== 'object' || Array.isArray(alternatives) || Object.entries(alternatives).some(([id, actions]) => !id.trim() || id === 'main' || !Array.isArray(actions)))) throw new Error('备用验证路线必须是名称到动作数组的映射，且不能使用 main');
  return structuredClone(level);
}
