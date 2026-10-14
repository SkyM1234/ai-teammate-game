import { canObserve, findKnownPath, sensorCells } from './navigation.ts';
import { distance, emptyDelta, positionKey, samePosition } from './types.ts';
import type { Action, ActionOutcome, Constraints, Cost, Entity, GameState, Knowledge, Level, ObservationDelta, ObservedEntity, PlayerView, Position, RadarEcho } from './types.ts';

export const defaultConstraints = (): Constraints => ({ reserveReturnBattery: false, reserveMargin: 5, authorizedHazardIds: [], stopOnHazard: false, allowedRepairs: [] });

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
      schemaVersion: 1, levelId: level.id, levelVersion: level.version, rulesVersion: 3,
      stateRevision: 0, elapsedTU: 0, phase: 'awaiting_command', circuitOn: false,
      human: { position: { ...level.humanStart }, oxygen: level.rules.oxygen, oxygenRate: level.rules.oxygenRate, carried: false },
      robot: { position: { ...level.robotStart }, battery: level.rules.battery, inventory: [] },
      entities: level.entities.map(e => ({ ...structuredClone(e), opened: false, repaired: false, removed: false, taken: false })),
      knowledge: { entities: {}, scannedIds: [], markers: [] }, radarHistory: [], markers: [], ledger: [], processedActions: {}, failureReason: null,
    };
    this.observe();
    this.updateRadar();
  }

  get terminal(): boolean { return this.state.phase === 'success' || this.state.phase === 'failure'; }

  private getEntity(id: string): Entity | undefined { return this.state.entities.find(e => e.id === id); }

  private reachable(p: Position): boolean {
    return distance(this.state.robot.position, p) <= 1 && this.level.tiles[p.y]?.[p.x] !== '#';
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
    else if (entity.type === 'hazard') state = this.state.circuitOn ? 'active' : 'inactive';
    else if (entity.type === 'switch') state = this.state.circuitOn ? 'on' : 'off';
    else if (entity.type === 'airlock') state = entity.repaired ? 'repaired' : 'damaged';
    const result: ObservedEntity = {
      id: entity.id, type: entity.type, name: entity.name, position: { ...entity.position }, state,
      scanned, observedAt: this.state.elapsedTU, source: scanned ? 'scan' : 'sensor',
    };
    if (entity.itemType) result.itemType = entity.itemType;
    if (scanned) {
      if (entity.powerRequired) result.powerRequired = true;
      if (entity.powerRequired) result.details = '需要辅助电路供电；打开后断电不会自动关闭。';
      else if (entity.type === 'switch') result.details = '机器人须在同格或相邻格操作；控制电池柜、电动门与暴露线路，通电可能激活漏电。';
      else if (entity.type === 'airlock') result.details = entity.repaired ? '已修复，可在气闸位置启动撤离。' : '控制器损坏，需要一份维修材料。';
      else if (entity.type === 'hazard') result.details = `接入辅助电路，通电时每次进入额外消耗 ${this.level.rules.leakCost} 电量。`;
      else if (entity.itemType === 'battery') result.details = `可恢复 ${this.level.rules.batteryRefill} 电量。`;
      else if (entity.itemType === 'oxygen') result.details = `可恢复 ${this.level.rules.oxygenRefill} 氧气。`;
      else if (entity.type === 'obstacle') result.details = '清理需要 3 TU、4 电量。';
      else result.details = '状态已确认。';
    }
    return result;
  }

  observe(): void {
    for (const entity of this.state.entities) {
      if (this.visible(entity) || this.state.robot.inventory.includes(entity.id) || entity.removed && !!this.state.knowledge.entities[entity.id]) {
        this.state.knowledge.entities[entity.id] = this.observation(entity);
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
        shape: current?.shape === 'flickering' || entity.type === 'hazard' && this.state.circuitOn ? 'flickering' : 'steady',
        observedAt: this.state.elapsedTU, historical: false,
      });
    }
    const historical = this.state.radarHistory.filter(e => distance(this.state.robot.position, e.position) > this.level.rules.radarRadius).map(e => ({ ...e, historical: true }));
    this.state.radarHistory = [...historical, ...echoes.values()];
  }

  knownPath(target: Position, constraints: Constraints = defaultConstraints()): Position[] | null {
    return findKnownPath(this.level, this.state.knowledge, this.state.robot.position, target, this.state.circuitOn, constraints.authorizedHazardIds);
  }

  perform(action: Action, actionId: string = crypto.randomUUID(), constraints: Constraints = defaultConstraints()): ActionOutcome {
    return this.performAction(action, actionId, constraints);
  }

  // Only trusted historical ledgers can replay the former remote circuit action.
  // New player/model actions always use the physical switch rules.
  static forReplay(level: Level, entries: GameState['ledger']): GameEngine {
    const historicalLevel = structuredClone(level);
    for (const entity of historicalLevel.entities.filter(e => e.type === 'switch')) {
      const entry = entries.find(e => e.action.kind === 'circuit' && e.action.targetId === entity.id && e.targetPosition);
      if (entry?.targetPosition) entity.position = { ...entry.targetPosition };
    }
    return new GameEngine(historicalLevel);
  }

  replayEntry(entry: GameState['ledger'][number]): ActionOutcome {
    if (entry.action.kind === 'circuit' && entry.targetPosition) {
      const entity = this.getEntity(entry.action.targetId);
      if (entity?.type === 'switch' && !samePosition(entity.position, entry.targetPosition)) this.relocateSwitch(entity, entry.targetPosition);
    }
    return this.performAction(entry.action, entry.actionId, entry.constraints ?? defaultConstraints(), entry.action.kind === 'circuit' && !('targetId' in entry.action));
  }

  private relocateSwitch(entity: Entity, position: Position): void {
    const oldPosition = entity.position;
    entity.position = { ...position };
    delete this.state.knowledge.entities[entity.id];
    this.state.knowledge.scannedIds = this.state.knowledge.scannedIds.filter(id => id !== entity.id);
    this.state.radarHistory = this.state.radarHistory.filter(e => !samePosition(e.position, oldPosition));
    this.observe(); this.updateRadar();
  }

  private performAction(action: Action, actionId: string, constraints: Constraints, legacyCircuit = false): ActionOutcome {
    const cached = this.state.processedActions[actionId];
    if (cached) return structuredClone(cached);
    const before = structuredClone(this.state.knowledge);
    const reject = (code: string, message: string): ActionOutcome => {
      const result: ActionOutcome = { accepted: false, code, message, cost: { tu: 0, battery: 0, oxygen: 0 }, delta: emptyDelta(), actionId, stateRevision: this.state.stateRevision };
      this.state.processedActions[actionId] = result;
      return structuredClone(result);
    };
    if (this.terminal) return reject('SESSION_FINISHED', '本局已经结束。');
    let cost: Cost = { tu: 0, battery: 0, oxygen: 0 };
    let message = '';
    let effect: (() => void) | undefined;
    let entity: Entity | undefined;
    if ('targetId' in action && action.targetId !== 'human' && action.targetId !== 'robot') {
      entity = this.getEntity(action.targetId);
      if (!entity || !this.state.knowledge.entities[action.targetId]) return reject('UNKNOWN_TARGET', '目标尚未识别。');
      if (!this.reachable(entity.position) || !this.visible(entity)) return reject('OUT_OF_RANGE', '需要先靠近已知目标，且保持视线。');
    }
    switch (action.kind) {
      case 'move': {
        const target = action.target;
        if (!Number.isInteger(target.x) || !Number.isInteger(target.y) || distance(this.state.robot.position, target) !== 1 || this.level.tiles[target.y]?.[target.x] === undefined || this.level.tiles[target.y][target.x] === '#') return reject('INVALID_MOVE', '只能向可通行的相邻格移动。');
        const blocker = this.state.entities.find(e => samePosition(e.position, target) && !e.removed && (e.type === 'cabinet' || e.type === 'door' && !e.opened || e.type === 'obstacle'));
        if (blocker) return reject('BLOCKED', '前方无法通行，请检查附近设施。');
        const hazard = this.state.entities.find(e => e.type === 'hazard' && samePosition(e.position, target) && this.state.circuitOn);
        if (hazard && !constraints.authorizedHazardIds.includes(hazard.id)) return reject('HAZARD_AUTH_REQUIRED', '前方有带电线路，需要断电或明确授权。');
        cost = { tu: 1, battery: (this.state.human.carried ? 2 : 1) + (hazard ? this.level.rules.leakCost : 0), oxygen: 0 };
        message = `移动至 (${target.x}, ${target.y})${this.state.human.carried ? ' · 搬运中' : ''}`;
        effect = () => { this.state.robot.position = { ...target }; if (this.state.human.carried) this.state.human.position = { ...target }; };
        break;
      }
      case 'scan':
        if (!entity) return reject('UNKNOWN_TARGET', '扫描目标非法。');
        cost = { tu: 1, battery: 2, oxygen: 0 }; message = `检查 ${entity.name}`;
        effect = () => { if (!this.state.knowledge.scannedIds.includes(entity.id)) this.state.knowledge.scannedIds.push(entity.id); };
        break;
      case 'open':
        if (!entity || !['door', 'cabinet'].includes(entity.type) || entity.opened) return reject('PRECONDITION_FAILED', '该目标不能开启，或已经开启。');
        if (entity.powerRequired && !this.state.circuitOn) return reject('POWER_REQUIRED', '需要机器人找到并靠近辅助电路开关，操作开关通电后再开启设备。');
        cost = { tu: 1, battery: 1, oxygen: 0 }; message = `开启 ${entity.name}`; effect = () => { entity.opened = true; };
        break;
      case 'collect':
        if (!entity || entity.type !== 'supply' || entity.taken) return reject('PRECONDITION_FAILED', '没有可取得的已知物资。');
        if (this.state.robot.inventory.length >= this.level.rules.inventorySlots) return reject('INVENTORY_FULL', '物品槽已满。');
        cost = { tu: 1, battery: 1, oxygen: 0 }; message = `取得 ${entity.name}`;
        effect = () => { entity.taken = true; this.state.robot.inventory.push(entity.id); };
        break;
      case 'drop_item': {
        const item = this.getEntity(action.itemId);
        if (!item || !this.state.robot.inventory.includes(item.id)) return reject('UNKNOWN_TARGET', '背包中没有该物品。');
        cost = { tu: 1, battery: 1, oxygen: 0 }; message = `放下 ${item.name}`;
        effect = () => { this.state.robot.inventory = this.state.robot.inventory.filter(id => id !== item.id); item.taken = false; item.containerId = undefined; item.position = { ...this.state.robot.position }; };
        break;
      }
      case 'use_item': {
        const item = this.getEntity(action.itemId);
        if (!item || !this.state.robot.inventory.includes(item.id)) return reject('UNKNOWN_TARGET', '背包中没有该物品。');
        if (item.itemType === 'battery' && action.targetId === 'robot') {
          cost = { tu: 1, battery: 1, oxygen: 0 }; message = '安装备用电池';
          effect = () => { this.state.robot.battery = Math.min(this.level.rules.batteryMax, this.state.robot.battery + this.level.rules.batteryRefill); this.consume(item.id); };
        } else if (item.itemType === 'oxygen' && action.targetId === 'human') {
          if (!this.reachable(this.state.human.position)) return reject('OUT_OF_RANGE', '需要先靠近玩家。');
          cost = { tu: 2, battery: 2, oxygen: 0 }; message = '为玩家补充氧气';
          effect = () => { this.state.human.oxygen = Math.min(this.level.rules.oxygenMax, this.state.human.oxygen + this.level.rules.oxygenRefill); this.consume(item.id); };
        } else return reject('PRECONDITION_FAILED', '物品与目标不匹配。');
        break;
      }
      case 'repair': {
        const target = action.targetId;
        if (target === 'human' && (!this.reachable(this.state.human.position) || this.state.human.oxygenRate === this.level.rules.repairedOxygenRate)) return reject('PRECONDITION_FAILED', '需靠近玩家，且供氧管尚未修补。');
        if (target !== 'human' && (!entity || entity.type !== 'airlock' || entity.repaired)) return reject('PRECONDITION_FAILED', '没有需要修复的已知控制器。');
        const material = this.state.robot.inventory.find(id => this.getEntity(id)?.itemType === 'repair');
        if (!material) return reject('MATERIAL_REQUIRED', '需要一份维修材料。');
        cost = { tu: target === 'human' ? 6 : 4, battery: 4, oxygen: 0 };
        message = target === 'human' ? '修补玩家供氧管' : '修复气闸控制器';
        effect = () => { this.consume(material); if (target === 'human') this.state.human.oxygenRate = this.level.rules.repairedOxygenRate; else if (entity) entity.repaired = true; };
        break;
      }
      case 'clear':
        if (!entity || entity.type !== 'obstacle' || entity.removed) return reject('PRECONDITION_FAILED', '没有可清理的已知障碍。');
        cost = { tu: 3, battery: 4, oxygen: 0 }; message = `清理 ${entity.name}`; effect = () => { entity.removed = true; };
        break;
      case 'pickup_human':
        if (this.state.human.carried || !samePosition(this.state.robot.position, this.state.human.position)) return reject('OUT_OF_RANGE', '需要与玩家位于同一格。');
        cost = { tu: 1, battery: 2, oxygen: 0 }; message = '抱起玩家，切换负重模式'; effect = () => { this.state.human.carried = true; };
        break;
      case 'drop_human':
        if (!this.state.human.carried || this.state.entities.some(e => e.type === 'hazard' && this.state.circuitOn && samePosition(e.position, this.state.robot.position))) return reject('PRECONDITION_FAILED', '只能在安全地面放下玩家。');
        cost = { tu: 1, battery: 1, oxygen: 0 }; message = '放下玩家'; effect = () => { this.state.human.carried = false; };
        break;
      case 'circuit':
        if (!legacyCircuit && entity?.type !== 'switch') return reject('UNKNOWN_TARGET', '必须指定已识别且可触及的实体电路开关。');
        if (typeof action.on !== 'boolean' || action.on === this.state.circuitOn) return reject('PRECONDITION_FAILED', '电路已经处于该状态。');
        cost = { tu: 1, battery: 0, oxygen: 0 }; message = `${action.on ? '开启' : '关闭'}辅助电路`; effect = () => { this.state.circuitOn = action.on; };
        break;
      case 'extract':
        if (!this.state.human.carried || !samePosition(this.state.robot.position, this.level.exit) || !this.state.entities.some(e => e.type === 'airlock' && e.repaired)) return reject('PRECONDITION_FAILED', '需要修复气闸，并将玩家搬运到出口。');
        cost = { tu: 2, battery: 2, oxygen: 0 }; message = '气闸接管救援，撤离成功'; effect = () => { this.state.phase = 'success'; };
        break;
      default: return reject('INVALID_ACTION', '不支持的动作。');
    }
    if (this.state.robot.battery < cost.battery) return reject('BATTERY_REQUIRED', '电量不足以完成该动作。');
    if (constraints.reserveReturnBattery && !legacyCircuit) {
      const start = action.kind === 'move' ? action.target : this.state.robot.position;
      const destination = this.state.human.carried ? this.level.exit : this.state.human.position;
      const path = findKnownPath(this.level, this.state.knowledge, start, destination, action.kind === 'circuit' ? action.on : this.state.circuitOn, constraints.authorizedHazardIds);
      const reserve = (path?.length ?? Number.POSITIVE_INFINITY) * (this.state.human.carried ? 2 : 1) + constraints.reserveMargin;
      const refill = action.kind === 'use_item' && this.getEntity(action.itemId)?.itemType === 'battery' ? this.level.rules.batteryRefill : 0;
      if (this.state.robot.battery - cost.battery + refill < reserve) return reject('RETURN_RESERVE', '该动作会违反返回电量储备，需调整路线或补给。');
    }
    cost.oxygen = this.state.human.oxygenRate * cost.tu;
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
    this.state.ledger.push({ sequence: this.state.ledger.length + 1, actionId, action: structuredClone(action), cost: { ...cost }, message, position: { ...this.state.robot.position }, oxygen: this.state.human.oxygen, battery: this.state.robot.battery, elapsedTU: this.state.elapsedTU, phase: this.state.phase, constraints: structuredClone(constraints), ...(action.kind === 'circuit' && entity ? { targetPosition: { ...entity.position } } : {}) });
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
    if (shared) this.state.knowledge.markers.push(structuredClone(marker));
    this.state.stateRevision++;
    return marker;
  }

  playerView(): PlayerView {
    return structuredClone({
      level: { id: this.level.id, name: this.level.name, width: this.level.width, height: this.level.height, tiles: this.level.tiles, rooms: this.level.rooms, exit: this.level.exit },
      phase: this.state.phase, stateRevision: this.state.stateRevision, elapsedTU: this.state.elapsedTU, circuitOn: this.state.circuitOn,
      human: this.state.human,
      robot: { ...this.state.robot, inventory: this.state.robot.inventory.map(id => this.state.knowledge.entities[id]).filter((e): e is ObservedEntity => !!e) },
      rules: this.level.rules, observed: Object.values(this.state.knowledge.entities), radar: this.state.radarHistory, markers: this.state.markers,
      sensorCells: sensorCells(this.level, this.state.robot.position, this.level.rules.sensorRadius), ledger: this.state.ledger.slice(-80), failureReason: this.state.failureReason,
    });
  }

  robotContext(): object {
    return structuredClone({
      historicalMap: { width: this.level.width, height: this.level.height, tiles: this.level.tiles, rooms: this.level.rooms, exit: this.level.exit },
      telemetry: { human: this.state.human, robot: this.state.robot, circuitOn: this.state.circuitOn, elapsedTU: this.state.elapsedTU },
      knownEntities: Object.values(this.state.knowledge.entities), sharedMarkers: this.state.knowledge.markers,
    });
  }

  snapshot(): GameState { return structuredClone(this.state); }

  restore(snapshot: GameState): void {
    if (snapshot.schemaVersion !== 1 || ![1, 2, 3].includes(snapshot.rulesVersion) || snapshot.levelId !== this.level.id || snapshot.levelVersion !== this.level.version) throw new Error('存档版本不兼容');
    if (!snapshot.robot || !snapshot.human || !Array.isArray(snapshot.entities) || !Array.isArray(snapshot.ledger) || !snapshot.knowledge) throw new Error('存档不完整');
    this.state = structuredClone(snapshot);
    if (snapshot.rulesVersion < 3) {
      for (const definition of this.level.entities.filter(e => e.type === 'switch')) {
        const entity = this.getEntity(definition.id);
        if (!entity) this.state.entities.push({ ...structuredClone(definition), opened: false, repaired: false, removed: false, taken: false });
        else {
          for (const entry of this.state.ledger) {
            if (entry.action.kind === 'circuit' && entry.action.targetId === entity.id && !entry.targetPosition) entry.targetPosition = { ...entity.position };
          }
          if (!samePosition(entity.position, definition.position)) this.relocateSwitch(entity, definition.position);
        }
      }
      this.state.rulesVersion = 3;
      this.observe(); this.updateRadar();
    }
    if (!this.terminal) this.state.phase = 'paused';
  }
}

type MarkerResult = GameState['markers'][number];
