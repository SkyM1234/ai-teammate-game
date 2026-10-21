export type Position = { x: number; y: number };
export type ItemType = 'repair' | 'battery' | 'oxygen';
export type EntityType = 'supply' | 'cabinet' | 'door' | 'hazard' | 'obstacle' | 'airlock' | 'switch';
export type DoorOrientation = 'horizontal' | 'vertical';
export type Phase = 'awaiting_command' | 'agent_thinking' | 'executing' | 'awaiting_player' | 'paused' | 'success' | 'failure';

export interface ActionCost { tu: number; battery: number }
export interface RepairCost extends ActionCost { materials: number }
export interface ActionCosts {
  move: ActionCost; carry_move: ActionCost; scan: ActionCost;
}
export interface EntityActionCosts {
  open?: ActionCost; collect?: ActionCost; drop_item?: ActionCost; use_item?: ActionCost;
  repair?: RepairCost; clear?: ActionCost; circuit_on?: ActionCost; circuit_off?: ActionCost;
}
export interface HumanActionCosts {
  repair: RepairCost; pickup_human: ActionCost; drop_human: ActionCost;
}
export interface Rules {
  oxygen: number; oxygenMax: number; oxygenRate: number; repairedOxygenRate: number;
  battery: number; batteryMax: number; batteryRefill: number; oxygenRefill: number;
  inventorySlots: number; sensorRadius: number; radarRadius: number;
  moveLimit: number; toolLimit: number; requestLimit: number; actionTULimit: number;
  actionCosts: ActionCosts;
}
export interface EntityDefinition {
  id: string; type: EntityType; name: string; position: Position; reflection: number;
  itemType?: ItemType; containerId?: string; powerRequired?: boolean;
  orientation?: DoorOrientation;
  leakCost?: number;
  actionCosts?: EntityActionCosts;
}
export interface Entity extends EntityDefinition {
  opened: boolean; repaired: boolean; removed: boolean; taken: boolean;
}
export interface Room {
  name: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}
export interface Level {
  id: string; version: number; name: string; width: number; height: number; tiles: string[];
  humanStart: Position; robotStart: Position; exit: Position & { actionCosts: { extract: ActionCost } }; rules: Rules;
  human: { actionCosts: HumanActionCosts };
  rooms: Room[]; entities: EntityDefinition[];
  verification?: { actions: Action[]; alternatives?: Record<string, Action[]> };
}
export interface ObservedEntity {
  id: string; type: EntityType; name: string; position: Position;
  state: string; itemType?: ItemType; scanned: boolean; details?: string;
  actionCosts?: EntityActionCosts;
  powerRequired?: boolean;
  orientation?: DoorOrientation;
  leakCost?: number;
  observedAt: number; source: 'sensor' | 'scan';
}
export interface Knowledge {
  entities: Record<string, ObservedEntity>;
  scannedIds: string[];
  markers: Marker[];
}
export interface Marker { id: string; position: Position; note: string; shared: boolean; createdAt: number }
export interface RadarEcho { id: string; position: Position; strength: 'weak' | 'strong'; shape: 'steady' | 'flickering'; observedAt: number; historical: boolean }
export interface ObservationDelta {
  newDiscoveries: ObservedEntity[];
  stateChanges: ObservedEntity[];
  invalidatedFacts: string[];
  knownRefs: string[];
}
export type Action =
  | { kind: 'move'; target: Position }
  | { kind: 'scan'; targetId: string }
  | { kind: 'open' | 'collect' | 'repair' | 'clear'; targetId: string }
  | { kind: 'drop_item'; itemId: string }
  | { kind: 'use_item'; itemId: string; targetId: 'human' | 'robot' }
  | { kind: 'pickup_human' | 'drop_human' | 'extract' }
  | { kind: 'circuit'; targetId: string; on: boolean };
export interface Constraints {
  reserveReturnBattery: boolean; reserveMargin: number;
  authorizedHazardIds: string[];
  stopOnHazard: boolean;
  allowedRepairs: string[];
}
export interface Cost { tu: number; battery: number; oxygen: number }
export interface ActionOutcome {
  accepted: boolean; code: string; message: string; cost: Cost;
  delta: ObservationDelta; actionId: string; stateRevision: number;
}
export interface LedgerEntry {
  sequence: number; actionId: string; action: Action; cost: Cost; message: string;
  position: Position; oxygen: number; battery: number; elapsedTU: number; phase: Phase; constraints: Constraints;
}
export interface GameState {
  schemaVersion: number; levelId: string; levelVersion: number; rulesVersion: number;
  stateRevision: number; elapsedTU: number; phase: Phase; circuitOn: boolean;
  human: { position: Position; oxygen: number; oxygenRate: number; carried: boolean };
  robot: { position: Position; battery: number; inventory: string[] };
  entities: Entity[]; knowledge: Knowledge; radarHistory: RadarEcho[]; markers: Marker[];
  markerHistory: { afterSequence: number; marker: Marker; removed: boolean }[];
  ledger: LedgerEntry[]; processedActions: Record<string, ActionOutcome>; failureReason: string | null;
}
export interface PlayerView {
  level: Pick<Level, 'id' | 'name' | 'width' | 'height' | 'tiles' | 'rooms' | 'exit'>;
  exitStatus: 'leaking' | 'safe';
  phase: Phase; stateRevision: number; elapsedTU: number; circuitOn: boolean;
  human: GameState['human'] & { actionCosts: HumanActionCosts }; robot: Omit<GameState['robot'], 'inventory'> & { inventory: ObservedEntity[] };
  rules: Rules; observed: ObservedEntity[]; radar: RadarEcho[]; markers: Marker[];
  sensorCells: Position[]; ledger: LedgerEntry[]; failureReason: string | null;
}
export interface ReplayView {
  step: number; total: number; entries: LedgerEntry[]; state: PlayerView;
}
export const distance = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const samePosition = (a: Position, b: Position): boolean => a.x === b.x && a.y === b.y;
export const positionKey = (p: Position): string => `${p.x},${p.y}`;
export const roomCenter = (room: Room): Position => ({ x: Math.round((room.bounds.minX + room.bounds.maxX) / 2), y: Math.round((room.bounds.minY + room.bounds.maxY) / 2) });
export const emptyDelta = (): ObservationDelta => ({ newDiscoveries: [], stateChanges: [], invalidatedFacts: [], knownRefs: [] });
