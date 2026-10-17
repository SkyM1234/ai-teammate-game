import type { SessionView } from '../../server/src/session.ts';
import type { ModelConfig, modelCatalog } from '../../server/src/model.ts';
import type { ModelPreferencesView } from '../../server/src/model-preferences.ts';
import type { LevelSummary } from '../../server/src/levels.ts';
import type { Action, PlayerView, Position } from '../../../packages/game-core/src/types.ts';
import { roomCenter } from '../../../packages/game-core/src/types.ts';
import { StationRenderer } from './station-renderer.ts';
import { roomColors } from './art/themes.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let canvas = $<HTMLCanvasElement>('map');
let station: StationRenderer | null = null;
let flatContext: CanvasRenderingContext2D | null = null;
let flatAnimation = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
try { station = new StationRenderer(canvas); }
catch {
  const replacement = canvas.cloneNode() as HTMLCanvasElement;
  canvas.replaceWith(replacement); canvas = replacement;
  flatContext = canvas.getContext('2d');
  canvas.dataset.renderMode = '2d';
  canvas.setAttribute('aria-label', '空间站平面地图：点击格子选择位置');
  $('map-render-status').textContent = '当前设备使用平面地图';
  document.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach(button => { button.disabled = true; });
}
let view: SessionView | null = null;
let selected: Position | null = null;
let stream: EventSource | null = null;
let frames: PlayerView[] | null = null;
let replayIndex = 0;
let toastTimer: ReturnType<typeof setTimeout>;
let sending = false;
let lastMessages = '';
let markerEditorKey = '';
let providers: Awaited<ReturnType<typeof modelCatalog>> = [];
let modelDefaults: ModelPreferencesView | null = null;
let modelFormConfig: ModelConfig | null = null;
let answeringAuthorization = false;
let restoringSave = false;
const phaseNames: Record<string, string> = { awaiting_command: '等待指令', agent_thinking: '正在决策', executing: '行动中', awaiting_player: '等待你的决定', paused: '已暂停', success: '救援成功', failure: '救援失败' };
const stateNames: Record<string, string> = { available: '可获取', closed: '关闭', opened: '已打开', active: '带电', inactive: '未通电', on: '已通电', off: '已断电', damaged: '损坏', repaired: '已修复', cleared: '已移除', inventory: '已携带' };
const dist = (a: Position, b: Position) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y;
const current = () => frames?.[replayIndex] ?? view;
function toast(message: string) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
async function api<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, payload === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '连接失败'); return data as T;
}
function isCurrent(source: EventSource | null, session: SessionView) {
  return source === stream && session.sessionId === view?.sessionId && session.sessionInstanceId === view.sessionInstanceId;
}
function accept(next: SessionView, fromStream = false) {
  if (!view || next.sessionId !== view.sessionId) return;
  if (next.sessionInstanceId !== view.sessionInstanceId) {
    if (!fromStream) return;
    frames = null; selected = null; lastMessages = ''; markerEditorKey = '';
  } else if (next.eventId < view.eventId) return;
  view = next; render();
}
function attach(next: SessionView) {
  stream?.close(); frames = null; selected = null; lastMessages = ''; markerEditorKey = ''; view = next; render();
  const source = new EventSource(`/api/sessions/${next.sessionId}/events`); stream = source;
  source.onopen = () => { if (source !== stream) return; $('connection').textContent = '通信正常'; $('connection').style.color = '#66ddce'; };
  source.onmessage = event => { if (source === stream) accept(JSON.parse(event.data), true); };
  source.onerror = () => { if (source !== stream) return; $('connection').textContent = '通信重连中'; $('connection').style.color = '#f2b864'; };
}
async function post(operation: string, payload: Record<string, unknown> = {}) {
  if (!view) return false;
  const session = view; const source = stream;
  try {
    const next = await api<SessionView>(`/api/sessions/${session.sessionId}/${operation}`, { requestId: crypto.randomUUID(), expectedRevision: session.stateRevision, ...payload });
    if (!isCurrent(source, session)) return false;
    accept(next); return true;
  }
  catch (error) {
    if (!isCurrent(source, session)) return false;
    toast(error instanceof Error ? error.message : String(error));
    try { const next = await api<SessionView>(`/api/sessions/${session.sessionId}`); if (isCurrent(source, session)) accept(next); } catch { /* SSE will reconnect. */ }
    return false;
  }
}
async function manual(action: Action) { if (!frames) await post('action', { action }); }
function button(label: string, action: Action) {
  const el = document.createElement('button'); el.textContent = label;
  el.disabled = !!frames || !view || ['success', 'failure'].includes(view.phase);
  el.onclick = () => void manual(action); return el;
}
function itemArt(kind: string) {
  const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  art.setAttribute('viewBox', '0 0 80 88'); art.setAttribute('aria-hidden', 'true'); art.classList.add('item-art');
  const shapes: Record<string, string> = {
    battery: '<path d="M30 9h20v9H30z" fill="#aebaa4"/><rect x="21" y="18" width="38" height="58" rx="5" fill="#93a18b"/><path d="M25 23h30v44H25z" fill="#263b32"/><path d="m43 28-12 21h10l-3 13 12-22H40z" fill="#dfe66c"/><path d="M28 72h24" stroke="#c7d1bc" stroke-width="2"/>',
    oxygen: '<path d="M34 8h12v10H34zM29 8h22" stroke="#b9c5b2" stroke-width="4"/><rect x="23" y="18" width="34" height="59" rx="15" fill="#a7c4b6"/><path d="M24 39h32v25H24z" fill="#2c5c50"/><text x="40" y="56" text-anchor="middle" fill="#d6eee1" font-size="14">O₂</text><path d="M29 30v8" stroke="#e3efdf" stroke-width="3"/>',
    repair: '<path d="M29 22v-9h22v9" fill="none" stroke="#bac5ab" stroke-width="5"/><rect x="13" y="24" width="54" height="47" rx="4" fill="#a7ad7b"/><path d="M13 40h54v8H13z" fill="#57634a"/><path d="M36 35h8v20h-8z" fill="#dbe396"/><path d="M18 65h44" stroke="#d1d4ac" stroke-width="2"/>'
  };
  art.innerHTML = shapes[kind] ?? '<path d="M15 25h50v43H15zM25 15h30v10M27 41h26M27 52h26" fill="none" stroke="currentColor" stroke-width="3"/>';
  return art;
}
function render() {
  if (!view) return;
  const p = current()!;
  const terminal = ['success', 'failure'].includes(p.phase);
  $('map-sector').textContent = `${p.level.id.toUpperCase()} · 救援区域`;
  $('level-name').textContent = p.level.name;
  $('map-dimensions').textContent = `${p.level.width} × ${p.level.height} / LOCAL`;
  $('level-name').title = p.level.name;
  $('clock').textContent = `${String(p.elapsedTU).padStart(2, '0')} TU${frames ? ' / 回放' : ''}`;
  $('oxygen-value').textContent = String(p.human.oxygen);
  $('battery-value').textContent = String(p.robot.battery);
  document.querySelectorAll<HTMLElement>('[data-stat="oxygen"]').forEach(el => { el.textContent = String(p.human.oxygen); });
  document.querySelectorAll<HTMLElement>('[data-stat="battery"]').forEach(el => { el.textContent = String(p.robot.battery); });
  $('map-oxygen').textContent = String(p.human.oxygen);
  $('map-battery').textContent = String(p.robot.battery);
  $('map-phase').textContent = frames ? '历史回放' : phaseNames[p.phase];
  document.querySelector<HTMLElement>('.shell')!.dataset.danger = String(p.human.oxygen < 25);
  const milestones = [p.human.oxygenRate === p.rules.repairedOxygenRate, p.exitStatus === 'safe', p.phase === 'success'];
  $('exit-status').textContent = p.exitStatus === 'leaking' ? '出口漏气喷射中 · 修复气闸控制器后才可进入。' : '出口已密封 · 可将伤员搬运至 EXIT 撤离。';
  const firstIncomplete = milestones.indexOf(false);
  $('mission-progress').textContent = `${milestones.filter(Boolean).length} / ${milestones.length}`;
  $('mission-progress-bar').style.width = `${milestones.filter(Boolean).length / milestones.length * 100}%`;
  $('exit-status').dataset.safe = String(p.exitStatus === 'safe');
  document.querySelectorAll<HTMLElement>('[data-milestone]').forEach((step, i) => {
    step.classList.toggle('complete', milestones[i]);
    step.querySelector('.milestone-state')!.textContent = milestones[i] ? '已完成' : i === firstIncomplete ? '当前阶段' : '待完成';
    if (i === firstIncomplete) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  });
  for (const id of ['oxygen-bar', 'monitor-oxygen-bar']) {
    $(id).style.width = `${p.human.oxygen / p.rules.oxygenMax * 100}%`;
    $(id).style.background = p.human.oxygen < 25 ? '#ef817c' : '#66ddce';
  }
  $('battery-bar').style.width = `${p.robot.battery / p.rules.batteryMax * 100}%`;
  $('human-oxygen-max').textContent = ` / ${p.rules.oxygenMax}`;
  $('robot-battery-bar').style.width = `${p.robot.battery / p.rules.batteryMax * 100}%`;
  $('robot-battery-max').textContent = ` / ${p.rules.batteryMax}`;
  $('monitor-oxygen-max').textContent = ` / ${p.rules.oxygenMax}`;
  $('monitor-battery-max').textContent = ` / ${p.rules.batteryMax}`;
  $('oxygen-rate').textContent = `${p.human.oxygenRate} / TU`;
  $('oxygen-condition').textContent = p.human.oxygen < 25 ? '氧气不足' : p.human.oxygenRate === p.rules.repairedOxygenRate ? '供氧管已修复' : '供氧管受损';
  $('oxygen-advice').textContent = p.human.oxygenRate === p.rules.repairedOxygenRate ? '供氧消耗已降低，继续准备撤离。' : '修补供氧管可降低每次行动消耗。';
  document.querySelector<HTMLElement>('.telemetry')!.dataset.lowOxygen = String(p.human.oxygen < 25);
  document.querySelector<HTMLElement>('.telemetry')!.dataset.lowBattery = String(p.robot.battery / p.rules.batteryMax < .25);
  $('battery-condition').textContent = p.robot.battery / p.rules.batteryMax < .25 ? '电量不足' : '电量监测';
  $('circuit-lamp').dataset.on = String(p.circuitOn);
  $('control-position').textContent = `(${p.robot.position.x}, ${p.robot.position.y})`;
  $('inventory-count').textContent = `${p.robot.inventory.length} / ${p.rules.inventorySlots}`;
  $('drawer-clock').textContent = `${String(p.elapsedTU).padStart(2, '0')} TU${frames ? ' / 回放' : ''}`;
  document.querySelector<HTMLElement>('.robot-card')!.dataset.lowBattery = String(p.robot.battery / p.rules.batteryMax < .25);
  $('robot-summary').textContent = `${frames ? '回放 · ' : ''}${!frames && view.pendingAuthorization ? '等待你的授权' : phaseNames[p.phase]}`;
  $('robot-location').textContent = `坐标 (${p.robot.position.x}, ${p.robot.position.y}) · ${p.human.carried ? '搬运伤员中' : `物资 ${p.robot.inventory.length} / ${p.rules.inventorySlots}`}`;
  $('human-status').textContent = `${p.human.carried ? '正在由 R-07 搬运' : '受伤 · 无法移动'} / 每 TU 消耗 ${p.human.oxygenRate} 氧气`;
  $('robot-status').textContent = `${phaseNames[p.phase]} / 坐标 (${p.robot.position.x}, ${p.robot.position.y})`;
  $('circuit-state').textContent = p.circuitOn ? '已通电 · 故障可能带电' : '已断电';
  $('agent-label').textContent = view.agentLabel;
  $('model-status').textContent = view.modelError ?? (view.agentMode === 'live' ? !view.modelReady ? '缺少模型凭据 · 请打开模型设置' : view.running ? '模型已配置 · 任务运行中' : '模型已配置 · 等待指令（连接将在请求时验证）' : '本地演示 · 无模型请求');
  $('model-status').classList.toggle('has-error', !!view.modelError || !view.modelReady);
  if (view.agentMode === 'live' && view.modelReady && !view.modelError && view.modelCredentialSource === 'pi') $('model-status').textContent += ' · 复用本机 pi 凭据';
  $('mode-help').textContent = view.agentMode === 'live' ? '自然语言报告仅作通信；确认信息以地图和行动记录为准。遇到关键变化，机器人会重新决策。' : '规则演示支持明确目标和坐标，如“前往 (4,8)”。复杂对话需配置真实模型。';
  $('inventory').replaceChildren();
  for (let i = 0; i < p.rules.inventorySlots; i++) {
    const slot = document.createElement('div'); slot.className = 'slot';
    const item = p.robot.inventory[i];
    const number = document.createElement('span'); number.className = 'slot-number'; number.textContent = `SLOT ${String(i + 1).padStart(2, '0')}`; slot.append(number);
    if (!item) {
      slot.classList.add('empty');
      const placeholder = document.createElement('div'); placeholder.className = 'slot-placeholder'; placeholder.textContent = '+'; placeholder.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong'); label.textContent = '空置仓位';
      const hint = document.createElement('p'); hint.textContent = '可携带一件物资'; slot.append(placeholder, label, hint);
    }
    else {
      slot.dataset.item = item.itemType;
      const name = document.createElement('strong'); name.textContent = item.name;
      const hint = document.createElement('p'); hint.textContent = item.itemType === 'battery' ? '安装以补充机器人电量' : item.itemType === 'oxygen' ? '靠近伤员后可补氧' : '用于修补与设备维修';
      const controls = document.createElement('div'); controls.className = 'slot-controls';
      if (item.itemType === 'battery') controls.append(button('安装', { kind: 'use_item', itemId: item.id, targetId: 'robot' }));
      if (item.itemType === 'oxygen') {
        const use = button('补氧', { kind: 'use_item', itemId: item.id, targetId: 'human' });
        if (dist(p.human.position, p.robot.position) > 1) { use.disabled = true; use.title = '需要靠近伤员'; }
        controls.append(use);
      }
      controls.append(button('放下', { kind: 'drop_item', itemId: item.id }));
      slot.append(itemArt(item.itemType ?? 'repair'), name, hint, controls);
    }
    $('inventory').append(slot);
  }
  $('nearby').replaceChildren();
  const near = p.observed.filter(e => !['cleared', 'inventory'].includes(e.state) && p.sensorCells.some(cell => same(cell, e.position)) && dist(e.position, p.robot.position) <= 1);
  for (const e of near) {
    const group = document.createElement('div'); group.className = 'action-group';
    const title = document.createElement('p'); title.textContent = e.name;
    const state = document.createElement('span'); state.className = 'object-state'; state.textContent = `${stateNames[e.state] ?? e.state} · (${e.position.x}, ${e.position.y})`;
    group.append(itemArt(e.itemType ?? e.type), title, state);
    if (!e.scanned) group.append(button('检查', { kind: 'scan', targetId: e.id }));
    if (e.type === 'supply' && e.state === 'available') group.append(button('拾取', { kind: 'collect', targetId: e.id }));
    if (['cabinet', 'door'].includes(e.type) && e.state === 'closed') group.append(button('开启', { kind: 'open', targetId: e.id }));
    if (e.type === 'obstacle') group.append(button('清理', { kind: 'clear', targetId: e.id }));
    if (e.type === 'airlock' && e.state === 'damaged') group.append(button('维修', { kind: 'repair', targetId: e.id }));
    if (e.type === 'switch') group.append(button(p.circuitOn ? '关闭电路' : '开启电路', { kind: 'circuit', targetId: e.id, on: !p.circuitOn }));
    $('nearby').append(group);
  }
  if (dist(p.human.position, p.robot.position) <= 1 && p.human.oxygenRate !== p.rules.repairedOxygenRate) $('nearby').append(button('修补供氧管', { kind: 'repair', targetId: 'human' }));
  if (same(p.human.position, p.robot.position)) $('nearby').append(button(p.human.carried ? '放下你' : '抱起你', { kind: p.human.carried ? 'drop_human' : 'pickup_human' }));
  if (p.human.carried && same(p.robot.position, p.level.exit)) $('nearby').append(button('启动气闸 · 撤离', { kind: 'extract' }));
  if (!$('nearby').childElementCount) { const hint = document.createElement('p'); hint.className = 'subtle'; hint.textContent = '附近没有已确认的可操作对象。'; $('nearby').append(hint); }
  $('nearby-count').textContent = `${$('nearby').querySelectorAll('button').length} 项操作`;
  document.querySelectorAll<HTMLButtonElement>('[data-dx]').forEach(el => { el.disabled = terminal || !!frames; });
  const task = view.task;
  $('task').replaceChildren();
  const taskStatus = task?.status === 'completed' && task.interpretation === 'model' ? '已结束' : task ? { active: '执行中', paused: '暂停', waiting: '待决定', completed: '已完成' }[task.status] : '待命';
  $('comms-state').textContent = !frames && view.pendingAuthorization ? '等待授权' : frames ? '历史回放' : taskStatus;
  const taskLabel = document.createElement('span'); taskLabel.className = 'tiny'; taskLabel.textContent = `当前委托 / ${taskStatus}`;
  const taskText = document.createElement('p'); taskText.textContent = task?.text ?? '等待你的指令。'; $('task').append(taskLabel, taskText);
  if (task?.question) { const question = document.createElement('p'); question.className = 'question'; question.textContent = task.question; $('task').append(question); }
  $<HTMLButtonElement>('continue').disabled = !!frames || terminal || view.running || !task || task.status === 'completed';
  $<HTMLButtonElement>('stop').disabled = !!frames || terminal || !view.running;
  $<HTMLButtonElement>('send').disabled = !!frames || terminal || sending;
  $('demo-rescue-controls').hidden = view.agentMode !== 'demo' || !view.demoRescueAvailable;
  $<HTMLButtonElement>('demo-rescue').disabled = !!frames || terminal || sending || view.running;
  renderMessages();
  const m = view.metrics; $('metrics').textContent = `模型请求 ${m.requests} / 工具 ${m.executedTools} / 跳过 ${m.skippedTools} / 中断 ${m.interrupts}\nTokens ${m.inputTokens} in · ${m.outputTokens} out / 结果 ${(m.resultBytes / 1024).toFixed(1)} KB`;
  $('ledger').replaceChildren();
  $('ledger-mode').textContent = frames ? '历史回放' : '实时';
  $('ledger-mode').dataset.replay = String(!!frames);
  for (const entry of [...p.ledger].reverse()) {
    const row = document.createElement('div'); row.className = 'ledger-entry';
    const time = document.createElement('span'); time.className = 'tu'; time.textContent = `${entry.elapsedTU} TU`;
    const title = document.createElement('span'); title.textContent = entry.message;
    const glyph = document.createElement('span'); glyph.className = 'ledger-glyph'; glyph.setAttribute('aria-hidden', 'true'); glyph.textContent = entry.action.kind === 'move' ? '↗' : entry.action.kind === 'repair' ? '+' : entry.action.kind === 'scan' ? '◎' : '•';
    const cost = document.createElement('span'); cost.className = 'cost'; cost.textContent = `O₂ −${entry.cost.oxygen} / B −${entry.cost.battery}`;
    row.append(time, glyph, title, cost); $('ledger').append(row);
  }
  if (!p.ledger.length) $('ledger').textContent = '等待第一次行动。';
  $('end-state').hidden = !terminal;
  $('end-state').classList.toggle('failed', p.phase === 'failure');
  $('end-state').textContent = p.phase === 'success' ? `救援成功。你们用 ${p.elapsedTU} TU 离开了空间站。` : `救援失败：${p.failureReason ?? '资源耗尽'}。可以回放本局，或开始新的尝试。`;
  $('replay-controls').hidden = !frames; $('exit-replay').hidden = !frames; $('replay').hidden = !!frames;
  $('replay-index').textContent = `${replayIndex} / ${(frames?.length ?? 1) - 1}`;
  renderSelection(); drawMap();
}
function renderSelection() {
  const p = current(); if (!p) return;
  $('selection-hint').hidden = !!selected;
  $<HTMLButtonElement>('go-selected').disabled = !selected || !!frames || ['success', 'failure'].includes(p.phase) || same(selected, p.level.exit) && p.exitStatus === 'leaking';
  $<HTMLButtonElement>('add-marker').disabled = !selected || !!frames;
  $<HTMLButtonElement>('toggle-marker').disabled = !selected || !!frames;
  const markers = selected ? p.markers.filter(marker => same(marker.position, selected!)) : [];
  $('selection-markers').hidden = markers.length === 0;
  $('selection-markers').replaceChildren();
  for (const marker of markers) {
    const row = document.createElement('div'); row.className = 'selection-marker';
    const content = document.createElement('div');
    const visibility = document.createElement('span'); visibility.className = 'marker-visibility'; visibility.textContent = marker.shared ? '已共享给 R-07' : '仅自己可见';
    const note = document.createElement('p'); note.textContent = marker.note || '未填写说明';
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除标记：${marker.note || '未填写说明'}`);
    remove.disabled = !!frames;
    remove.onclick = async () => {
      remove.disabled = true;
      if (await post('remove-marker', { markerId: marker.id })) {
        if (drawer.open && drawer.dataset.panel === 'selection' && selected && same(selected, marker.position)) $('toggle-marker').focus();
        toast(marker.shared ? '已移除标记，并同步给 R-07。' : '已移除私有标记。');
      }
      else remove.disabled = !!frames;
    };
    content.append(visibility, note); row.append(content, remove); $('selection-markers').append(row);
  }
  const editorKey = JSON.stringify([view?.sessionId, selected, !!frames, markers]);
  // Refresh on a different cell or saved marker, while preserving drafts during telemetry updates.
  if (editorKey !== markerEditorKey) {
    setMarkerEditor(false);
    const latest = markers.at(-1);
    $<HTMLInputElement>('marker-note').value = latest?.note ?? '';
    $<HTMLInputElement>('marker-shared').checked = latest?.shared ?? true;
    markerEditorKey = editorKey;
  }
  $<HTMLInputElement>('marker-note').disabled = !selected || !!frames;
  $<HTMLInputElement>('marker-shared').disabled = !selected || !!frames;
  if (!selected) { if (drawer.open && drawer.dataset.panel === 'selection') drawer.close(); return; }
  $('selection-position').textContent = `(${selected.x}, ${selected.y})`;
  const object = p.observed.find(e => same(e.position, selected!) && !['cleared', 'inventory'].includes(e.state));
  const echo = p.radar.find(e => same(e.position, selected!));
  const rooms = p.level.rooms.filter(({ bounds }) => selected!.x >= bounds.minX && selected!.x <= bounds.maxX && selected!.y >= bounds.minY && selected!.y <= bounds.maxY);
  $('selection-room').hidden = rooms.length === 0;
  $('selection-room').textContent = `历史区域：${rooms.map(room => room.name).join(' / ')}`;
  $('selection-room').title = rooms.map(({ name, bounds }) => `${name}：x ${bounds.minX}–${bounds.maxX}，y ${bounds.minY}–${bounds.maxY}`).join('\n');
  $('selection-title').textContent = object?.name ?? (echo ? '未知雷达回波' : p.level.tiles[selected.y][selected.x] === '#' ? '历史图上的墙体' : '历史图上的地面');
  $('selection-detail').textContent = object ? `${stateNames[object.state]} / 最近观察 ${object.observedAt} TU${object.details ? ` · ${object.details}` : ' · 靠近后可进一步检查'}` : echo ? `${echo.strength === 'strong' ? '强' : '弱'}信号 / ${echo.shape === 'flickering' ? '闪烁' : '稳定'} / ${echo.historical ? '历史回波，当前未覆盖' : '当前雷达覆盖'}；具体对象未知。` : '选中的位置尚无确认对象；地图记录可能已过时。';
  $('selection-detail').title = $('selection-detail').textContent;
  if (same(selected, p.level.exit)) {
    $('selection-title').textContent = '撤离出口';
    $('selection-detail').textContent = p.exitStatus === 'leaking' ? '漏气喷射中，禁止进入。需先找到并修复气闸控制器；附近安全格仍可通行。' : '漏气已停止，可以进入。将伤员搬到此处后启动撤离。';
    $('selection-detail').title = $('selection-detail').textContent;
  }
}
function setMarkerEditor(open: boolean) {
  $('marker-form').hidden = !open;
  $('toggle-marker').setAttribute('aria-expanded', String(open));
  if (open) $('marker-note').focus();
}
function geometry() {
  const { width, height } = canvas.getBoundingClientRect();
  // Fit rectangular maps with square cells inside the circular viewport.
  const size = Math.min(width, height) * Math.SQRT1_2;
  const padding = Math.min(25, size * .07);
  const level = current()!.level;
  const cell = (size - padding * 2) / Math.max(level.width, level.height);
  return { width, height, size, offsetX: (width - level.width * cell - padding * 2) / 2, offsetY: (height - level.height * cell - padding * 2) / 2, padding, cell };
}
function drawMap() {
  const p = current(); if (!p) return;
  if (station) station.update(p, selected); else drawFlatMap();
}
document.addEventListener('visibilitychange', () => { if (!station && !document.hidden) drawMap(); });
function drawFlatMap() {
  cancelAnimationFrame(flatAnimation); flatAnimation = 0;
  const p = current(); if (!p) return;
  const context = flatContext; if (!context) return;
  const { width, height, size, offsetX, offsetY, padding, cell } = geometry();
  if (size <= 0) return;
  const dpr = window.devicePixelRatio || 1; canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); context.setTransform(dpr, 0, 0, dpr, offsetX * dpr, offsetY * dpr);
  context.fillStyle = '#0b1219'; context.fillRect(-offsetX, -offsetY, width, height);
  context.textAlign = 'center'; context.textBaseline = 'middle'; context.font = '9px monospace';
  const center = (point: Position) => ({ x: padding + (point.x + .5) * cell, y: padding + (point.y + .5) * cell });
  for (let y = 0; y < p.level.height; y++) for (let x = 0; x < p.level.width; x++) {
    const wall = p.level.tiles[y][x] === '#';
    const radar = dist({ x, y }, p.robot.position) <= p.rules.radarRadius;
    const sensed = p.sensorCells.some(point => point.x === x && point.y === y);
    context.fillStyle = wall ? '#1d2b36' : sensed ? '#18403f' : radar ? '#11242b' : '#0f1a23';
    context.fillRect(padding + x * cell + 1, padding + y * cell + 1, cell - 2, cell - 2);
    if (wall) { context.strokeStyle = '#2a3d4b'; context.strokeRect(padding + x * cell + 4, padding + y * cell + 4, cell - 8, cell - 8); }
    if (sensed) { context.strokeStyle = '#66ddce33'; context.strokeRect(padding + x * cell + 1, padding + y * cell + 1, cell - 2, cell - 2); }
  }
  context.fillStyle = '#5a7383';
  for (let x = 0; x < p.level.width; x++) context.fillText(String(x), padding + (x + .5) * cell, 12);
  for (let y = 0; y < p.level.height; y++) context.fillText(String(y), 12, padding + (y + .5) * cell);
  const exit = center(p.level.exit), leaking = p.exitStatus === 'leaking';
  canvas.dataset.exitStatus = p.exitStatus;
  context.fillStyle = leaking ? '#8f4035' : '#2f716b'; context.fillRect(exit.x - cell * .35, exit.y - cell * .35, cell * .7, cell * .7);
  if (leaking) {
    const time = reducedMotion.matches ? 0 : performance.now() / 1050;
    for (let i = 0; i < 12; i++) {
      const phase = (time + (i % 6) / 6) % 1;
      context.fillStyle = `rgba(208,237,240,${(1 - phase) * .55})`;
      context.beginPath(); context.ellipse(exit.x + (Math.floor(i / 6) - .5) * cell * (.2 + phase * .3), exit.y - phase * cell, cell * (.08 + phase * .2), cell * (.16 + phase * .25), 0, 0, Math.PI * 2); context.fill();
    }
    if (!reducedMotion.matches && !document.hidden) flatAnimation = requestAnimationFrame(drawFlatMap);
  }
  context.fillStyle = leaking ? '#ffc0a6' : '#a1d8cc'; context.font = `${Math.max(9, cell * .24)}px monospace`; context.fillText('EXIT', exit.x, exit.y);
  p.level.rooms.forEach((room, index) => {
    const { minX, minY, maxX, maxY } = room.bounds;
    const color = `#${roomColors[index % roomColors.length].toString(16).padStart(6, '0')}`;
    const c = center(roomCenter(room));
    const labelY = maxX - minX < 2 && maxY - minY < 2 ? padding + (maxY + 1.5) * cell : c.y;
    context.font = '11px "Microsoft YaHei",sans-serif';
    const textWidth = context.measureText(room.name).width;
    context.fillStyle = '#19241fe8'; context.fillRect(c.x - textWidth / 2 - 4, labelY - 8, textWidth + 8, 16);
    context.fillStyle = color; context.fillText(room.name, c.x, labelY);
  });
  for (const echo of p.radar) {
    if (p.observed.some(e => same(e.position, echo.position) && !['cleared', 'inventory'].includes(e.state))) continue;
    const c = center(echo.position); context.strokeStyle = echo.historical ? '#6d695d' : '#f2b864'; context.setLineDash(echo.shape === 'flickering' ? [2, 3] : []);
    context.beginPath(); context.arc(c.x, c.y, cell * .17, 0, Math.PI * 2); context.stroke();
    if (echo.strength === 'strong') { context.beginPath(); context.arc(c.x, c.y, cell * .25, 0, Math.PI * 2); context.stroke(); }
    context.setLineDash([]); context.fillStyle = echo.historical ? '#7b7364' : '#f2b864'; context.font = `${Math.max(9, cell * .22)}px monospace`; context.fillText('?', c.x, c.y);
  }
  for (const e of p.observed) {
    if (['cleared', 'inventory'].includes(e.state)) continue;
    const c = center(e.position); context.globalAlpha = p.sensorCells.some(point => same(point, e.position)) ? 1 : .55;
    context.fillStyle = e.type === 'hazard' ? e.state === 'active' ? '#ef817c' : '#a39883' : e.type === 'switch' ? e.state === 'on' ? '#f2b864' : '#9fb4c3' : e.type === 'supply' ? '#66ddce' : '#9fb4c3';
    if (e.type === 'door') {
      context.save(); context.translate(c.x, c.y);
      if (e.orientation !== 'horizontal') context.rotate(Math.PI / 2);
      for (const side of [-1, 1]) context.fillRect(side * cell * .3 - cell * .06, -cell * .2, cell * .12, cell * .4);
      if (e.state !== 'opened') context.fillRect(-cell * .3, -cell * .07, cell * .6, cell * .14);
      context.restore(); context.globalAlpha = 1; continue;
    }
    context.font = `bold ${Math.max(12, cell * .4)}px monospace`;
    const symbol = e.type === 'supply' ? e.itemType === 'repair' ? '+' : e.itemType === 'oxygen' ? 'O₂' : 'B' : e.type === 'switch' ? e.state === 'on' ? '⏻' : '○' : e.type === 'cabinet' ? '▣' : e.type === 'obstacle' ? '×' : e.type === 'hazard' ? 'ϟ' : '⚙';
    context.fillText(symbol, c.x, c.y); context.globalAlpha = 1;
  }
  for (const marker of p.markers) {
    const c = center(marker.position); context.strokeStyle = marker.shared ? '#92b2fa' : '#6c7fa2';
    context.beginPath(); context.moveTo(c.x, c.y - cell * .36); context.lineTo(c.x + cell * .36, c.y); context.lineTo(c.x, c.y + cell * .36); context.lineTo(c.x - cell * .36, c.y); context.closePath(); context.stroke();
  }
  const human = center(p.human.position);
  context.fillStyle = '#f2b864'; context.beginPath(); context.arc(human.x, human.y, cell * .22, 0, Math.PI * 2); context.fill();
  context.fillStyle = '#162128'; context.font = `bold ${cell * .25}px monospace`; context.fillText('H', human.x, human.y);
  const robot = center(p.robot.position);
  context.fillStyle = '#66ddce'; const shift = p.human.carried ? cell * .15 : 0; context.fillRect(robot.x - cell * .23 + shift, robot.y - cell * .23 - shift, cell * .46, cell * .46);
  context.fillStyle = '#102126'; context.font = `bold ${cell * .26}px monospace`; context.fillText('R', robot.x + shift, robot.y - shift);
  if (selected) {
    context.strokeStyle = '#e1eaf0'; context.lineWidth = 1.5; context.strokeRect(padding + selected.x * cell + 2, padding + selected.y * cell + 2, cell - 4, cell - 4); context.lineWidth = 1;
  }
}
canvas.onclick = event => {
  const p = current(); if (!p) return;
  if (station) {
    if (!station.selectionClickAllowed(event)) return;
    const cell = station.pick(event.clientX, event.clientY);
    if (cell) { selected = cell; renderSelection(); drawMap(); openPanel('selection'); }
    return;
  }
  const { padding, cell, offsetX, offsetY } = geometry(); const box = canvas.getBoundingClientRect();
  if (cell <= 0) return;
  const x = Math.floor((event.clientX - box.left - offsetX - padding) / cell); const y = Math.floor((event.clientY - box.top - offsetY - padding) / cell);
  if (x < 0 || y < 0 || x >= p.level.width || y >= p.level.height) return;
  selected = { x, y }; renderSelection(); drawMap(); openPanel('selection');
};
new ResizeObserver(drawMap).observe(canvas);
$('map-rotate').onclick = () => station?.rotate();
$('map-zoom-in').onclick = () => station?.zoomBy(.2);
$('map-zoom-out').onclick = () => station?.zoomBy(-.2);
$('map-reset').onclick = () => station?.reset();
window.addEventListener('pagehide', event => { if (!event.persisted) station?.dispose(); });
const drawer = $<HTMLDialogElement>('console-drawer');
let drawerTrigger: HTMLElement | null = null;
const panelTitles: Record<string, string> = { nearby: '附近操作', inventory: '物资管理', status: '生命监测', objective: '救援目标', ledger: '行动记录', comms: '机器人通信', guide: '操作指南', selection: '位置情报' };
const panelCodes: Record<string, string> = { nearby: 'R-07 / LOCAL CONTROL', inventory: 'R-07 / CARGO SYSTEM', status: 'LIFE SUPPORT / TELEMETRY', objective: 'RESCUE / MISSION CONTROL', ledger: 'BLACK BOX / ACTION LOG', comms: 'R-07 / COMMUNICATION LINK', guide: 'STATION 07 / FIELD MANUAL', selection: 'STATION MAP / SECTOR INTELLIGENCE' };
function openPanel(panel: string) {
  if (!panelTitles[panel]) return;
  if (panel === 'selection') drawerTrigger = canvas;
  else if (document.activeElement instanceof HTMLElement && !drawer.contains(document.activeElement)) drawerTrigger = document.activeElement;
  drawer.dataset.panel = panel;
  $('drawer-title').textContent = panelTitles[panel];
  $('drawer-code').textContent = panelCodes[panel];
  $('drawer-icon').setAttribute('href', `#icon-${{ nearby: 'tools', inventory: 'inventory', status: 'status', objective: 'objective', ledger: 'ledger', comms: 'comms', guide: 'guide', selection: 'marker' }[panel]}`);
  document.querySelectorAll<HTMLElement>('[data-open]').forEach(trigger => { trigger.setAttribute('aria-expanded', String(trigger.dataset.open === panel)); });
  drawer.querySelectorAll<HTMLElement>('.drawer-panel').forEach(section => { section.hidden = section.dataset.panel !== panel; });
  if (!drawer.open) drawer.show();
  if (panel === 'comms') {
    $('messages').scrollTop = $('messages').scrollHeight;
    if (view?.pendingAuthorization && !frames) $('authorization-approve').focus();
    else $('command').focus();
  } else $('drawer-close').focus();
}
document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => { button.setAttribute('aria-controls', 'console-drawer'); button.setAttribute('aria-expanded', 'false'); button.onclick = () => openPanel(button.dataset.open!); });
$('drawer-close').onclick = () => drawer.close();
drawer.addEventListener('close', () => {
  document.querySelectorAll<HTMLElement>('[data-open]').forEach(trigger => { trigger.setAttribute('aria-expanded', 'false'); });
  drawerTrigger?.focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !drawer.open || document.querySelector('dialog:modal')) return;
  if (drawer.dataset.panel === 'selection' && !$('marker-form').hidden) {
    event.preventDefault(); setMarkerEditor(false); $('toggle-marker').focus(); return;
  }
  event.preventDefault(); drawer.close();
});
async function command(text: string) { if (!text.trim() || frames) return; sending = true; render(); await post('command', { text, ...(selected ? { selected } : {}) }); sending = false; render(); }
$('chat-form').onsubmit = event => { event.preventDefault(); const input = $<HTMLTextAreaElement>('command'); const text = input.value; input.value = ''; void command(text); };
$('command').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $<HTMLFormElement>('chat-form').requestSubmit(); } };
$('go-selected').onclick = () => { if (selected) { openPanel('comms'); void command(`前往 (${selected.x},${selected.y})`); } };
$('demo-rescue').onclick = () => { openPanel('comms'); void command('规则通关'); };
$('toggle-marker').onclick = () => setMarkerEditor($('marker-form').hidden === true);
$('cancel-marker').onclick = () => { setMarkerEditor(false); $('toggle-marker').focus(); };
$('clear-selection').onclick = () => { selected = null; renderSelection(); drawMap(); drawer.close(); canvas.focus(); };
$('marker-form').onsubmit = async event => {
  event.preventDefault();
  if (!selected || frames) return;
  const shared = $<HTMLInputElement>('marker-shared').checked;
  if (await post('marker', { position: selected, note: $<HTMLInputElement>('marker-note').value, shared })) {
    setMarkerEditor(false); $('toggle-marker').focus(); toast(shared ? '标记已共享给 R-07。' : '已保存仅自己可见的标记。');
  }
};
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== 'Escape' || document.querySelector('dialog[open]') || !selected) return;
  event.preventDefault();
  if (!$('marker-form').hidden) { setMarkerEditor(false); $('toggle-marker').focus(); }
  else $('clear-selection').click();
});
$('stop').onclick = () => void post('stop'); $('continue').onclick = () => void post('continue');
$('save').onclick = async () => { if (await post('save')) toast('当前进度已保存。'); };
let creatingGame = false;
async function chooseMap() {
  const dialog = $<HTMLDialogElement>('new-game-dialog');
  if (dialog.open) return;
  if (drawer.open) drawer.close();
  const select = $<HTMLSelectElement>('new-game-level');
  const apply = $<HTMLButtonElement>('new-game-apply');
  select.replaceChildren(new Option('正在读取地图…', '')); select.disabled = true; apply.disabled = true;
  $('new-game-error').hidden = true; dialog.showModal();
  try {
    const levels = await api<LevelSummary[]>('/api/levels');
    select.replaceChildren(...levels.map(level => new Option(`${level.name} · ${level.width} × ${level.height}`, level.id)));
    if (levels.some(level => level.id === view?.level.id)) select.value = view!.level.id;
    select.disabled = !levels.length; apply.disabled = !levels.length;
    if (dialog.open) select.focus();
  } catch (error) {
    select.replaceChildren(new Option('地图读取失败', ''));
    $('new-game-error').textContent = error instanceof Error ? error.message : String(error); $('new-game-error').hidden = false;
  }
}
$('new-game').onclick = () => void chooseMap();
$('new-game-close').onclick = () => { if (!creatingGame) $<HTMLDialogElement>('new-game-dialog').close(); };
$('new-game-dialog').addEventListener('cancel', event => { if (creatingGame) event.preventDefault(); });
$('new-game-form').onsubmit = async event => {
  event.preventDefault(); if (creatingGame) return;
  creatingGame = true; $<HTMLButtonElement>('new-game-apply').disabled = true; $('new-game-error').hidden = true;
  try {
    if (view?.running && !await post('stop')) return;
    attach(await api<SessionView>('/api/sessions', { levelId: $<HTMLSelectElement>('new-game-level').value }));
    $<HTMLDialogElement>('new-game-dialog').close(); toast('新的一局已准备好。');
  } catch (error) { $('new-game-error').textContent = error instanceof Error ? error.message : String(error); $('new-game-error').hidden = false; }
  finally { creatingGame = false; $<HTMLButtonElement>('new-game-apply').disabled = false; }
};
$('load').onclick = async () => {
  const open = $<HTMLButtonElement>('load');
  const dialog = $<HTMLDialogElement>('load-dialog');
  if (open.disabled || dialog.open) return;
  const select = $<HTMLSelectElement>('load-save');
  if (drawer.open) drawer.close();
  open.disabled = true; select.disabled = true; $<HTMLButtonElement>('load-apply').disabled = true;
  select.replaceChildren(new Option('正在读取存档…', ''));
  $('load-error').hidden = true; $('load-status').textContent = '正在读取存档列表…';
  $('load-count').textContent = '读取中';
  dialog.showModal();
  try {
    const saves = await api<{ id: string; modified: number }[]>('/api/saves');
    const placeholder = new Option(saves.length ? '请选择要恢复的存档' : '还没有存档', '');
    placeholder.disabled = true; placeholder.selected = true;
    select.replaceChildren(placeholder, ...saves.map(save => {
      const time = new Date(save.modified).toLocaleString('zh-CN', { hour12: false });
      return new Option(`${time} · 对局 ${save.id.slice(0, 8)}${save.id === view?.sessionId ? '（当前对局）' : ''}`, save.id);
    }));
    select.disabled = saves.length === 0;
    $('load-count').textContent = `${saves.length} 个存档`;
    $('load-status').textContent = saves.length ? `共 ${saves.length} 个存档，按保存时间从新到旧排列。` : '还没有存档，可以先保存当前进度。';
    if (dialog.open && saves.length) select.focus();
  } catch (error) {
    select.replaceChildren(new Option('读取失败', ''));
    $('load-count').textContent = '读取失败';
    $('load-status').textContent = '';
    $('load-error').textContent = error instanceof Error ? error.message : String(error); $('load-error').hidden = false;
  } finally { open.disabled = false; }
};
$('load-save').onchange = () => { $<HTMLButtonElement>('load-apply').disabled = restoringSave || !$<HTMLSelectElement>('load-save').value; };
$('load-close').onclick = () => { if (!restoringSave) $<HTMLDialogElement>('load-dialog').close(); };
$('load-dialog').addEventListener('cancel', event => { if (restoringSave) event.preventDefault(); });
$('load-form').onsubmit = async event => {
  event.preventDefault();
  const select = $<HTMLSelectElement>('load-save'); const id = select.value;
  if (!id || select.disabled || restoringSave) return;
  const apply = $<HTMLButtonElement>('load-apply'); const close = $<HTMLButtonElement>('load-close');
  restoringSave = true; select.disabled = true; apply.disabled = true; close.disabled = true;
  apply.textContent = '正在恢复…'; $('load-error').hidden = true;
  try {
    if (view?.running && !await post('stop')) throw new Error('未能停止当前任务，请重试。');
    attach(await api<SessionView>(`/api/sessions/${encodeURIComponent(id)}/load`, {}));
    $<HTMLDialogElement>('load-dialog').close(); toast('已恢复所选存档，机器人保持暂停。');
  } catch (error) {
    $('load-error').textContent = error instanceof Error ? error.message : String(error); $('load-error').hidden = false;
  } finally {
    restoringSave = false; select.disabled = false; apply.disabled = !select.value; close.disabled = false;
    apply.textContent = '恢复所选存档';
  }
};
function step(dx: number, dy: number) { if (view && !frames) void manual({ kind: 'move', target: { x: view.robot.position.x + dx, y: view.robot.position.y + dy } }); }
document.querySelectorAll<HTMLButtonElement>('[data-dx]').forEach(el => { el.onclick = () => step(Number(el.dataset.dx), Number(el.dataset.dy)); });
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || document.querySelector('dialog:modal')) return;
  if (event.target instanceof HTMLElement && (event.target.matches('input, textarea, select') || event.target.isContentEditable)) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const directions: Record<string, [number, number]> = { w: [0, -1], ArrowUp: [0, -1], a: [-1, 0], ArrowLeft: [-1, 0], s: [0, 1], ArrowDown: [0, 1], d: [1, 0], ArrowRight: [1, 0] };
  const direction = directions[event.key]; if (direction) { event.preventDefault(); if (!event.repeat) step(...direction); }
});
$('replay').onclick = async () => {
  if (!view) return;
  const session = view; const source = stream;
  try {
    if (session.running) await post('stop');
    if (!isCurrent(source, session)) return;
    const next = await api<PlayerView[]>(`/api/sessions/${session.sessionId}/replay`);
    if (!isCurrent(source, session)) return;
    frames = next; replayIndex = 0; $<HTMLInputElement>('replay-slider').max = String(frames.length - 1); $<HTMLInputElement>('replay-slider').value = '0'; render();
  }
  catch (error) { if (isCurrent(source, session)) toast(String(error)); }
};
$('exit-replay').onclick = () => { frames = null; render(); };
$('replay-slider').oninput = () => { replayIndex = Number($<HTMLInputElement>('replay-slider').value); render(); };
async function start() {
  try {
    const latest = await api<SessionView | null>('/api/latest');
    if (latest) attach(latest);
    else { $('connection').textContent = '请选择地图'; await chooseMap(); }
  } catch (error) { $('connection').textContent = '连接失败'; toast(String(error)); }
}
void start();

function updateModelFields(reset = false) {
  const provider = providers.find(p => p.id === $<HTMLSelectElement>('model-provider').value);
  if (!provider) return;
  if (reset) { $<HTMLInputElement>('model-id').value = provider.defaultModel; $<HTMLInputElement>('model-url').value = provider.baseUrl; $<HTMLInputElement>('model-key').value = ''; }
  $('model-ids').replaceChildren(...provider.models.map(id => { const option = document.createElement('option'); option.value = id; return option; }));
  $<HTMLInputElement>('model-url').readOnly = provider.id !== 'compatible';
  const retained = view?.modelReady && view.agentMode === 'live' && view.modelConfig.provider === provider.id && view.modelConfig.baseUrl === $<HTMLInputElement>('model-url').value;
  const savedDefault = modelDefaults?.ready && modelDefaults.credentialSource === 'pi' && modelDefaults.config.provider === provider.id && modelDefaults.config.baseUrl === $<HTMLInputElement>('model-url').value;
  const piCredential = savedDefault || provider.ready && provider.credentialSource === 'pi' || (provider.id === 'compatible' && /^https:\/\/api\.deepseek\.com(?:\/|$)/.test($<HTMLInputElement>('model-url').value) && providers.some(p => p.id === 'deepseek' && p.ready && p.credentialSource === 'pi'));
  const remembered = modelDefaults?.ready && modelDefaults.credentialSource === 'manual' && modelDefaults.config.provider === provider.id && modelDefaults.config.baseUrl === $<HTMLInputElement>('model-url').value;
  $('model-key-hint').textContent = remembered || retained && view?.modelCredentialSource === 'manual' ? '已保存此接口的密钥，留空沿用；重启后自动复用。' : piCredential ? '已找到本机 pi 凭据，留空自动复用。' : provider.ready ? '服务端已有此服务的环境凭据，可以留空。' : retained ? '当前会话已有可用凭据，可以留空。' : '填写密钥后应用即可保存，以后自动复用；也可使用已有 pi 登录凭据。';
  $('live-settings').hidden = $<HTMLSelectElement>('model-mode').value !== 'live';
}
function fillModelFields(config: ModelConfig) {
  modelFormConfig = config;
  $<HTMLSelectElement>('model-mode').value = config.mode;
  $<HTMLSelectElement>('model-provider').value = config.provider;
  $<HTMLInputElement>('model-id').value = config.modelId;
  $<HTMLInputElement>('model-url').value = config.baseUrl;
  $<HTMLInputElement>('model-timeout').value = String(config.timeoutMs);
  $<HTMLInputElement>('model-tokens').value = String(config.maxTokens);
  $<HTMLInputElement>('model-key').value = '';
  updateModelFields();
}
$('model-settings').onclick = async () => {
  if (!view) return;
  try {
    [providers, modelDefaults] = await Promise.all([api<Awaited<ReturnType<typeof modelCatalog>>>('/api/models'), api<ModelPreferencesView>('/api/model-settings')]);
    $('model-provider').replaceChildren(...providers.map(p => { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; return option; }));
    $('model-default-summary').textContent = `新局默认：${modelDefaults.config.mode === 'demo' ? '本地规则演示' : `${modelDefaults.config.provider} / ${modelDefaults.config.modelId}${modelDefaults.ready ? '' : ' · 待补充凭据'}`}`;
    fillModelFields(view.modelConfig);
    $('model-form-error').hidden = true;
    updateModelFields(); $<HTMLDialogElement>('model-dialog').showModal();
  } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
};
$('model-use-default').onclick = () => { if (modelDefaults) fillModelFields(modelDefaults.config); };
$('model-provider').onchange = () => updateModelFields(true);
$('model-mode').onchange = () => updateModelFields();
$('model-url').oninput = () => updateModelFields();
$('model-close').onclick = () => $<HTMLDialogElement>('model-dialog').close();
$('model-dialog').addEventListener('close', () => { $<HTMLInputElement>('model-key').value = ''; });
$('model-form').onsubmit = async event => {
  event.preventDefault(); if (!view) return;
  const session = view; const source = stream;
  const config: ModelConfig = {
    mode: $<HTMLSelectElement>('model-mode').value as ModelConfig['mode'],
    provider: $<HTMLSelectElement>('model-provider').value as ModelConfig['provider'],
    modelId: $<HTMLInputElement>('model-id').value.trim(), baseUrl: $<HTMLInputElement>('model-url').value.trim(),
    timeoutMs: Number($<HTMLInputElement>('model-timeout').value), maxTokens: Number($<HTMLInputElement>('model-tokens').value),
  };
  // Demo can always be selected, including an unfinished custom endpoint form.
  const applied = config.mode === 'demo' ? { ...(modelFormConfig ?? view.modelConfig), mode: 'demo' } : config;
  const apply = $<HTMLButtonElement>('model-apply'); apply.disabled = true; $('model-form-error').hidden = true;
  try {
    const next = await api<SessionView>(`/api/sessions/${session.sessionId}/model`, { requestId: crypto.randomUUID(), config: applied, apiKey: $<HTMLInputElement>('model-key').value });
    if (!isCurrent(source, session)) return;
    accept(next); $<HTMLDialogElement>('model-dialog').close(); toast('模型设置已应用并记为新局默认。');
  } catch (error) { if (isCurrent(source, session)) { $('model-form-error').textContent = error instanceof Error ? error.message : String(error); $('model-form-error').hidden = false; } }
  finally { apply.disabled = false; }
};

function renderMessages() {
  if (!view) return;
  const pending = frames ? null : view?.pendingAuthorization;
  $('comms-notice').hidden = !pending;
  document.querySelectorAll<HTMLButtonElement>('[data-open="comms"]').forEach(button => {
    button.classList.toggle('needs-authorization', !!pending);
    button.setAttribute('aria-label', pending ? '机器人通信 · 待授权' : '机器人通信');
  });
  const messageKey = JSON.stringify([view.messages, pending?.id, !!frames, answeringAuthorization]);
  if (messageKey === lastMessages) return;
  const area = $('messages');
  const pinned = area.scrollHeight - area.scrollTop - area.clientHeight < 70;
  const scrollTop = area.scrollTop;
  const oldAuthorization = area.querySelector<HTMLElement>('[data-authorization-id]')?.dataset.authorizationId;
  const expandedTools = new Set(lastMessages ? [...area.querySelectorAll<HTMLDetailsElement>('.tool-details[open]')].map(el => el.dataset.messageId) : []);
  const authorizationMessage = pending ? view.messages.findLast(message => message.role === 'robot' && message.text === pending.description) : undefined;
  area.replaceChildren();
  const addAuthorization = (el: HTMLElement) => {
    if (!pending) return;
    el.classList.add('authorization-message'); el.dataset.authorizationId = pending.id;
    const consequence = document.createElement('p'); consequence.id = 'authorization-consequence'; consequence.className = 'authorization-consequence'; consequence.textContent = pending.consequence;
    const hint = document.createElement('p'); hint.className = 'authorization-hint'; hint.textContent = '等待不消耗资源。授权仅对当前操作有效。';
    const actions = document.createElement('div'); actions.className = 'authorization-buttons';
    for (const [approve, label] of [[true, '授权并继续'], [false, '拒绝，重新决策']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.id = approve ? 'authorization-approve' : 'authorization-deny'; button.textContent = label;
      if (approve) button.className = 'primary'; button.disabled = answeringAuthorization;
      button.onclick = () => void answerAuthorization(approve, pending.id); actions.append(button);
    }
    el.append(consequence, hint, actions);
  };
  for (const message of view.messages) {
    const el = document.createElement('div'); el.className = `message ${message.role}${message.kind ? ` ${message.kind}` : ''}`;
    const label = document.createElement('small'); label.textContent = `${message.role === 'human' ? '你' : message.role === 'robot' ? 'R-07' : '系统'}${message.kind === 'tool' ? ' · 工具调用' : ''} / ${message.at} TU`;
    let content: HTMLElement = el;
    if (message.tool) {
      const statuses = { queued: '待执行', running: '处理中', waiting: '等待玩家决定', done: '已完成', partial: '部分执行，未到达目标', failed: '执行失败', skipped: '未执行', cancelled: '已取消' };
      const details = document.createElement('details'); details.className = 'tool-details'; details.dataset.messageId = message.id; details.open = expandedTools.has(message.id);
      const summary = document.createElement('summary');
      const title = document.createElement('strong'); title.textContent = `${message.tool.name} · ${statuses[message.tool.status]}`;
      const args = document.createElement('pre'); args.className = 'tool-arguments'; args.textContent = JSON.stringify(message.tool.arguments, null, 2);
      summary.append(title); details.append(summary, label, args); el.append(details); content = details;
    } else el.append(label);
    if (message.text) { const text = document.createElement('span'); text.textContent = message.text; content.append(text); }
    if (message.id === authorizationMessage?.id) addAuthorization(el);
    area.append(el);
  }
  if (pending && !authorizationMessage) {
    const el = document.createElement('div'); el.className = 'message robot';
    const label = document.createElement('small'); label.textContent = 'R-07 / 等待授权';
    const text = document.createElement('span'); text.textContent = pending.description; el.append(label, text); addAuthorization(el); area.append(el);
  }
  if (pinned || !lastMessages || pending && pending.id !== oldAuthorization) area.scrollTop = area.scrollHeight;
  else area.scrollTop = scrollTop;
  lastMessages = messageKey;
}
async function answerAuthorization(approve: boolean, authorizationId: string) {
  const pending = view?.pendingAuthorization; if (!pending || pending.id !== authorizationId || frames || answeringAuthorization) return;
  answeringAuthorization = true; renderMessages();
  try { await post('authorize', { authorizationId: pending.id, approve }); }
  finally { answeringAuthorization = false; renderMessages(); }
}
