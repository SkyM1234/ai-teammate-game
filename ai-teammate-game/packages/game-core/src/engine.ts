import { canObserve, findKnownPath, sensorCells } from './navigation.ts';
import { distance, emptyDelta, positionKey, samePosition } from './types.ts';
import type { Action, ActionCost, ActionOutcome, Constraints, Cost, Entity, GameState, Knowledge, Level, ObservationDelta, ObservedEntity, PlayerView, Position, RadarEcho, RepairCost, ReplayView } from './types.ts';

export const defaultConstraints = (): Constraints => ({ reserveReturnBattery: false, reserveMargin: 5, authorizedHazardIds: [], stopOnHazard: false, allowedRepairs: [] });
const consumedSupplyDetails = '该物资已消耗，不能再次拾取或使用。';

function comparable(observation: ObservedEntity): string {
  const { observedAt: _time, source: _source, ...fact } = observation;
  return JSON.stringify(fact);
}

export function diffKnowledge(before: Knowledge, after: Knowledge): ObservationDelta {
  const delta = emptyDelta();
  for (const [id, observation] of Object.entries(after.entities)) {
    const old = before.entities[id];
    if (!old) delta.newDiscoveries.push(structuredClone(observation));
    else if (comparable(old) !== comparable(observation)) {
      delta.stateChanges.push(structuredClone(observation));
      if (old.state !== observation.state || !samePosition(old.position, observation.position)) delta.invalidatedFacts.push(`${id}:${old.state}@${positionKey(old.position)}`);
    } else delta.knownRefs.push(id);
  }
  return delta;
}

export class GameEngine {
  readonly level: Level;
  state: GameState;

  constructor(level: Level) {
    this.level = structuredClone(level);
    this.state = {
      schemaVersion: 1, levelId: level.id, levelVersion: level.version, rulesVersion: 5,
      stateRevision: 0, elapsedTU: 0, phase: 'awaiting_command',
      circuits: Object.fromEntries(level.entities.filter(e => e.type === 'switch').map(e => [e.id, false])),
      human: { position: { ...level.humanStart }, oxygen: level.rules.oxygen, oxygenRate: level.rules.oxygenRate, carried: false },
      robot: { position: { ...level.robotStart }, battery: level.rules.battery, inventory: [] },
      entities: level.entities.map(e => ({ ...structuredClone(e), opened: false, repaired: false, removed: false, taken: false })),
      knowledge: { entities: {}, scannedIds: [], markers: [] }, radarHistory: [], markers: [], markerHistory: [], ledger: [], processedActions: {}, failureReason: null,
    };
    this.observe();
    this.updateRadar();
  }

  get terminal(): boolean { return this.state.phase === 'success' || this.state.phase === 'failure'; }

  get exitStatus(): PlayerView['exitStatus'] { return this.state.entities.some(e => e.type === 'airlock' && e.repaired) ? 'safe' : 'leaking'; }

  private getEntity(id: string): Entity | undefined { return this.state.entities.find(e => e.id === id); }

  isPowered(id: string): boolean {
    return this.state.entities.some(e => e.type === 'switch' && e.controls?.includes(id) && this.state.circuits[e.id]);
  }

  private reachable(p: Position): boolean {
    return distance(this.state.robot.position, p) <= 1 && this.level.tiles[p.y]?.[p.x] !== '#';
  }

  private interactionInfo(entity: ObservedEntity) {
    const currentDistance = distance(this.state.robot.position, entity.position);
    const unavailable = entity.state === 'inventory' || entity.state === 'cleared';
    const inSensorRange = !unavailable && canObserve(this.level, this.state.knowledge, this.state.robot.position, entity.position);
    const reason = unavailable ? (entity.state === 'inventory' ? '对象已在背包，位置是历史记录，无需再次扫描。' : '对象已消耗或清除，无法再次扫描。')
      : !this.reachable(entity.position) ? '需上下左右相邻或同格，曼哈顿距离≤1；斜对角不算相邻。'
      : !inSensorRange ? '目标不在当前感知范围或视线受阻。' : null;
    return { distance: currentDistance, inSensorRange, canScan: reason === null, reason };
  }

  private approachPositions(entity: ObservedEntity) {
    if (entity.state === 'inventory' || entity.state === 'cleared') return [];
    const { x, y } = entity.position;
    return [{ x, y }, { x, y: y - 1 }, { x: x + 1, y }, { x, y: y + 1 }, { x: x - 1, y }].flatMap(position => {
      const path = this.knownPath(position);
      return path && canObserve(this.level, this.state.knowledge, position, entity.position) ? [{ position, steps: path.length }] : [];
    }).sort((a, b) => a.steps - b.steps);
  }

  private visible(entity: Entity): boolean {
    if (entity.taken || entity.removed) return false;
    if (entity.containerId && !this.getEntity(entity.containerId)?.opened) return false;
    return canObserve(this.level, this.state.knowledge, this.state.robot.position, entity.position);
  }

  private observation(entity: Entity): ObservedEntity {
    const scanned = this.state.knowledge.scannedIds.includes(entity.id);
    let state = 'available';
    if (entity.taken) state = 'inventory';
    else if (entity.removed) state = 'cleared';
    else if (entity.type === 'door' || entity.type === 'cabinet') state = entity.opened ? 'opened' : 'closed';
    else if (entity.type === 'hazard') state = this.isPowered(entity.id) ? 'active' : 'inactive';
    else if (entity.type === 'switch') state = this.state.circuits[entity.id] ? 'on' : 'off';
    else if (entity.type === 'airlock') state = entity.repaired ? 'repaired' : 'damaged';
    const result: ObservedEntity = {
      id: entity.id, type: entity.type, name: entity.name, position: { ...entity.position }, state,
      scanned, observedAt: this.state.elapsedTU, source: scanned ? 'scan' : 'sensor',
    };
    if (entity.itemType) result.itemType = entity.itemType;
    if (entity.powerRequired) result.powered = this.isPowered(entity.id);
    if (entity.type === 'hazard') result.leakCost = entity.leakCost;
    const costs = this.level.entities.find(definition => definition.id === entity.id)?.actionCosts;
    if (costs) result.actionCosts = structuredClone(costs);
    if (entity.type === 'supply' && entity.removed) result.details = consumedSupplyDetails;
    else if (scanned) {
      if (entity.powerRequired) result.powerRequired = true;
      if (entity.powerRequired) result.details = '需要对应开关供电；检查开关才能确认控制关系，打开后断电不会自动关闭。';
      else if (entity.type === 'switch') {
        result.controlledDevices = entity.controls!.map(id => {
          const device = this.getEntity(id)!;
          return { id: device.id, name: device.name, type: device.type };
        });
        result.details = `控制设备：${result.controlledDevices.map(device => `${device.name}（${device.id}）`).join('、') || '无'}。通电可能激活所控线路的漏电。`;
      }
      else if (entity.type === 'airlock') result.details = entity.repaired ? '已修复，出口漏气已停止；将玩家搬运至撤离出口后启动撤离。' : `控制器损坏导致出口喷气，出口格不可进入；需要 ${this.repairCost(entity.id)!.materials} 份维修材料修复。`;
      else if (entity.type === 'hazard') result.details = `由对应开关供电，通电时每次进入额外消耗 ${entity.leakCost} 电量。`;
      else if (entity.itemType === 'battery') result.details = `可恢复 ${this.level.rules.batteryRefill} 电量。`;
      else if (entity.itemType === 'oxygen') result.details = `可恢复 ${this.level.rules.oxygenRefill} 氧气。`;
      else if (entity.type === 'obstacle') result.details = `清理需要 ${costs!.clear!.tu} TU、${costs!.clear!.battery} 电量。`;
      else result.details = '状态已确认。';
      if (['cabinet', 'airlock', 'switch'].includes(entity.type)) result.details += ' 本设施所在格不可进入或穿越，需在可达的相邻格交互；开启、修复或通断电均不会解除阻挡。';
    }
    return result;
  }

  observe(): void {
    for (const entity of this.state.entities) {
      if (this.visible(entity) || this.state.robot.inventory.includes(entity.id) || entity.removed && !!this.state.knowledge.entities[entity.id]) {
        this.state.knowledge.entities[entity.id] = this.observation(entity);
      }
    }
    // A checked switch establishes the state of its already identified devices,
    // including devices outside sensor range. It does not discover their positions.
    for (const control of Object.values(this.state.knowledge.entities)) {
      if (control.type !== 'switch' || !this.visible(this.getEntity(control.id)!)) continue;
      for (const device of control.controlledDevices ?? []) {
        const known = this.state.knowledge.entities[device.id];
        if (!known) continue;
        const powered = control.state === 'on';
        if (known.type === 'hazard') known.state = powered ? 'active' : 'inactive';
        if (known.powered !== undefined) known.powered = powered;
        known.observedAt = this.state.elapsedTU;
      }
    }
  }

  private updateRadar(): void {
    const echoes = new Map<string, RadarEcho>();
    for (const entity of this.state.entities) {
      if (entity.taken || entity.removed || entity.containerId && !this.getEntity(entity.containerId)?.opened || distance(this.state.robot.position, entity.position) > this.level.rules.radarRadius) continue;
      const key = positionKey(entity.position);
      const current = echoes.get(key);
      echoes.set(key, {
        id: `echo-${key}`, position: { ...entity.position },
        strength: entity.reflection >= 2 || !!current ? 'strong' : 'weak',
        shape: current?.shape === 'flickering' || entity.type === 'hazard' && this.isPowered(entity.id) ? 'flickering' : 'steady',
        observedAt: this.state.elapsedTU, historical: false,
      });
    }
    const historical = this.state.radarHistory.filter(e => distance(this.state.robot.position, e.position) > this.level.rules.radarRadius).map(e => ({ ...e, historical: true }));
    this.state.radarHistory = [...historical, ...echoes.values()];
  }

  knownPath(target: Position, constraints: Constraints = defaultConstraints()): Position[] | null {
    return findKnownPath(this.level, this.state.knowledge, this.state.robot.position, target, constraints.authorizedHazardIds, this.exitStatus === 'leaking');
  }

  perform(action: Action, actionId: string = crypto.randomUUID(), constraints: Constraints = defaultConstraints()): ActionOutcome {
    return this.performAction(action, actionId, constraints);
  }

  repairCost(targetId: string): RepairCost | undefined {
    return targetId === 'human' ? this.level.human.actionCosts.repair : this.level.entities.find(entity => entity.id === targetId)?.actionCosts?.repair;
  }

  configuredActionCost(action: Action): ActionCost | undefined {
    switch (action.kind) {
      case 'move': return this.level.rules.actionCosts[this.state.human.carried ? 'carry_move' : 'move'];
      case 'scan': return this.level.rules.actionCosts.scan;
      case 'pickup_human': case 'drop_human': return this.level.human.actionCosts[action.kind];
      case 'extract': return this.level.exit.actionCosts.extract;
      case 'repair': return this.repairCost(action.targetId);
      case 'use_item': case 'drop_item': return this.level.entities.find(entity => entity.id === action.itemId)?.actionCosts?.[action.kind];
      case 'circuit': return this.level.entities.find(entity => entity.id === action.targetId)?.actionCosts?.[action.on ? 'circuit_on' : 'circuit_off'];
      default: return this.level.entities.find(entity => entity.id === action.targetId)?.actionCosts?.[action.kind];
    }
  }

  actionCost(action: Action): Cost {
    const base = this.configuredActionCost(action);
    if (!base) throw new Error(`动作消耗未配置：${action.kind}`);
    const leakCost = action.kind === 'move' ? this.state.entities.filter(e => e.type === 'hazard' && this.isPowered(e.id) && samePosition(e.position, action.target)).reduce((total, entity) => total + entity.leakCost!, 0) : 0;
    return { tu: base.tu, battery: base.battery + leakCost, oxygen: this.state.human.oxygenRate * base.tu };
  }

  replayEntry(entry: GameState['ledger'][number]): ActionOutcome {
    return this.performAction(entry.action, entry.actionId, entry.constraints);
  }

  replayAt(step: number): ReplayView {
    const entries = this.state.ledger;
    if (!Number.isSafeInteger(step) || step < 0 || step > entries.length) throw new Error('回溯步数超出行动账本范围');
    const replay = new GameEngine(this.level);
    const history = this.state.markerHistory;
    let markerIndex = 0;
    for (let index = 0; index <= step; index++) {
      if (index > 0) {
        const entry = entries[index - 1];
        const outcome = replay.replayEntry(entry);
        if (!outcome.accepted || replay.state.elapsedTU !== entry.elapsedTU || replay.state.human.oxygen !== entry.oxygen || replay.state.robot.battery !== entry.battery || !samePosition(replay.state.robot.position, entry.position)) throw new Error(`行动 ${entry.sequence} 无法按当前规则重现`);
        replay.state.phase = entry.phase;
      }
      while (markerIndex < history.length && history[markerIndex].afterSequence <= index) {
        const event = history[markerIndex++];
        replay.state.markers = replay.state.markers.filter(marker => marker.id !== event.marker.id);
        replay.state.knowledge.markers = replay.state.knowledge.markers.filter(marker => marker.id !== event.marker.id);
        if (!event.removed) {
          replay.state.markers.push(structuredClone(event.marker));
          if (event.marker.shared) replay.state.knowledge.markers.push(structuredClone(event.marker));
        }
        replay.state.stateRevision++;
      }
    }
    return { step, total: entries.length, entries: structuredClone(entries), state: replay.playerView() };
  }

  private performAction(action: Action, actionId: string, constraints: Constraints): ActionOutcome {
    const cached = this.state.processedActions[actionId];
    if (cached) return structuredClone(cached);
    const before = structuredClone(this.state.knowledge);
    const reject = (code: string, message: string): ActionOutcome => {
      const result: ActionOutcome = { accepted: false, code, message, cost: { tu: 0, battery: 0, oxygen: 0 }, delta: emptyDelta(), actionId, stateRevision: this.state.stateRevision };
      this.state.processedActions[actionId] = result;
      return structuredClone(result);
    };
    if (this.terminal) return reject('SESSION_FINISHED', '本局已经结束。');
    let message = '';
    let effect: (() => void) | undefined;
    let entity: Entity | undefined;
    if ('targetId' in action && action.targetId !== 'human' && action.targetId !== 'robot') {
      entity = this.getEntity(action.targetId);
      if (!entity || !this.state.knowledge.entities[action.targetId]) return reject('UNKNOWN_TARGET', '目标尚未识别。');
      if (entity.type === 'supply' && this.state.knowledge.entities[entity.id].state === 'cleared') return reject('ITEM_CONSUMED', '该物资已消耗，不能再次扫描、拾取或使用；请选择其他可用物资。');
      if (action.kind === 'collect' && this.state.robot.inventory.includes(entity.id)) return reject('ITEM_IN_INVENTORY', '该物资已在背包中，无需再次拾取；请按物品类型使用或维修。');
      if (!this.reachable(entity.position) || !this.visible(entity)) {
        const known = this.state.knowledge.entities[entity.id];
        const interaction = this.interactionInfo(known);
        const position = this.state.robot.position;
        return reject('OUT_OF_RANGE', `${known.name}的已知位置 (${known.position.x},${known.position.y})，机器人位于 (${position.x},${position.y})，当前距离 ${interaction.distance}，要求曼哈顿距离≤1（上下左右相邻或同格，斜对角不算）。${interaction.reason ?? '目标当前不可见，需靠近并保持视线。'}`);
      }
    }
    switch (action.kind) {
      case 'move': {
        const target = action.target;
        if (!Number.isInteger(target.x) || !Number.isInteger(target.y) || distance(this.state.robot.position, target) !== 1 || this.level.tiles[target.y]?.[target.x] === undefined || this.level.tiles[target.y][target.x] === '#') return reject('INVALID_MOVE', '只能向可通行的相邻格移动。');
        if (samePosition(target, this.level.exit) && this.exitStatus === 'leaking') return reject('EXIT_LEAK_ACTIVE', '出口正在漏气喷射，无法进入；请先修复气闸控制器。');
        const blocker = this.state.entities.find(e => samePosition(e.position, target) && !e.removed && (e.type === 'cabinet' || e.type === 'airlock' || e.type === 'switch' || e.type === 'door' && !e.opened || e.type === 'obstacle'));
        if (blocker) return reject('BLOCKED', '前方无法通行，请检查附近设施。');
        const hazard = this.state.entities.find(e => e.type === 'hazard' && samePosition(e.position, target) && this.isPowered(e.id));
        if (hazard && !constraints.authorizedHazardIds.includes(hazard.id)) return reject('HAZARD_AUTH_REQUIRED', '前方有带电线路，需要断电或明确授权。');
        message = `移动至 (${target.x}, ${target.y})${this.state.human.carried ? ' · 搬运中' : ''}`;
        effect = () => { this.state.robot.position = { x: target.x, y: target.y }; if (this.state.human.carried) this.state.human.position = { x: target.x, y: target.y }; };
        break;
      }
      case 'scan':
        if (!entity) return reject('UNKNOWN_TARGET', '扫描目标非法。');
        message = `检查 ${entity.name}`;
        effect = () => { if (!this.state.knowledge.scannedIds.includes(entity.id)) this.state.knowledge.scannedIds.push(entity.id); };
        break;
      case 'open':
        if (!entity || !['door', 'cabinet'].includes(entity.type) || entity.opened) return reject('PRECONDITION_FAILED', '该目标不能开启，或已经开启。');
        if (entity.powerRequired && !this.isPowered(entity.id)) return reject('POWER_REQUIRED', '需要机器人寻找并检查控制此设备的开关，靠近对应开关通电后再开启设备。');
        message = `开启 ${entity.name}`; effect = () => { entity.opened = true; };
        break;
      case 'collect':
        if (!entity || entity.type !== 'supply' || entity.taken) return reject('PRECONDITION_FAILED', '没有可取得的已知物资。');
        if (this.state.robot.inventory.length >= this.level.rules.inventorySlots) return reject('INVENTORY_FULL', '物品槽已满。');
        message = `取得 ${entity.name}`;
        effect = () => { entity.taken = true; this.state.robot.inventory.push(entity.id); };
        break;
      case 'drop_item': {
        const item = this.getEntity(action.itemId);
        if (!item || !this.state.robot.inventory.includes(item.id)) return reject('UNKNOWN_TARGET', '背包中没有该物品。');
        message = `放下 ${item.name}`;
        effect = () => { this.state.robot.inventory = this.state.robot.inventory.filter(id => id !== item.id); item.taken = false; item.containerId = undefined; item.position = { ...this.state.robot.position }; };
        break;
      }
      case 'use_item': {
        const item = this.getEntity(action.itemId);
        if (item?.type === 'supply' && this.state.knowledge.entities[action.itemId]?.state === 'cleared') return reject('ITEM_CONSUMED', '该物资已消耗，不能再次使用；请选择背包中的可用物资。');
        if (!item || !this.state.robot.inventory.includes(item.id)) return reject('UNKNOWN_TARGET', '背包中没有该物品。');
        if (item.itemType === 'battery' && action.targetId === 'robot') {
          message = '安装备用电池';
          effect = () => { this.state.robot.battery = Math.min(this.level.rules.batteryMax, this.state.robot.battery + this.level.rules.batteryRefill); this.consume(item.id); };
        } else if (item.itemType === 'oxygen' && action.targetId === 'human') {
          if (!this.reachable(this.state.human.position)) return reject('OUT_OF_RANGE', '需要先靠近玩家。');
          message = '为玩家补充氧气';
          effect = () => { this.state.human.oxygen = Math.min(this.level.rules.oxygenMax, this.state.human.oxygen + this.level.rules.oxygenRefill); this.consume(item.id); };
        } else return reject('ITEM_TYPE_MISMATCH', item.itemType === 'repair' ? '维修材料用于 repair，由维修操作自动消耗；不能用 use_item 补充氧气或电量。' : '物品类型与目标不匹配：氧气只能用于 human，电池只能用于 robot。');
        break;
      }
      case 'repair': {
        const target = action.targetId;
        if (target === 'human' && (!this.reachable(this.state.human.position) || this.state.human.oxygenRate === this.level.rules.repairedOxygenRate)) return reject('PRECONDITION_FAILED', '需靠近玩家，且供氧管尚未修补。');
        if (target !== 'human' && (!entity || entity.type !== 'airlock' || entity.repaired)) return reject('PRECONDITION_FAILED', '没有需要修复的已知控制器。');
        const required = this.repairCost(target)!.materials;
        const materials = this.state.robot.inventory.filter(id => this.getEntity(id)?.itemType === 'repair').slice(0, required);
        if (materials.length < required) return reject('MATERIAL_REQUIRED', `需要 ${required} 份维修材料。`);
        message = target === 'human' ? '修补玩家供氧管' : '修复气闸控制器';
        effect = () => { for (const material of materials) this.consume(material); if (target === 'human') this.state.human.oxygenRate = this.level.rules.repairedOxygenRate; else if (entity) entity.repaired = true; };
        break;
      }
      case 'clear':
        if (!entity || entity.type !== 'obstacle' || entity.removed) return reject('PRECONDITION_FAILED', '没有可清理的已知障碍。');
        message = `清理 ${entity.name}`; effect = () => { entity.removed = true; };
        break;
      case 'pickup_human':
        if (this.state.human.carried) return reject('ALREADY_CARRYING', '玩家已在搬运中，无需再次抱起；可继续移动或执行其他所需操作。');
        if (!samePosition(this.state.robot.position, this.state.human.position)) return reject('OUT_OF_RANGE', '需要与玩家位于同一格。');
        message = '抱起玩家，切换负重模式'; effect = () => { this.state.human.carried = true; };
        break;
      case 'drop_human':
        if (!this.state.human.carried || this.state.entities.some(e => e.type === 'hazard' && this.isPowered(e.id) && samePosition(e.position, this.state.robot.position))) return reject('PRECONDITION_FAILED', '只能在安全地面放下玩家。');
        message = '放下玩家'; effect = () => { this.state.human.carried = false; };
        break;
      case 'circuit':
        if (entity?.type !== 'switch') return reject('UNKNOWN_TARGET', '必须指定已识别且可触及的实体电路开关。');
        if (typeof action.on !== 'boolean' || action.on === this.state.circuits[entity.id]) return reject('PRECONDITION_FAILED', '电路已经处于该状态。');
        message = `${action.on ? '开启' : '关闭'}${entity.name}`; effect = () => { this.state.circuits[entity.id] = action.on; };
        break;
      case 'extract':
        if (this.exitStatus === 'leaking') return reject('EXIT_LEAK_ACTIVE', '出口正在漏气喷射，无法撤离；请先修复气闸控制器。');
        if (!this.state.human.carried || !samePosition(this.state.robot.position, this.level.exit) || !this.state.entities.some(e => e.type === 'airlock' && e.repaired)) return reject('PRECONDITION_FAILED', '需要修复气闸，并将玩家搬运到出口。');
        message = '气闸接管救援，撤离成功'; effect = () => { this.state.phase = 'success'; };
        break;
      default: return reject('INVALID_ACTION', '不支持的动作。');
    }
    const cost = this.actionCost(action);
    if (this.state.robot.battery < cost.battery) return reject('BATTERY_REQUIRED', '电量不足以完成该动作。');
    if (constraints.reserveReturnBattery) {
      const start = action.kind === 'move' ? action.target : this.state.robot.position;
      const destination = this.state.human.carried ? this.level.exit : this.state.human.position;
      const knowledge = structuredClone(this.state.knowledge);
      if (action.kind === 'circuit') {
        for (const device of knowledge.entities[action.targetId]?.controlledDevices ?? []) {
          if (knowledge.entities[device.id]?.type === 'hazard') knowledge.entities[device.id].state = action.on ? 'active' : 'inactive';
        }
      }
      const path = findKnownPath(this.level, knowledge, start, destination, constraints.authorizedHazardIds);
      const reserve = path ? path.length * this.level.rules.actionCosts[this.state.human.carried ? 'carry_move' : 'move'].battery + constraints.reserveMargin : Number.POSITIVE_INFINITY;
      const refill = action.kind === 'use_item' && this.getEntity(action.itemId)?.itemType === 'battery' ? this.level.rules.batteryRefill : 0;
      if (this.state.robot.battery - cost.battery + refill < reserve) return reject('RETURN_RESERVE', '该动作会违反返回电量储备，需调整路线或补给。');
    }
    this.state.elapsedTU += cost.tu;
    this.state.human.oxygen = Math.max(0, this.state.human.oxygen - cost.oxygen);
    this.state.robot.battery -= cost.battery;
    if (this.state.human.oxygen <= 0) { this.state.phase = 'failure'; this.state.failureReason = '氧气耗尽'; message = '氧气耗尽，救援失败'; }
    else {
      effect?.();
      if (this.state.phase !== 'success' && this.state.robot.battery <= 0) { this.state.phase = 'failure'; this.state.failureReason = '机器人电量耗尽'; message = '机器人失去行动能力，救援失败'; }
    }
    this.observe(); this.updateRadar(); this.state.stateRevision++;
    const delta = diffKnowledge(before, this.state.knowledge);
    this.state.ledger.push({ sequence: this.state.ledger.length + 1, actionId, action: structuredClone(action), cost: { ...cost }, message, position: { ...this.state.robot.position }, oxygen: this.state.human.oxygen, battery: this.state.robot.battery, elapsedTU: this.state.elapsedTU, phase: this.state.phase, constraints: structuredClone(constraints) });
    const result: ActionOutcome = { accepted: true, code: this.state.phase === 'failure' ? 'GAME_FAILED' : 'OK', message, cost, delta, actionId, stateRevision: this.state.stateRevision };
    this.state.processedActions[actionId] = structuredClone(result);
    return result;
  }

  private consume(id: string): void {
    this.state.robot.inventory = this.state.robot.inventory.filter(value => value !== id);
    const entity = this.getEntity(id);
    if (entity) { entity.removed = true; entity.taken = false; }
  }

  addMarker(position: Position, note: string, shared: boolean): MarkerResult {
    if (!Number.isInteger(position.x) || !Number.isInteger(position.y) || position.x < 0 || position.x >= this.level.width || position.y < 0 || position.y >= this.level.height) throw new Error('标记坐标非法');
    const marker = { id: crypto.randomUUID(), position: { ...position }, note: note.slice(0, 240), shared, createdAt: this.state.elapsedTU };
    this.state.markers.push(marker);
    this.state.markerHistory.push({ afterSequence: this.state.ledger.length, marker: structuredClone(marker), removed: false });
    if (shared) this.state.knowledge.markers.push(structuredClone(marker));
    this.state.stateRevision++;
    return marker;
  }

  removeMarker(id: string): MarkerResult {
    const marker = this.state.markers.find(marker => marker.id === id);
    if (!marker) throw new Error('标记不存在或已移除');
    this.state.markerHistory.push({ afterSequence: this.state.ledger.length, marker: structuredClone(marker), removed: true });
    this.state.markers = this.state.markers.filter(marker => marker.id !== id);
    this.state.knowledge.markers = this.state.knowledge.markers.filter(marker => marker.id !== id);
    this.state.stateRevision++;
    return marker;
  }

  playerView(): PlayerView {
    // Read static art data from the map, including for observations in older saves.
    const observed = Object.values(this.state.knowledge.entities).map(entity => {
      const orientation = entity.type === 'door' ? this.level.entities.find(definition => definition.id === entity.id)?.orientation : undefined;
      const actionCosts = this.level.entities.find(definition => definition.id === entity.id)?.actionCosts;
      return { ...entity, ...(orientation ? { orientation } : {}), ...(actionCosts ? { actionCosts } : {}) };
    });
    return structuredClone({
      level: { id: this.level.id, name: this.level.name, width: this.level.width, height: this.level.height, tiles: this.level.tiles, rooms: this.level.rooms, exit: this.level.exit },
      exitStatus: this.exitStatus,
      phase: this.state.phase, stateRevision: this.state.stateRevision, elapsedTU: this.state.elapsedTU,
      human: { ...this.state.human, actionCosts: this.level.human.actionCosts },
      robot: { ...this.state.robot, inventory: this.state.robot.inventory.map(id => observed.find(entity => entity.id === id)).filter((e): e is ObservedEntity => !!e) },
      rules: this.level.rules, observed, radar: this.state.radarHistory, markers: this.state.markers,
      sensorCells: sensorCells(this.level, this.state.robot.position, this.level.rules.sensorRadius), ledger: this.state.ledger.slice(-80), failureReason: this.state.failureReason,
    });
  }

  robotTelemetry() {
    return structuredClone({
      elapsedTU: this.state.elapsedTU, exitStatus: this.exitStatus,
      human: { ...this.state.human, actionCosts: this.level.human.actionCosts },
      robot: { ...this.state.robot, inventory: this.state.robot.inventory.map(id => {
        const item = this.state.knowledge.entities[id];
        return { id, name: item?.name, itemType: item?.itemType, actionCosts: this.level.entities.find(entity => entity.id === id)?.actionCosts };
      }) },
    });
  }

  robotContext(): object {
    const knownEntities = Object.values(this.state.knowledge.entities).map(entity => ({ ...entity, actionCosts: this.level.entities.find(definition => definition.id === entity.id)?.actionCosts }));
    const identifiedRadar = this.state.radarHistory.map(echo => ({
      echoId: echo.id, knownEntityIds: knownEntities.filter(entity => samePosition(entity.position, echo.position)).map(entity => entity.id),
    })).filter(echo => echo.knownEntityIds.length > 0);
    const identifiedEchoIds = new Set(identifiedRadar.map(echo => echo.echoId));
    return structuredClone({
      historicalMap: { width: this.level.width, height: this.level.height, tiles: this.level.tiles, rooms: this.level.rooms, exit: this.level.exit },
      exitStatus: this.exitStatus,
      rules: this.level.rules,
      telemetry: this.robotTelemetry(),
      interactionRules: { distanceMetric: 'manhattan', maxDistance: 1, diagonalAdjacent: false },
      knownEntities: knownEntities.map(entity => ({ ...entity, ...(entity.type === 'supply' && entity.state === 'cleared' ? { details: consumedSupplyDetails } : {}), interaction: { ...this.interactionInfo(entity), approachPositions: this.approachPositions(entity) } })), sharedMarkers: this.state.knowledge.markers,
      radar: this.state.radarHistory,
      identifiedRadar,
      unidentifiedRadar: this.state.radarHistory.filter(echo => !identifiedEchoIds.has(echo.id)),
    });
  }

  snapshot(): GameState { return structuredClone(this.state); }

  restore(snapshot: GameState): void {
    if (snapshot.schemaVersion !== 1 || snapshot.rulesVersion !== 5 || snapshot.levelId !== this.level.id || snapshot.levelVersion !== this.level.version) throw new Error('存档版本不兼容');
    if (!snapshot.robot || !snapshot.human || !Array.isArray(snapshot.entities) || !Array.isArray(snapshot.ledger) || !Array.isArray(snapshot.markerHistory) || !snapshot.knowledge || !snapshot.circuits || this.level.entities.some(e => e.type === 'switch' && typeof snapshot.circuits[e.id] !== 'boolean')) throw new Error('存档不完整');
    this.state = structuredClone(snapshot);
    if (!this.terminal) this.state.phase = 'paused';
  }
}

type MarkerResult = GameState['markers'][number];
