import type { SessionView } from '../../server/src/session.ts';
import type { ModelConfig, modelCatalog } from '../../server/src/model.ts';
import type { ModelPreferencesView } from '../../server/src/model-preferences.ts';
import type { Action, ObservedEntity, PlayerView, Position } from '../../../packages/game-core/src/types.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('map');
const context = canvas.getContext('2d')!;
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
function accept(next: SessionView) {
  if (view && next.sessionId === view.sessionId && next.eventId < view.eventId) return;
  view = next; render();
}
function attach(next: SessionView) {
  stream?.close(); frames = null; selected = null; lastMessages = ''; markerEditorKey = ''; view = null; accept(next);
  stream = new EventSource(`/api/sessions/${next.sessionId}/events`);
  stream.onopen = () => { $('connection').textContent = '通信正常'; $('connection').style.color = '#66ddce'; };
  stream.onmessage = event => accept(JSON.parse(event.data));
  stream.onerror = () => { $('connection').textContent = '通信重连中'; $('connection').style.color = '#f2b864'; };
}
async function post(operation: string, payload: Record<string, unknown> = {}) {
  if (!view) return false;
  try { const next = await api<SessionView>(`/api/sessions/${view.sessionId}/${operation}`, { requestId: crypto.randomUUID(), expectedRevision: view.stateRevision, ...payload }); accept(next); return true; }
  catch (error) {
    toast(error instanceof Error ? error.message : String(error));
    try { accept(await api<SessionView>(`/api/sessions/${view.sessionId}`)); } catch { /* SSE will reconnect. */ }
    return false;
  }
}
async function manual(action: Action) { if (!frames) await post('action', { action }); }
function button(label: string, action: Action) {
  const el = document.createElement('button'); el.textContent = label;
  el.disabled = !!frames || !view || ['success', 'failure'].includes(view.phase);
  el.onclick = () => void manual(action); return el;
}
function itemTitle(item: ObservedEntity) { return `${item.itemType === 'battery' ? '▥' : item.itemType === 'oxygen' ? 'O₂' : '＋'} ${item.name}`; }
function render() {
  if (!view) return;
  const p = current()!;
  const terminal = ['success', 'failure'].includes(p.phase);
  $('level-name').textContent = p.level.name;
  $('clock').textContent = `${String(p.elapsedTU).padStart(2, '0')} TU${frames ? ' / 回放' : ''}`;
  $('oxygen-value').textContent = String(p.human.oxygen);
  $('battery-value').textContent = String(p.robot.battery);
  $('oxygen-bar').style.width = `${p.human.oxygen / p.rules.oxygenMax * 100}%`;
  $('battery-bar').style.width = `${p.robot.battery / p.rules.batteryMax * 100}%`;
  $('oxygen-bar').style.background = p.human.oxygen < 25 ? '#ef817c' : '#66ddce';
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
    if (!item) { slot.classList.add('empty'); slot.textContent = `${String(i + 1).padStart(2, '0')} / 空置`; }
    else {
      const name = document.createElement('span'); name.textContent = itemTitle(item); slot.append(name);
      if (item.itemType === 'battery') slot.append(button('安装', { kind: 'use_item', itemId: item.id, targetId: 'robot' }));
      if (item.itemType === 'oxygen' && dist(p.human.position, p.robot.position) <= 1) slot.append(button('补氧', { kind: 'use_item', itemId: item.id, targetId: 'human' }));
      slot.append(button('放下', { kind: 'drop_item', itemId: item.id }));
    }
    $('inventory').append(slot);
  }
  $('nearby').replaceChildren();
  const near = p.observed.filter(e => !['cleared', 'inventory'].includes(e.state) && p.sensorCells.some(cell => same(cell, e.position)) && dist(e.position, p.robot.position) <= 1);
  for (const e of near) {
    const group = document.createElement('div'); group.className = 'action-group';
    const title = document.createElement('p'); title.textContent = `${e.name} · ${stateNames[e.state] ?? e.state}`; group.append(title);
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
  document.querySelectorAll<HTMLButtonElement>('[data-dx]').forEach(el => { el.disabled = terminal || !!frames; });
  const task = view.task;
  $('task').replaceChildren();
  const taskLabel = document.createElement('span'); taskLabel.className = 'tiny'; taskLabel.textContent = `当前委托 / ${task ? { active: '执行中', paused: '暂停', waiting: '待决定', completed: '已完成' }[task.status] : '待命'}`;
  const taskText = document.createElement('p'); taskText.textContent = task?.text ?? '等待你的指令。'; $('task').append(taskLabel, taskText);
  if (task?.question) { const question = document.createElement('p'); question.className = 'question'; question.textContent = task.question; $('task').append(question); }
  $<HTMLButtonElement>('continue').disabled = !!frames || terminal || view.running || !task || task.status === 'completed';
  $<HTMLButtonElement>('stop').disabled = !!frames || terminal || !view.running;
  $<HTMLButtonElement>('send').disabled = !!frames || terminal || sending;
  renderMessages();
  const m = view.metrics; $('metrics').textContent = `模型请求 ${m.requests} / 工具 ${m.executedTools} / 跳过 ${m.skippedTools} / 中断 ${m.interrupts}\nTokens ${m.inputTokens} in · ${m.outputTokens} out / 结果 ${(m.resultBytes / 1024).toFixed(1)} KB`;
  $('ledger').replaceChildren();
  for (const entry of [...p.ledger].reverse()) {
    const row = document.createElement('div'); row.className = 'ledger-entry';
    const time = document.createElement('span'); time.className = 'tu'; time.textContent = `${entry.elapsedTU} TU`;
    const title = document.createElement('span'); title.textContent = entry.message;
    const cost = document.createElement('span'); cost.className = 'cost'; cost.textContent = `O₂ −${entry.cost.oxygen} / B −${entry.cost.battery}`;
    row.append(time, title, cost); $('ledger').append(row);
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
  $<HTMLButtonElement>('go-selected').disabled = !selected || !!frames || ['success', 'failure'].includes(p.phase);
  $<HTMLButtonElement>('add-marker').disabled = !selected || !!frames;
  const markers = selected ? p.markers.filter(marker => same(marker.position, selected!)) : [];
  $('selection-markers').hidden = markers.length === 0;
  $('selection-markers').textContent = markers.map(marker => `标记（${marker.shared ? '已共享' : '仅自己可见'}）：${marker.note || '未填写说明'}`).join('\n');
  const editorKey = JSON.stringify([view?.sessionId, selected, !!frames, markers]);
  // Refresh on a different cell or saved marker, while preserving drafts during telemetry updates.
  if (editorKey !== markerEditorKey) {
    const latest = markers.at(-1);
    $<HTMLInputElement>('marker-note').value = latest?.note ?? '';
    $<HTMLInputElement>('marker-shared').checked = latest?.shared ?? true;
    markerEditorKey = editorKey;
  }
  $<HTMLInputElement>('marker-note').disabled = !selected || !!frames;
  $<HTMLInputElement>('marker-shared').disabled = !selected || !!frames;
  if (!selected) { $('selection-title').textContent = '选择一个回波或格子'; $('selection-detail').textContent = '雷达显示较远的信号；靠近后才能确认对象。'; return; }
  const object = p.observed.find(e => same(e.position, selected!) && !['cleared', 'inventory'].includes(e.state));
  const echo = p.radar.find(e => same(e.position, selected!));
  $('selection-title').textContent = `(${selected.x}, ${selected.y}) · ${object?.name ?? (echo ? '未知雷达回波' : p.level.tiles[selected.y][selected.x] === '#' ? '历史图上的墙体' : '历史图上的地面')}`;
  $('selection-detail').textContent = object ? `${stateNames[object.state]} / 最近观察 ${object.observedAt} TU${object.details ? ` · ${object.details}` : ' · 靠近后可进一步检查'}` : echo ? `${echo.strength === 'strong' ? '强' : '弱'}信号 / ${echo.shape === 'flickering' ? '闪烁' : '稳定'} / ${echo.historical ? '历史回波，当前未覆盖' : '当前雷达覆盖'}；具体对象未知。` : '选中的位置尚无确认对象；地图记录可能已过时。';
}
function geometry() {
  const { width, height } = canvas.getBoundingClientRect();
  const size = Math.min(width, height);
  const padding = Math.min(25, size * .07);
  return { width, height, size, offsetX: (width - size) / 2, offsetY: (height - size) / 2, padding, cell: (size - padding * 2) / 12 };
}
function drawMap() {
  const p = current(); if (!p) return;
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
  for (let i = 0; i < 12; i++) { context.fillText(String(i), padding + (i + .5) * cell, 12); context.fillText(String(i), 12, padding + (i + .5) * cell); }
  const exit = center(p.level.exit); context.fillStyle = '#2f716b'; context.fillRect(exit.x - cell * .35, exit.y - cell * .35, cell * .7, cell * .7); context.fillStyle = '#a1d8cc'; context.font = `${Math.max(9, cell * .24)}px monospace`; context.fillText('EXIT', exit.x, exit.y);
  for (const room of p.level.rooms) {
    if (cell < 35) continue;
    const c = center(room.position); context.fillStyle = '#7c9caa66'; context.font = '9px "Microsoft YaHei",sans-serif'; context.fillText(room.name, c.x, c.y + cell * .35);
  }
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
    context.font = `bold ${Math.max(12, cell * .4)}px monospace`;
    const symbol = e.type === 'supply' ? e.itemType === 'repair' ? '+' : e.itemType === 'oxygen' ? 'O₂' : 'B' : e.type === 'switch' ? e.state === 'on' ? '⏻' : '○' : e.type === 'door' ? e.state === 'opened' ? '╌' : '▥' : e.type === 'cabinet' ? '▣' : e.type === 'obstacle' ? '×' : e.type === 'hazard' ? 'ϟ' : '⚙';
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
  const { padding, cell, offsetX, offsetY } = geometry(); const box = canvas.getBoundingClientRect();
  if (cell <= 0) return;
  const x = Math.floor((event.clientX - box.left - offsetX - padding) / cell); const y = Math.floor((event.clientY - box.top - offsetY - padding) / cell);
  if (x < 0 || y < 0 || x >= 12 || y >= 12) return;
  selected = { x, y }; renderSelection(); drawMap();
};
new ResizeObserver(drawMap).observe(canvas);
document.querySelectorAll<HTMLButtonElement>('.workspace-tabs [data-pane]').forEach(button => {
  button.onclick = () => {
    document.querySelector<HTMLElement>('.shell')!.dataset.pane = button.dataset.pane;
    document.querySelectorAll<HTMLButtonElement>('.workspace-tabs [data-pane]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
    if (button.dataset.pane === 'comms' && view?.pendingAuthorization && !frames) $('messages').scrollTop = $('messages').scrollHeight;
  };
});
async function command(text: string) { if (!text.trim() || frames) return; sending = true; render(); await post('command', { text, ...(selected ? { selected } : {}) }); sending = false; render(); }
$('chat-form').onsubmit = event => { event.preventDefault(); const input = $<HTMLTextAreaElement>('command'); const text = input.value; input.value = ''; void command(text); };
$('command').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $<HTMLFormElement>('chat-form').requestSubmit(); } };
$('go-selected').onclick = () => { if (selected) void command(`前往 (${selected.x},${selected.y})`); };
$('marker-form').onsubmit = event => { event.preventDefault(); if (selected && !frames) void post('marker', { position: selected, note: $<HTMLInputElement>('marker-note').value, shared: $<HTMLInputElement>('marker-shared').checked }); };
$('stop').onclick = () => void post('stop'); $('continue').onclick = () => void post('continue');
$('save').onclick = async () => { if (await post('save')) toast('当前进度已保存。'); };
$('new-game').onclick = async () => { try { if (view?.running) await post('stop'); attach(await api<SessionView>('/api/sessions', {})); toast('新的一局已准备好。'); } catch (error) { toast(String(error)); } };
$('load').onclick = async () => {
  const open = $<HTMLButtonElement>('load');
  const dialog = $<HTMLDialogElement>('load-dialog');
  if (open.disabled || dialog.open) return;
  const select = $<HTMLSelectElement>('load-save');
  open.disabled = true; select.disabled = true; $<HTMLButtonElement>('load-apply').disabled = true;
  select.replaceChildren(new Option('正在读取存档…', ''));
  $('load-error').hidden = true; $('load-status').textContent = '正在读取存档列表…';
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
    $('load-status').textContent = saves.length ? `共 ${saves.length} 个存档，按保存时间从新到旧排列。` : '还没有存档，可以先保存当前进度。';
    if (dialog.open && saves.length) select.focus();
  } catch (error) {
    select.replaceChildren(new Option('读取失败', ''));
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
  if (document.querySelector('dialog[open]')) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.ctrlKey || event.altKey || event.metaKey) return;
  const directions: Record<string, [number, number]> = { w: [0, -1], ArrowUp: [0, -1], a: [-1, 0], ArrowLeft: [-1, 0], s: [0, 1], ArrowDown: [0, 1], d: [1, 0], ArrowRight: [1, 0] };
  const direction = directions[event.key]; if (direction) { event.preventDefault(); if (!event.repeat) step(...direction); }
});
$('replay').onclick = async () => {
  if (!view) return;
  try { if (view.running) await post('stop'); frames = await api<PlayerView[]>(`/api/sessions/${view.sessionId}/replay`); replayIndex = 0; $<HTMLInputElement>('replay-slider').max = String(frames.length - 1); $<HTMLInputElement>('replay-slider').value = '0'; render(); }
  catch (error) { toast(String(error)); }
};
$('exit-replay').onclick = () => { frames = null; render(); };
$('replay-slider').oninput = () => { replayIndex = Number($<HTMLInputElement>('replay-slider').value); render(); };
async function start() { try { attach(await api<SessionView | null>('/api/latest') ?? await api<SessionView>('/api/sessions', {})); } catch (error) { $('connection').textContent = '连接失败'; toast(String(error)); } }
void start();

function updateModelFields(reset = false) {
  const provider = providers.find(p => p.id === $<HTMLSelectElement>('model-provider').value);
  if (!provider) return;
  if (reset) { $<HTMLInputElement>('model-id').value = provider.defaultModel; $<HTMLInputElement>('model-url').value = provider.baseUrl; $<HTMLInputElement>('model-key').value = ''; }
  $('model-ids').replaceChildren(...provider.models.map(id => { const option = document.createElement('option'); option.value = id; return option; }));
  $<HTMLInputElement>('model-url').readOnly = provider.id !== 'compatible';
  const retained = view?.modelReady && view.agentMode === 'live' && view.modelConfig.provider === provider.id && view.modelConfig.baseUrl === $<HTMLInputElement>('model-url').value;
  const piCredential = provider.ready && provider.credentialSource === 'pi' || (provider.id === 'compatible' && /^https:\/\/api\.deepseek\.com(?:\/|$)/.test($<HTMLInputElement>('model-url').value) && providers.some(p => p.id === 'deepseek' && p.ready && p.credentialSource === 'pi'));
  const remembered = modelDefaults?.ready && modelDefaults.credentialSource === 'manual' && modelDefaults.config.provider === provider.id && modelDefaults.config.baseUrl === $<HTMLInputElement>('model-url').value;
  $('model-key-hint').textContent = remembered || retained && view?.modelCredentialSource === 'manual' ? '本次服务已记住此接口的覆盖密钥，留空沿用；新局也会自动复用。' : piCredential ? '已找到本机 pi 凭据，留空自动复用。' : provider.ready ? '服务端已有此服务的环境凭据，可以留空。' : retained ? '当前会话已有可用凭据，可以留空。' : '暂无可用凭据，可在 pi 中登录或配置 API Key，也可在此填写密钥。';
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
    const next = await api<SessionView>(`/api/sessions/${view.sessionId}/model`, { requestId: crypto.randomUUID(), config: applied, apiKey: $<HTMLInputElement>('model-key').value });
    accept(next); $<HTMLDialogElement>('model-dialog').close(); toast('模型设置已应用并记为新局默认。');
  } catch (error) { $('model-form-error').textContent = error instanceof Error ? error.message : String(error); $('model-form-error').hidden = false; }
  finally { apply.disabled = false; }
};

function renderMessages() {
  if (!view) return;
  const pending = frames ? null : view?.pendingAuthorization;
  const tab = document.querySelector<HTMLButtonElement>('.workspace-tabs button[data-pane="comms"]')!;
  tab.textContent = pending ? '通信 · 待授权' : '机器人通信';
  tab.classList.toggle('needs-authorization', !!pending);
  const messageKey = JSON.stringify([view.messages, pending?.id, !!frames, answeringAuthorization]);
  if (messageKey === lastMessages) return;
  const area = $('messages');
  const pinned = area.scrollHeight - area.scrollTop - area.clientHeight < 70;
  const scrollTop = area.scrollTop;
  const oldAuthorization = area.querySelector<HTMLElement>('[data-authorization-id]')?.dataset.authorizationId;
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
    el.append(label);
    if (message.tool) {
      const statuses = { queued: '待执行', running: '处理中', waiting: '等待玩家决定', done: '已完成', partial: '部分执行，未到达目标', failed: '执行失败', skipped: '未执行', cancelled: '已取消' };
      const title = document.createElement('strong'); title.textContent = `${message.tool.name} · ${statuses[message.tool.status]}`;
      const args = document.createElement('pre'); args.className = 'tool-arguments'; args.textContent = JSON.stringify(message.tool.arguments, null, 2);
      el.append(title, args);
    }
    if (message.text) { const text = document.createElement('span'); text.textContent = message.text; el.append(text); }
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
