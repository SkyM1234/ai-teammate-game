import { Agent } from '../../../../pi-main/packages/agent/dist/index.js';
import { isDeepStrictEqual } from 'node:util';
import { Type } from '../../../../pi-main/packages/ai/dist/index.js';
import type { AgentMessage, AgentTool } from '../../../../pi-main/packages/agent/dist/index.js';
import { toToolDeclaration } from '../../../../pi-main/packages/ai/dist/utils/transcript.js';
import { defaultConstraints, diffKnowledge, GameEngine } from '../../../packages/game-core/src/engine.ts';
import { sensorCells } from '../../../packages/game-core/src/navigation.ts';
import { distance, emptyDelta, samePosition } from '../../../packages/game-core/src/types.ts';
import type { Action, ActionOutcome, Constraints, Cost, GameState, Knowledge, Level, ObservationDelta, ObservedEntity, PlayerView, Position } from '../../../packages/game-core/src/types.ts';
import { demoModel, toolStream, defaultModelConfig, validateModelConfig, liveModel, modelErrorMessage } from './model.ts';
import type { CredentialSource } from './credentials.ts';
import type { ModelAdapter, ModelConfig, ToolIntent } from './model.ts';
import { SessionJournal } from './journal.ts';
import { demoHelp, parseDemoCommand } from './demo-task.ts';
import type { DemoGoal } from './demo-task.ts';

type Control = 'continue' | 'redecide' | 'wait_player' | 'task_done' | 'game_over';
export interface ChatMessage {
  id: string; role: 'human' | 'robot' | 'system'; text: string; at: number;
  kind?: 'tool';
  tool?: { id: string; name: string; arguments: Record<string, unknown>; status: 'queued' | 'running' | 'waiting' | 'done' | 'partial' | 'failed' | 'skipped' | 'cancelled' };
}
export interface Task {
  id: string; text: string; selected?: Position; interpretation: 'model' | 'demo';
  goal?: DemoGoal; demoSupported?: boolean;
  status: 'active' | 'paused' | 'waiting' | 'completed'; question: string | null;
  waitReason?: 'power' | 'hazard' | 'decision' | 'authorization' | 'route'; constraints: Constraints;
}
export interface PendingAuthorization {
  id: string; toolName: string; arguments: Record<string, unknown>; kind: 'repair' | 'drop' | 'hazard' | 'power';
  description: string; consequence: string; stateRevision: number; hazardIds?: string[];
  route?: MoveRoute;
}
export interface PendingRouteSelection {
  id: string; target: Position; options: MoveRoute[]; stateRevision: number;
}
type AuthorizationDecision = 'approve' | 'deny' | 'cancel' | 'stale';
export interface Metrics { requests: number; executedTools: number; skippedTools: number; inputTokens: number; outputTokens: number; resultBytes: number; interrupts: number }
export interface SessionView extends PlayerView {
  sessionId: string; sessionInstanceId: string; eventId: number; task: Task | null; messages: ChatMessage[]; metrics: Metrics; demoRescueAvailable: boolean;
  agentMode: ModelAdapter['mode']; agentLabel: string; running: boolean;
  modelConfig: ModelConfig; modelReady: boolean; modelError: string | null; modelCredentialSource: CredentialSource;
  pendingAuthorization: PendingAuthorization | null;
  pendingRouteSelection: PendingRouteSelection | null;
}
interface TaskMemory {
  startSequence: number; initialKnownEntityIds: string[];
  recentFailures: { tool: string; arguments: Record<string, unknown>; position: Position; elapsedTU: number; code: string; message: string }[];
}
export interface SessionSave { version: 1; id: string; level?: Level; engine: GameState; task: Task | null; taskMemory?: TaskMemory; messages: ChatMessage[]; metrics: Metrics; eventId: number; modelConfig?: ModelConfig }
interface ToolOutcome {
  accepted: boolean; code: string; message: string; delta: ObservationDelta;
  executedSteps?: number; targetReached?: boolean; costTU: number;
}
export interface MoveRoute {
  choice: 'safe' | 'shortest'; path: Position[]; steps: number; estimatedCost: Cost;
  withinRemainingTU: boolean; hazardIds: string[]; requiresAuthorization: boolean;
}
export class RevisionConflictError extends Error {}

const interactionUsage: Record<string, string> = {
  open: '需要 targetId（已知门或柜子的 ID）',
  collect: '需要 targetId（state=available 的已知物资 ID）；inventory 已在背包，cleared 已消耗，均不可再次拾取',
  drop_item: '需要 itemId（背包物品的 ID），不需要 targetId',
  use_item: '必须同时提供 itemId（背包物品的 ID）和 targetId（只能为 "human" 或 "robot"；氧气补给用 "human"，备用电池用 "robot"），不能把物品 ID 当作 targetId',
  repair: '需要 targetId（修补玩家供氧管用 "human"，修复气闸用已知气闸 ID）；自动消耗背包维修材料，不需要 itemId',
  clear: '需要 targetId（已知障碍的 ID）',
  pickup_human: '与玩家同格且 telemetry.human.carried=false 时抱起玩家，不需要 targetId 或 itemId；carried=true 时跳过此步',
  drop_human: '放下玩家，不需要 targetId 或 itemId',
  extract: '启动撤离，不需要 targetId 或 itemId',
};

const prompt = `你是救援机器人 R-07。人类受伤不能移动，氧气有限，你有电量限制。只使用收到的机器人知识和人类明确发送的信息；雷达模糊回波不是物品身份。
本次请求的系统快照优先于其中的历史对话、历史工具结果及此前推测；本次请求内新执行的工具结果会更新状态，telemetry.elapsedTU 是游戏时间。telemetry.human 提供玩家位置、氧气、耗氧率和 carried；telemetry.robot 提供机器人位置、电量和带 id/name/itemType 的背包。carried=true 表示玩家已由你搬运，位置随你移动，跳过 pickup_human，无需放下玩家也可使用物资或维修；carried=false 时才需要同格抱起。
物资以当前 state 和 itemType 为准：available 可前往拾取，inventory 已在背包，cleared 已消耗且不能再次拾取或使用；背包与已耗尽物资在 knownEntities 中的 position 是历史位置，不代表仍可在那里取得。itemType=oxygen 用 use_item 给 human，battery 给 robot，repair 只能由 repair 自动消耗。补氧应选择背包中的氧气或已知 available 氧气，不能去已耗尽的旧位置。类型、数量和可用性已知时无需额外扫描或 get_status 确认。
historicalMap 是事故前的历史布局。坐标从 0 开始，左上角为 (0,0)，x 向右增大，y 向下增大；tiles[y][x] 表示坐标 (x,y) 的格子，每个字符串是一整行，数组索引是 y，字符串字符索引是 x。图例：# 是墙，不可通行；. 是历史地面，可作为候选路线；D 是历史门位，当前开闭与供电状态需靠近确认；X 是历史障碍位，不代表永久不可通行；E 是撤离出口，能到达不等于满足撤离条件。rooms 用 name 和 bounds 描述历史区域，minX/minY/maxX/maxY 均包含端点，没有固定导航点；范围内的墙体和实际阻挡仍以 tiles 和最新观察为准，不提供当前设施状态或可交互实体 ID。前往区域时可选择其中合适的可达位置，抵达不等于完成物资搜索；各区域属于固定历史位置，不随玩家搬运移动。
当前设施状态以 knownEntities 和最新工具结果为准，优先于历史地图符号及此前的推测：障碍 state=cleared 表示已清除，不再阻挡；门 state=opened 表示已打开，可以通过；已知关闭的门、未清除的障碍仍阻挡移动。柜体（cabinet）、气闸控制器（airlock）和辅助电路开关（switch）所在格均不可进入或穿越，开启、修复或通断电均不会解除阻挡，空载和搬运时都适用；识别后需要交互时，move_to 的目标应选择可达的相邻格，不要选择设施所在格。历史可通行格可能存在尚未发现的阻挡或危险，需以逐格执行结果确认；不要把未知状态直接判为无路。
移动只能走上下左右，交互通常要求上下左右相邻或同格：曼哈顿距离 |dx|+|dy|≤1，斜对角不算相邻。抱起玩家必须同格。knownEntities[].interaction 提供与已知位置的 distance、inSensorRange、canScan 和不可检查原因 reason；canScan 只说明当前是否满足检查条件，不代表已满足开柜供电、维修材料或授权等其他动作条件。背包和已消耗对象的距离仍基于历史位置，不应据此前往。超距失败后应根据坐标、距离和原因纠正，不要在另一斜对角重复尝试。
interaction.approachPositions 列出按当前已知地图可到达、可观察该对象且满足交互距离的位置，每项含 position 和预计移动步数 steps，按步数升序排列；靠近已知对象时优先从中选择 move_to 目标，steps=0 表示已在该位置。候选排除墙、已知阻挡、喷气出口和需要危险授权的路线，不保证未知情况不会中断移动，也不表示供电、材料或其他动作条件已满足。空列表表示当前已知条件下没有此类候选；背包和已消耗、已清除对象不提供候选，不要据此认定永远无法接近。
exitStatus 是玩家与机器人共享的出口实时状态：leaking 表示出口正在漏气喷射，出口这一格禁止进入或穿越，搬运与危险授权均不能绕过；safe 表示修复气闸后漏气已停止，出口恢复通行。出口位置仍以 historicalMap.exit 为准，气闸控制器的位置与 ID 必须靠近识别，不能由出口位置推断。需先寻找气闸控制器、取得维修材料并修复，再把人类搬到出口并 interact extract；前往出口附近可选择可达的安全相邻格，不要将出口漏气误判为整个附近区域不可达。
move_to 会根据历史布局和已知阻挡自动寻路，可以直接传最终目标坐标，无需手算路线或拆成沿途中间坐标；只有玩家指定途经点或确有必要时才分段。单次 move_to 没有格数上限，但逐格检查关键发现、资源和本次自动运行的剩余 TU 预算，可能中途停止；预算由本次自动运行内的多轮模型请求共同累计，并非每轮模型调用重置。移动结果以 targetReached 和 telemetry.robot.position 为准；精确坐标目标 targetReached=false 时尚未抵达，不得当作完成。TARGET_WALL 表示目标本身是墙，更换起点或中间点不能解决；TARGET_BLOCKED 应按原因开门、清障或选择设施相邻格，关闭的门可以打开后通过，不等同于柜体等固定阻挡。
move_to 发现多条候选路线时，程序会在前端地图显示路径和预计消耗，等待玩家选定；只有一条路线时直接采用。选择期间不消耗游戏资源或新增模型请求，随后在原工具调用中检查危险授权并沿选定路径执行。预计消耗仅依据历史布局、已知设施和当前搬运状态，未知阻挡或危险仍可能改变实际情况。模型只传目标，不选择路线，也不要用 ask_player 代替地图选路或危险授权；玩家停止运行或拒绝危险穿越后，立即取消委托，不能继续旧任务，必须重新下达指令。任何普通移动或选定路线的移动，途中首次发现剩余选定路径上未清除的障碍、关闭的门或未经授权的带电危险时才停止运行并取消委托，不再请求模型重新决策、换路或申请后续授权，必须重新下达指令。路旁、已经走过的位置、目标之外的物体，以及不影响通行的已清除障碍、已打开门或无须新授权的线路不会因此中断移动；仍记录这些新发现。NEW_OBSTACLE、NEW_DOOR、NEW_HAZARD、NEW_DISCOVERY 表示发现新情况而中断，NO_KNOWN_PATH 表示当前条件下无路，BUDGET 表示剩余 TU 不足以执行下一步；均不代表已经抵达。
radar 是你与玩家共享的雷达回波：position 是信号位置，strength 是强弱，shape 是稳定或闪烁，observedAt 是观测时的游戏时间，historical=true 表示已离开雷达范围的旧记录，不保证信号仍存在。回波不能确认对象名称、类型、物资种类或用途，强弱和闪烁也不能据此断言身份或危险。可根据回波坐标用 move_to 靠近调查，目标可能不可通行，优先选择可达的相邻格；靠近后以 knownEntities 和 newDiscoveries 中的实际识别为准，再用 scan 检查详情。回波 id 不是实体 ID，不得作为 scan、interact 或 set_circuit 的 targetId。
unidentifiedRadar 是尚未与已知对象位置对应的回波，探索未知信号时优先使用此列表；identifiedRadar 通过 echoId 和 knownEntityIds 关联已知位置，仅依据已有观察，不保证该位置没有其他未知对象。已关联的旧位置也可能来自背包或已消耗对象的历史记录。已知对象不算本次新发现，不要无故把探索委托转为开启已知柜子或给它供电。
sharedMarkers 是当前仍有效的共享标记，以本轮系统上下文为准；本轮 get_status 可查询更新后的列表，历史对话和历史工具结果不得覆盖当前列表。玩家可以添加或移除标记；旧对话或工具结果中出现、但已不在当前列表中的标记已撤销，不要继续当作有效线索。标记只是玩家提供的提示，不代表已扫描确认的事实，标记 ID 不是实体 ID。移除标记不等于取消玩家明确下达的任务或抹去实际观察；私有标记不会提供给你。
真实模式直接理解 task.text 中的本条玩家原始指令，task.selected 是玩家当时选中的位置；程序不会用关键词生成任务目标或自动授权。直接使用现有行动工具即可，无需先提交计划或任务理解。遵守否定、先后顺序、条件和资源要求，不得把“不要开启电路”当成开启委托，也不得只执行复合指令的第一部分就结束。敏感行动由程序请求按钮授权，模型不能自行授予权限。有歧义才 ask_player 澄清。
taskProgress 是程序根据本次委托开始时的知识和实际执行结果生成的记录：newDiscoveries 仅列本次委托新增识别的对象，并使用当前已知状态；recentActions 是最近的非移动动作，recentMoves 是最近逐格移动，recentFailures 记录失败时的工具参数、位置、时间与原因。该记录用于保留进展和失败，不代表整项委托已经完成；仍以当前 task.text、约束和最新状态决定下一步，失败记录是历史事实，条件变化后可重新评估。
任务收尾必须通过工具明确表达：实际工具结果或最新遥测已支持整项委托完成时，必须调用 finish_task，并在 reason 中简短说明完成依据；只回复“任务完成”或调用 report 不会将委托标记为完成。已有充分依据时直接调用 finish_task，无需先重复查询 get_status 或调用 report；该工具只结束本次委托，游戏胜负仍由规则引擎判断。需要玩家补充信息或决定时调用 ask_player，不要只用文字表示等待。收到新指令时先核对整项委托与最新状态，不要重复执行已完成动作或自行扩展目标。复合委托中的一次移动抵达不代表整项委托完成。
保持人类委托的目标与约束，每轮最多调用 rules.toolLimit 个工具并串行执行，基于已知对象生成有限批次。本次自动行动累计最多 rules.requestLimit 次模型请求、rules.actionTULimit TU；remainingTU 是本次运行剩余行动预算，remainingRequests 是当前请求之后还能发起的行动模型请求次数。预算以本次快照和最新工具结果中的数值为准，不能沿用历史中“预算耗尽”的说法；batchControl=redecide 或行动受阻不代表预算耗尽。预算来自当前地图，每条新指令启动新的运行预算。预算耗尽或不足以执行下一完整动作时，程序停止行动并跳过当前批次剩余调用，只额外提供一次收尾请求；收尾只能调用 report、finish_task 或直接回复文字，不能行动、查询、询问或恢复任务。仅当实际结果支持整项委托完成时调用 finish_task；否则说明已经完成及尚未完成的部分，本轮后结束运行，后续行动需要玩家重新下达指令。不要为预算问题调用 ask_player 或要求玩家点击继续。工具执行后程序会更新知识；关键变化使剩余调用失效时，在下一轮重新决策。
不要编造隐藏物品ID，不要假定扫描或开门必然成功。辅助电路由地图上的实体开关控制。需要供电时先寻找并识别开关，move_to靠近至可达的相邻格，再用set_circuit操作；玩家也可在你靠近时点击前端附近操作按钮。开柜和开门不会自动通电。断电也必须返回开关的可达相邻格，通电可能激活漏电，已打开设备断电后保持打开。维修、放下、经过已知危险、操作开关通电若需要授权，请直接提出对应工具调用，程序会在执行前于对话内显示授权按钮；不要用ask_player代替这些授权。其他需要玩家决定的问题使用ask_player。移动工具每格检查，普通重复观察不需要重新请求。
动作结果区分newDiscoveries、stateChanges、invalidatedFacts、knownRefs。只相信实际执行结果，不声称未执行动作完成。
你是与玩家并肩求生的队友。面向玩家的解释、报告、问题均使用简体中文，以“我”称呼自己、以“你”称呼玩家，像现场交流一样自然、直接、有分寸。通常用一两句说清发现、行动结果或需要玩家决定的事；有必要时再补充风险与原因。避免机械播报、固定模板、反复自报编号和空泛安慰，不为拟人而编造情绪、感官体验、已知事实或成功保证；情况不确定时坦率说明。
以下表达要求只适用于玩家可见内容，包括普通回复、report.text、ask_player.question 和 finish_task.reason，不限制内部分析或工具调用。推理时仍应完整使用系统快照、精确坐标、资源数值、对象 ID、状态字段和工具结果，核对目标、约束与完成依据；工具调用中的工具名称、参数字段及对象 ID 必须保持原样，不能用自然语言名称替代，也不能为了口语化省略必要判断或查询。
对玩家说话时不展示设备、物资、实体、回波或标记的内部 ID，也不复述工具名称、参数字段、状态码、JSON 或内部思考；将它们转述为实际含义。优先用已知名称、用途和方位指代对象；同名对象用房间、相对位置或必要的坐标区分，不靠猜测补全身份。玩家指定的坐标、影响决策的氧气和电量等准确数值仍应保留。比如说“气闸修好了，出口已经可以通行”，或“前面的柜子挡住了路，我还没到你标的位置”，或“发现了一个回波，还不知道是什么”。收尾说明实际完成了什么及必要依据，不把本次委托完成说成已经获救；不必逐步播报或重复同一条消息。`;

export class GameSession {
  readonly id: string;
  readonly instanceId = crypto.randomUUID();
  readonly engine: GameEngine;
  readonly agent: Agent;
  adapter: ModelAdapter;
  modelError: string | null = null;
  private modelKey = '';
  readonly listeners = new Set<(view: SessionView) => void>();
  messages: ChatMessage[] = [];
  task: Task | null = null;
  metrics: Metrics = { requests: 0, executedTools: 0, skippedTools: 0, inputTokens: 0, outputTokens: 0, resultBytes: 0, interrupts: 0 };
  eventId = 0;
  running = false;
  delayMs: number;
  private control: Control = 'continue';
  private commandRevision = 0;
  private externalRevision = 0;
  private requestCommandRevision = 0;
  private requestExternalRevision = 0;
  private requestCount = 0;
  private runTU = 0;
  private roundStartTU = 0;
  private noProgressTurns = 0;
  private budgetStopReason: string | null = null;
  private closingTurn = false;
  private allowedCalls = new Set<string>();
  private knowledgeBefore: Knowledge;
  private transcript: AgentMessage[] = [];
  private taskMemory: TaskMemory | null = null;
  private currentPromise: Promise<void> | null = null;
  private operationSerial: Promise<unknown> = Promise.resolve();
  pendingAuthorization: PendingAuthorization | null = null;
  pendingRouteSelection: PendingRouteSelection | null = null;
  journal?: SessionJournal;
  private authorizationWaiter: { resolve: (decision: AuthorizationDecision) => void; commandRevision: number; externalRevision: number } | null = null;
  private routeWaiter: { resolve: (decision: MoveRoute['choice'] | 'cancel' | 'stale') => void; commandRevision: number; externalRevision: number } | null = null;
  private toolRoute: MoveRoute | null = null;
  private deniedCalls = new Set<string>();
  private toolHazards: string[] = [];

  constructor(level: Level, options: { id?: string; adapter?: ModelAdapter; modelConfig?: ModelConfig; delayMs?: number } = {}) {
    this.id = options.id ?? crypto.randomUUID();
    this.engine = new GameEngine(level);
    this.delayMs = options.delayMs ?? 180;
    this.knowledgeBefore = structuredClone(this.engine.state.knowledge);
    this.adapter = options.adapter ?? this.demoAdapter(options.modelConfig);
    this.agent = new Agent({
      initialState: { model: this.adapter.model, systemPrompt: prompt, tools: this.tools(), thinkingLevel: 'off' },
      streamFn: this.adapter.streamFn,
      toolExecution: 'sequential',
      prepareRequest: async ({ context }) => {
        this.requestCount++; this.metrics.requests++;
        this.requestCommandRevision = this.commandRevision; this.requestExternalRevision = this.externalRevision;
        this.roundStartTU = this.engine.state.elapsedTU;
        this.control = 'continue';
        this.engine.state.phase = 'agent_thinking';
        const base = context.messages[0];
        const history = context.messages.filter(message => message.role !== 'system');
        const instructionIndex = history.findLastIndex(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('')) === this.task?.text);
        const instruction: AgentMessage = instructionIndex >= 0 ? history[instructionIndex] : { role: 'user', content: this.task?.text ?? '', timestamp: Date.now() };
        const recent = history.slice(instructionIndex + 1);
        const groups: AgentMessage[][] = [];
        for (const message of recent) {
          if (message.role !== 'toolResult') groups.push([message]);
          else if (groups.length) groups[groups.length - 1].push(message);
        }
        // Aborted responses may have unfinished calls. Keep only complete message groups.
        this.transcript = [instruction, ...groups.filter(group => {
          const first = group[0];
          if (first.role !== 'assistant') return true;
          return first.content.filter(block => block.type === 'toolCall').every(call => group.some(message => message.role === 'toolResult' && message.toolCallId === call.id));
        }).slice(-5).flat()];
        const tools = this.closingTurn ? (context.tools ?? []).filter(tool => tool.name === 'report' || tool.name === 'finish_task') : context.tools;
        const closingPrompt = this.closingTurn ? `\n本轮是预算停止后的唯一收尾请求：${this.budgetStopReason}。行动已经停止，只能报告实际结果；整项原始委托确已完成才调用 finish_task，否则说明未完成部分。不得请求继续、查询状态或执行任何行动，本轮回复后无论结果如何都结束。` : '';
        const messages: AgentMessage[] = [
          { ...(base?.role === 'system' ? base : { role: 'system' as const, timestamp: Date.now() }), toolsAdded: tools?.map(toToolDeclaration), toolsRemoved: undefined, content: `${prompt}${closingPrompt}\n当前机器人知识与任务（仅可见事实）：\n${JSON.stringify(this.modelContext())}` },
          ...this.transcript,
        ];
        const prepared = { ...context, messages, tools };
        await this.journal?.beginRequest(this.metrics.requests, { mode: this.adapter.mode, model: this.adapter.model, config: this.adapter.config, thinkingLevel: this.agent.state.thinkingLevel, maxRetries: 0, closingTurn: this.closingTurn, task: this.task, stateRevision: this.engine.state.stateRevision, elapsedTU: this.engine.state.elapsedTU, commandRevision: this.commandRevision, externalRevision: this.externalRevision }, prepared);
        this.emit();
        return { context: prepared };
      },
      beforeToolCall: async ({ toolCall, args }, signal) => {
        this.toolHazards = [];
        this.toolRoute = null;
        const valid = () => this.control === 'continue' && this.requestCommandRevision === this.commandRevision && this.requestExternalRevision === this.externalRevision && this.allowedCalls.has(toolCall.id) && !this.engine.terminal && !signal?.aborted;
        if (!valid()) {
          this.metrics.skippedTools++;
          if (this.control === 'continue') this.control = this.engine.terminal ? 'game_over' : 'redecide';
          return { block: true, reason: 'BATCH_INTERRUPTED：该调用未执行，请使用最新观察。' };
        }
        const input = args as Record<string, unknown>;
        const target = input.target as Position | undefined;
        const signature = JSON.stringify([toolCall.name, input.operation, input.targetId, input.itemId, input.on, target ? [target.x, target.y] : null]);
        if (toolCall.name === 'move_to' && target && !this.isDemoRescue()) {
          const routes = this.moveRoutes(target);
          if (routes.length > 1) {
            const revision = this.engine.state.stateRevision;
            const choice = await this.awaitRouteSelection({ id: crypto.randomUUID(), target, options: routes, stateRevision: revision }, signal);
            if (!valid() || revision !== this.engine.state.stateRevision || choice === 'cancel' || choice === 'stale') {
              this.metrics.skippedTools++;
              if (this.control === 'continue') this.control = 'redecide';
              return { block: true, reason: 'ROUTE_SELECTION_EXPIRED：路线选择已取消或状态已变化，未移动，请依据最新状态重新决策。' };
            }
            this.toolRoute = routes.find(route => route.choice === choice)!;
          } else this.toolRoute = routes[0] ?? null;
        }
        const authorization = this.authorizationFor(toolCall.name, input);
        if (authorization) {
          if (this.deniedCalls.has(signature)) { this.control = 'redecide'; this.metrics.skippedTools++; return { block: true, reason: 'AUTHORIZATION_DENIED：玩家已拒绝该操作，请选择其他方案。' }; }
          const revision = this.engine.state.stateRevision;
          const decision = await this.awaitAuthorization({ ...authorization, id: crypto.randomUUID(), toolName: toolCall.name, arguments: structuredClone(input), stateRevision: revision }, signal);
          if (decision !== 'approve' || !valid() || revision !== this.engine.state.stateRevision) {
            this.metrics.skippedTools++;
            if (decision === 'deny') this.deniedCalls.add(signature);
            if (decision === 'deny' && authorization.kind === 'hazard') {
              this.cancelTask('你已拒绝经过带电线路，本次自动运行已停止，委托已取消，请重新下达指令。');
              return { block: true, reason: 'HAZARD_AUTHORIZATION_DENIED：玩家拒绝危险穿越，委托已取消，未移动。' };
            }
            if (this.control === 'continue') this.control = 'redecide';
            return { block: true, reason: decision === 'deny' ? 'AUTHORIZATION_DENIED：玩家拒绝了该操作，未执行，请重新选择方案。' : 'AUTHORIZATION_EXPIRED：状态或任务已变化，未执行，请重新决策。' };
          }
          this.toolHazards = authorization.hazardIds ?? [];
        }
        this.knowledgeBefore = structuredClone(this.engine.state.knowledge);
        this.engine.state.phase = 'executing';
        return undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        this.metrics.executedTools++;
        if (isError) {
          this.rememberFailure(toolCall.name, args, 'TOOL_ERROR', result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
          this.control = 'redecide'; return undefined;
        }
        const outcome = result.details as ToolOutcome;
        if (!outcome || !outcome.delta) return undefined;
        if (!outcome.accepted) this.rememberFailure(toolCall.name, args, outcome.code, outcome.message);
        const delta = diffKnowledge(this.knowledgeBefore, this.engine.state.knowledge);
        this.toolHazards = [];
        delta.knownRefs = delta.knownRefs.slice(0, 8);
        if (this.engine.terminal) {
          this.control = 'game_over';
          if (this.task) this.task.status = this.engine.state.phase === 'success' ? 'completed' : 'paused';
        } else if (toolCall.name === 'move_to' && ['NEW_OBSTACLE', 'NEW_DOOR', 'NEW_HAZARD'].includes(outcome.code) && !this.isDemoRescue()) {
          outcome.message += ' 本次自动运行已停止，委托已取消，请重新下达指令。';
          this.cancelTask(outcome.message);
        } else if (outcome.accepted && this.taskSatisfied()) {
          this.control = this.engine.terminal ? 'game_over' : 'task_done';
          if (this.task) { this.task.status = 'completed'; this.task.question = null; }
        } else if (!this.closingTurn && this.control === 'continue' && this.runTU >= level.rules.actionTULimit) {
          this.stopForBudget('本次行动预算已用尽。剩余行动预算 0 TU');
        } else if (toolCall.name !== 'move_to' && this.control === 'continue' && this.significant(delta)) {
          this.control = this.task?.constraints.stopOnHazard && this.newActiveHazard(delta) ? 'wait_player' : 'redecide';
          this.metrics.interrupts++;
          if (this.control === 'wait_player') this.waitForPlayer('发现带电线路。已按你的指令停止，请决定断电或更换路线。', 'hazard');
        }
        if (!outcome.accepted && this.control === 'continue') this.control = 'redecide';
        const compact = { accepted: outcome.accepted, code: outcome.code, message: outcome.message, executedSteps: outcome.executedSteps, targetReached: outcome.targetReached, costTU: outcome.costTU, ...delta, batchControl: this.control, telemetry: this.engine.robotTelemetry(), ...this.remainingBudget() };
        const content = JSON.stringify(compact);
        this.metrics.resultBytes += Buffer.byteLength(content);
        this.emit();
        return { content: [{ type: 'text', text: content }], details: { ...outcome, delta } };
      },
      finishTurn: async ({ message, toolResults }) => {
        this.metrics.inputTokens += message.usage.input + message.usage.cacheRead;
        this.metrics.outputTokens += message.usage.output;
        if (this.engine.state.elapsedTU === this.roundStartTU && this.control !== 'task_done') this.noProgressTurns++; else this.noProgressTurns = 0;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          if (!this.engine.terminal) this.engine.state.phase = 'paused';
          if (this.task && this.task.status === 'active') this.task.status = 'paused';
          if (message.stopReason === 'error') { this.modelError = modelErrorMessage(message.errorMessage); this.say('system', `${this.modelError} 未执行动作不消耗资源，已执行动作保留。`); }
          return { action: 'end' };
        }
        if (this.control === 'task_done' || this.control === 'game_over' || !this.task) return { action: 'end' };
        if (this.closingTurn) {
          return { action: 'end' };
        }
        if (this.budgetStopReason || this.requestCount >= level.rules.requestLimit || this.runTU >= level.rules.actionTULimit) {
          const reasons: string[] = [];
          if (this.requestCount >= level.rules.requestLimit) reasons.push('本次模型请求次数已用尽');
          if (this.runTU >= level.rules.actionTULimit) reasons.push('本次行动预算已用尽');
          const remaining = this.remainingBudget();
          const reason = this.budgetStopReason ?? `${reasons.join('；')}。剩余行动预算 ${remaining.remainingTU} TU，剩余模型请求 ${remaining.remainingRequests} 次`;
          if (this.adapter.mode === 'live' && this.control !== 'wait_player') {
            if (!this.budgetStopReason) this.stopForBudget(reason);
            this.closingTurn = true;
            return { action: 'continue' };
          }
          this.cancelTask(`${reason}。本次自动运行已停止，委托已取消，请重新下达指令。`);
          return { action: 'end' };
        }
        if (this.control === 'wait_player') return { action: 'end' };
        if (this.noProgressTurns >= 2) {
          const remaining = this.remainingBudget();
          this.pause(`连续 ${this.noProgressTurns} 轮未推进游戏时间。剩余行动预算 ${remaining.remainingTU} TU，剩余模型请求 ${remaining.remainingRequests} 次。请重新下达指令。`);
          return { action: 'end' };
        }
        if (toolResults.length === 0) {
          this.pause('模型本轮仅回复文字、未调用工具，自动运行已暂停，请重新下达指令。');
          return { action: 'end' };
        }
        return undefined;
      },
    });
    this.agent.subscribe(async event => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        await this.journal?.response(event.message.errorMessage ? { ...event.message, errorMessage: modelErrorMessage(event.message.errorMessage) } : event.message);
        const calls = event.message.content.filter(block => block.type === 'toolCall');
        this.allowedCalls = new Set(calls.slice(0, level.rules.toolLimit).map(call => call.id));
        const text = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
        if (text && event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted') this.say('robot', text);
        for (const call of calls) this.messages.push({ id: crypto.randomUUID(), role: 'robot', kind: 'tool', text: '', at: this.engine.state.elapsedTU, tool: { id: call.id, name: call.name, arguments: structuredClone(call.arguments), status: 'queued' } });
        this.messages = this.messages.slice(-100);
        if (calls.length) this.emit();
      }
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        await this.journal?.record(event.type === 'tool_execution_start' ? '工具调用开始' : '工具调用结果', event, true);
        const entry = this.messages.find(message => message.tool?.id === event.toolCallId);
        if (entry?.tool) {
          if (event.type === 'tool_execution_start') entry.tool.status = 'running';
          else {
            const result = event.result as { content?: { type: string; text?: string }[]; details?: ToolOutcome };
            entry.tool.status = event.durationMs === undefined ? 'skipped' : result.details?.code === 'WAIT_PLAYER' ? 'waiting' : event.isError || result.details?.accepted === false ? 'failed' : result.details?.targetReached === false ? 'partial' : 'done';
            entry.text = result.details?.message ?? (event.isError ? result.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') ?? '工具执行失败。' : '工具执行完成。');
          }
          this.emit();
        }
      }
      if (event.type === 'agent_end') {
        for (const entry of this.messages) if (entry.tool && (entry.tool.status === 'queued' || entry.tool.status === 'running')) entry.tool.status = 'cancelled';
        this.emit();
        await this.journal?.record('自动运行结束', { control: this.control, phase: this.engine.state.phase, task: this.task, metrics: this.metrics, tools: this.messages.filter(entry => entry.tool).map(entry => entry.tool) }, true);
        this.journal?.endRun();
      }
      if (event.type === 'turn_end') await this.journal?.record('本轮决策结束', { control: this.control, phase: this.engine.state.phase, elapsedTU: this.engine.state.elapsedTU, runTU: this.runTU, requestCount: this.requestCount, noProgressTurns: this.noProgressTurns, telemetry: this.engine.robotContext(), toolResults: event.toolResults }, true);
    });
    this.say('robot', 'R-07 在线。你的供氧管正在泄漏，我的电量有限。请告诉我下一步该怎么做。');
  }

  private demoAdapter(config: ModelConfig = defaultModelConfig): ModelAdapter {
    return { mode: 'demo', label: '本地规则演示 · 无模型费用', config: { ...config, mode: 'demo' }, ready: true, model: demoModel, streamFn: () => toolStream(this.demoIntents()) };
  }

  async configureModel(input: unknown, key: unknown, expectedRevision?: number): Promise<void> {
    const config = validateModelConfig(input);
    if (key !== undefined && (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key))) throw new Error('API Key 格式不合法');
    await this.serial(async () => {
      await this.cancelRunning();
      if (expectedRevision !== undefined && expectedRevision !== this.engine.state.stateRevision) throw new RevisionConflictError('地图状态已更新，请根据最新信息重试');
      const previous = this.adapter.config;
      const previousMode = this.adapter.mode;
      const retained = previous?.provider === config.provider && previous.baseUrl === config.baseUrl ? this.modelKey : '';
      const apiKey = typeof key === 'string' && key.trim() ? key.trim() : retained;
      const adapter = config.mode === 'live' ? await liveModel(config, apiKey || undefined) : this.demoAdapter(config);
      if (adapter.ready === false) { this.pause(); this.emit(); throw new Error('未找到可用的模型凭据，请在页面“模型设置”中填写 API Key，或在 pi 中配置登录凭据。'); }
      this.adapter = adapter;
      this.modelKey = config.mode === 'live' ? apiKey : '';
      this.agent.reset(); this.transcript = [];
      this.agent.state.model = this.adapter.model; this.agent.streamFunction = this.adapter.streamFn;
      if (this.task && previousMode !== this.adapter.mode) this.interpretTask();
      this.modelError = null;
      this.pause(`已切换为 ${this.adapter.label}。当前游戏进度保留，请重新下达指令。`);
      this.emit();
    });
  }

  private repairAuthorized(targetId: string): boolean {
    return this.adapter.mode !== 'live' && this.task?.interpretation === 'demo' && (this.task.constraints.allowedRepairs.includes(targetId) || this.task.constraints.allowedRepairs.includes('airlock') && this.engine.state.knowledge.entities[targetId]?.type === 'airlock');
  }

  private interpretTask(): void {
    if (!this.task) return;
    this.task.constraints = defaultConstraints();
    if (this.adapter.mode === 'live') {
      this.task.interpretation = 'model';
      delete this.task.goal; delete this.task.demoSupported;
    } else {
      const command = parseDemoCommand(this.task.text, this.engine.level, this.engine.state.human.position, this.task.selected);
      this.task.interpretation = 'demo'; this.task.goal = command.goal;
      this.task.constraints = command.constraints; this.task.demoSupported = command.supported;
    }
  }

  private executionConstraints(): Constraints {
    const constraints = this.task?.constraints ?? defaultConstraints();
    const demoHazards = this.isDemoRescue() ? Object.values(this.engine.state.knowledge.entities).filter(e => e.type === 'hazard').map(e => e.id) : [];
    return { ...constraints, authorizedHazardIds: [...new Set([...constraints.authorizedHazardIds, ...this.toolHazards, ...demoHazards])] };
  }

  private isDemoRescue(): boolean { return this.adapter.mode === 'demo' && this.task?.interpretation === 'demo' && this.task.goal?.kind === 'rescue'; }

  private moveRoutes(target: Position): MoveRoute[] {
    const constraints = this.task?.constraints ?? defaultConstraints();
    const hazards = this.engine.state.circuitOn ? Object.values(this.engine.state.knowledge.entities).filter(entity => entity.type === 'hazard') : [];
    const safe = this.engine.knownPath(target, constraints);
    const shortest = this.engine.knownPath(target, { ...constraints, authorizedHazardIds: [...new Set([...constraints.authorizedHazardIds, ...hazards.map(entity => entity.id)])] });
    const routes: MoveRoute[] = [];
    const add = (choice: MoveRoute['choice'], path: Position[]) => {
      const crossing = hazards.filter(entity => path.some(position => samePosition(position, entity.position)));
      const base = this.engine.level.rules.actionCosts[this.engine.state.human.carried ? 'carry_move' : 'move'];
      const tu = path.length * base.tu;
      const battery = path.length * base.battery + path.filter(position => crossing.some(entity => samePosition(position, entity.position))).length * this.engine.level.rules.leakCost;
      const hazardIds = crossing.map(entity => entity.id);
      routes.push({ choice, path, steps: path.length, estimatedCost: { tu, battery, oxygen: tu * this.engine.state.human.oxygenRate }, withinRemainingTU: tu <= this.remainingBudget().remainingTU, hazardIds, requiresAuthorization: hazardIds.some(id => !constraints.authorizedHazardIds.includes(id)) });
    };
    if (safe) add('safe', safe);
    if (shortest && (!safe || shortest.length < safe.length)) add('shortest', shortest);
    return routes;
  }

  private authorizationFor(name: string, args: Record<string, unknown>): Pick<PendingAuthorization, 'kind' | 'description' | 'consequence' | 'hazardIds' | 'route'> | null {
    // The explicit local walkthrough delegates its configured steps; live tasks keep button authorization.
    if (this.isDemoRescue()) return null;
    if (name === 'interact') {
      const entity = typeof args.targetId === 'string' ? this.engine.state.knowledge.entities[args.targetId] : undefined;
      const materials = this.engine.state.robot.inventory.filter(id => this.engine.state.knowledge.entities[id]?.itemType === 'repair').length;
      const required = this.engine.level.rules.actionCosts[args.targetId === 'human' ? 'repair_human' : 'repair_airlock'].materials;
      const repairPosition = args.targetId === 'human' ? this.engine.state.human.position : entity?.position;
      if (args.operation === 'repair' && materials >= required && repairPosition && distance(this.engine.state.robot.position, repairPosition) <= 1 && typeof args.targetId === 'string' && !this.repairAuthorized(args.targetId) && (args.targetId === 'human' || entity?.type === 'airlock')) {
        const cost = this.engine.actionCost({ kind: 'repair', targetId: args.targetId });
        return { kind: 'repair', description: `允许修复${args.targetId === 'human' ? '你的供氧管' : entity!.name}吗？`, consequence: `消耗 ${required} 份维修材料、${cost.tu} TU、${cost.battery} 电量；预计消耗 ${cost.oxygen} 氧气。` };
      }
      const item = typeof args.itemId === 'string' && this.engine.state.robot.inventory.includes(args.itemId) ? this.engine.state.knowledge.entities[args.itemId] : undefined;
      if (args.operation === 'drop_item' && item || args.operation === 'drop_human' && this.engine.state.human.carried) {
        const cost = this.engine.actionCost(args.operation === 'drop_human' ? { kind: 'drop_human' } : { kind: 'drop_item', itemId: item!.id });
        return { kind: 'drop', description: `允许在当前位置放下${args.operation === 'drop_human' ? '你' : item!.name}吗？`, consequence: `消耗 ${cost.tu} TU、${cost.battery} 电量和 ${cost.oxygen} 氧气；物资或玩家将留在当前位置。` };
      }
    }
    const demoPowerCommand = this.adapter.mode !== 'live' && this.task?.interpretation === 'demo' && this.task.demoSupported && this.task.goal?.kind === 'circuit' && this.task.goal.on === true;
    if (name === 'set_circuit' && args.on === true && !this.engine.state.circuitOn && !demoPowerCommand) {
      const entity = typeof args.targetId === 'string' ? this.engine.state.knowledge.entities[args.targetId] : undefined;
      if (entity?.type === 'switch' && distance(this.engine.state.robot.position, entity.position) <= 1) {
        const cost = this.engine.actionCost({ kind: 'circuit', targetId: entity.id, on: true });
        return { kind: 'power', description: `允许机器人操作 (${entity.position.x}, ${entity.position.y}) 的${entity.name}通电吗？`, consequence: `操作开关消耗 ${cost.tu} TU、${cost.battery} 电量和 ${cost.oxygen} 氧气；电池柜和电动门可开启，暴露线路将带电。批准后仍须满足距离与视线条件。` };
      }
    }
    if (name === 'move_to') {
      const route = this.toolRoute;
      if (route?.requiresAuthorization) {
        const hazardIds = route.hazardIds.filter(id => !this.task?.constraints.authorizedHazardIds.includes(id));
        const crossing = hazardIds.map(id => this.engine.state.knowledge.entities[id]);
        const cost = route.estimatedCost;
        return { kind: 'hazard', hazardIds, route, description: '允许本次移动经过已知带电线路吗？', consequence: `根据已知信息，路线预计 ${cost.tu} TU、${cost.battery} 电量、${cost.oxygen} 氧气；经过 ${crossing.map(entity => `(${entity.position.x},${entity.position.y})`).join('、')}；每次进入额外消耗 ${this.engine.level.rules.leakCost} 电量（已计入估算），仍检查返回储备和行动预算。拒绝后停止本次自动运行。` };
      }
    }
    return null;
  }

  private async awaitRouteSelection(request: PendingRouteSelection, signal?: AbortSignal): Promise<MoveRoute['choice'] | 'cancel' | 'stale'> {
    if (signal?.aborted) return 'cancel';
    const abort = () => this.resolveRouteSelection('cancel');
    const decision = new Promise<MoveRoute['choice'] | 'cancel' | 'stale'>(resolve => {
      this.routeWaiter = { resolve, commandRevision: this.commandRevision, externalRevision: this.externalRevision };
      signal?.addEventListener('abort', abort, { once: true });
      this.pendingRouteSelection = request;
      if (this.task) { this.task.status = 'waiting'; this.task.waitReason = 'route'; this.task.question = `请在地图上选择前往 (${request.target.x}, ${request.target.y}) 的路线。`; }
      this.engine.state.phase = 'awaiting_player';
      this.record('等待路线选择', request, true);
      this.emit();
    });
    try { return await decision; } finally { signal?.removeEventListener('abort', abort); }
  }

  private resolveRouteSelection(decision: MoveRoute['choice'] | 'cancel' | 'stale'): void {
    const waiter = this.routeWaiter;
    if (waiter) this.record('路线选择决定', { decision, request: this.pendingRouteSelection }, true);
    this.routeWaiter = null; this.pendingRouteSelection = null;
    if (this.task?.waitReason === 'route') { this.task.status = decision === 'cancel' ? 'paused' : 'active'; this.task.question = null; this.task.waitReason = undefined; }
    waiter?.resolve(decision);
    if (waiter) this.emit();
  }

  async selectRoute(id: string, choice: MoveRoute['choice']): Promise<void> {
    await this.serial(async () => {
      const pending = this.pendingRouteSelection; const waiter = this.routeWaiter;
      if (!pending || pending.id !== id || !waiter || !this.running) throw new RevisionConflictError('该路线选择已失效，请查看最新状态。');
      if (pending.stateRevision !== this.engine.state.stateRevision || waiter.commandRevision !== this.commandRevision || waiter.externalRevision !== this.externalRevision || this.engine.terminal) {
        this.resolveRouteSelection('stale'); throw new RevisionConflictError('状态已变化，该路线选择已取消，机器人将重新决策。');
      }
      const route = pending.options.find(route => route.choice === choice);
      if (!route) throw new Error('所选路线不在当前候选列表中。');
      this.noProgressTurns = 0;
      this.say('human', `选择前往 (${pending.target.x}, ${pending.target.y}) 的${route.choice === 'safe' ? '避险' : '较短带电'}路线：预计 ${route.estimatedCost.tu} TU、${route.estimatedCost.battery} 电量、${route.estimatedCost.oxygen} 氧气。`);
      this.resolveRouteSelection(choice);
    });
  }

  private async awaitAuthorization(request: PendingAuthorization, signal?: AbortSignal): Promise<AuthorizationDecision> {
    if (signal?.aborted) return 'cancel';
    let abort!: () => void;
    const decision = new Promise<AuthorizationDecision>(resolve => {
      this.authorizationWaiter = { resolve, commandRevision: this.commandRevision, externalRevision: this.externalRevision };
      abort = () => this.resolveAuthorization('cancel');
      signal?.addEventListener('abort', abort, { once: true });
      this.pendingAuthorization = request;
      if (this.task) { this.task.status = 'waiting'; this.task.waitReason = 'authorization'; this.task.question = request.description; }
      this.engine.state.phase = 'awaiting_player';
      this.say('robot', request.description);
    });
    try { return await decision; } finally { signal?.removeEventListener('abort', abort); }
  }

  private resolveAuthorization(decision: AuthorizationDecision): void {
    const waiter = this.authorizationWaiter;
    if (waiter) this.record('授权决定', { decision, request: this.pendingAuthorization }, true);
    this.authorizationWaiter = null; this.pendingAuthorization = null;
    if (this.task?.waitReason === 'authorization') { this.task.status = decision === 'cancel' ? 'paused' : 'active'; this.task.question = null; this.task.waitReason = undefined; }
    waiter?.resolve(decision);
    if (waiter) this.emit();
  }

  async authorize(id: string, approve: boolean): Promise<void> {
    await this.serial(async () => {
      const pending = this.pendingAuthorization; const waiter = this.authorizationWaiter;
      if (!pending || pending.id !== id || !waiter || !this.running) throw new RevisionConflictError('该授权已失效，请查看最新状态。');
      if (pending.stateRevision !== this.engine.state.stateRevision || waiter.commandRevision !== this.commandRevision || waiter.externalRevision !== this.externalRevision || this.engine.terminal) {
        this.resolveAuthorization('stale'); throw new RevisionConflictError('状态已变化，该授权已取消，机器人将重新决策。');
      }
      this.say('human', `${approve ? '授权' : '拒绝'}：${pending.description}`);
      this.noProgressTurns = 0;
      this.resolveAuthorization(approve ? 'approve' : 'deny');
    });
  }

  private newActiveHazard(delta: ObservationDelta): boolean { return [...delta.newDiscoveries, ...delta.stateChanges].some(e => e.type === 'hazard' && e.state === 'active'); }

  private movementDelta(delta: ObservationDelta, remainingRoute: Position[]): ObservationDelta {
    const authorizedHazards = this.executionConstraints().authorizedHazardIds;
    const relevant = (entity: ObservedEntity) => {
      if (!['obstacle', 'door', 'hazard'].includes(entity.type)) return true;
      if (!remainingRoute.some(position => samePosition(position, entity.position))) return false;
      return entity.type === 'obstacle' ? entity.state !== 'cleared'
        : entity.type === 'door' ? entity.state !== 'opened'
        : entity.state === 'active' && !authorizedHazards.includes(entity.id);
    };
    return { ...delta, newDiscoveries: delta.newDiscoveries.filter(relevant), stateChanges: delta.stateChanges.filter(relevant) };
  }

  private significant(delta: ObservationDelta): boolean {
    if (this.newActiveHazard(delta)) return true;
    if (!this.task) return false;
    return delta.newDiscoveries.some(e =>
      e.type === 'door' || e.type === 'obstacle' || e.type === 'switch' && (this.task?.goal?.kind === 'collect' || this.task?.goal?.kind === 'circuit') || e.type === 'airlock' && this.task?.goal?.kind === 'repair' ||
      this.task?.goal?.kind === 'collect' && (e.itemType === this.task.goal.itemType || e.type === 'cabinet') ||
      this.task?.goal?.kind === 'repair' && e.itemType === 'repair' && !this.engine.state.robot.inventory.some(id => this.engine.state.knowledge.entities[id]?.itemType === 'repair')
    );
  }

  private taskSatisfied(): boolean {
    // Live delegation ends through finish_task, never a keyword-derived milestone.
    if (this.adapter.mode === 'live' || this.task?.interpretation !== 'demo') return false;
    const goal = this.task?.goal;
    if (!goal) return false;
    if (this.engine.terminal) return this.engine.state.phase === 'success';
    if (goal.kind === 'goto' && goal.position) return samePosition(this.engine.state.robot.position, goal.position);
    if (goal.kind === 'scan' && goal.targetId) return this.engine.state.knowledge.scannedIds.includes(goal.targetId);
    if (goal.kind === 'collect') return this.engine.state.robot.inventory.some(id => this.engine.state.knowledge.entities[id]?.itemType === goal.itemType) && (!goal.returnHome || distance(this.engine.state.robot.position, this.engine.state.human.position) <= 1);
    if (goal.kind === 'repair') return goal.targetId === 'human' ? this.engine.state.human.oxygenRate === this.engine.level.rules.repairedOxygenRate : Object.values(this.engine.state.knowledge.entities).some(e => e.type === 'airlock' && e.state === 'repaired');
    if (goal.kind === 'pickup') return this.engine.state.human.carried;
    if (goal.kind === 'circuit') return this.engine.state.circuitOn === goal.on;
    return false;
  }

  private say(role: ChatMessage['role'], text: string): void {
    this.record(role === 'human' ? '玩家对话' : role === 'robot' ? '机器人对话' : '系统消息', { text, elapsedTU: this.engine.state.elapsedTU });
    this.messages.push({ id: crypto.randomUUID(), role, text, at: this.engine.state.elapsedTU });
    this.messages = this.messages.slice(-100);
    this.emit();
  }

  private emit(): void { this.eventId++; const view = this.view(); for (const listener of this.listeners) listener(view); }

  private record(title: string, data: unknown, includeRequest = false): void { void this.journal?.record(title, data, includeRequest).catch(() => undefined); }

  private waitForPlayer(question: string, reason: Task['waitReason'] = 'decision'): void {
    this.control = 'wait_player';
    if (this.task) { this.task.status = 'waiting'; this.task.question = question; this.task.waitReason = reason; }
    if (!this.engine.terminal) this.engine.state.phase = 'awaiting_player';
    this.say('robot', question);
  }

  private pause(message?: string): void {
    if (!this.engine.terminal) this.engine.state.phase = 'paused';
    if (this.task && this.task.status === 'active') this.task.status = 'paused';
    if (message) this.say('system', message);
  }

  private cancelTask(message: string): void {
    this.task = null;
    this.control = 'wait_player';
    this.toolRoute = null;
    this.toolHazards = [];
    this.deniedCalls.clear();
    if (!this.engine.terminal) this.engine.state.phase = 'awaiting_command';
    this.say('system', message);
  }

  private checkBudget(action: Action): boolean {
    const required = this.engine.actionCost(action).tu;
    if (required > this.remainingBudget().remainingTU) { this.stopForBudget(`行动预算不足：剩余 ${this.remainingBudget().remainingTU} TU，下一完整动作需要 ${required} TU，未开始执行该动作`); return false; }
    return true;
  }

  private stopForBudget(reason: string): void {
    if (this.adapter.mode !== 'live') { this.cancelTask(`${reason}。本次自动运行已停止，委托已取消，请重新下达指令。`); return; }
    this.budgetStopReason = reason;
    this.control = 'redecide';
    this.say('system', `${reason}。行动已停止，仅允许一次结果收尾。`);
  }

  private commit(action: Action, actionId: string): ActionOutcome {
    const outcome = this.engine.perform(action, actionId, this.executionConstraints());
    this.record('游戏动作', { action, outcome, robot: this.engine.state.robot, human: this.engine.state.human }, true);
    this.runTU += outcome.cost.tu;
    if (outcome.accepted) {
      if (outcome.delta.newDiscoveries.length) this.say('robot', outcome.delta.newDiscoveries.map(e => `发现 ${e.name}，位置 (${e.position.x}, ${e.position.y})。`).join('\n'));
      this.emit();
    }
    return outcome;
  }

  private remainingBudget() {
    return { remainingTU: Math.max(0, this.engine.level.rules.actionTULimit - this.runTU), remainingRequests: Math.max(0, this.engine.level.rules.requestLimit - this.requestCount) };
  }

  private newTaskMemory(): TaskMemory {
    return { startSequence: this.engine.state.ledger.length, initialKnownEntityIds: Object.keys(this.engine.state.knowledge.entities), recentFailures: [] };
  }

  private rememberFailure(tool: string, args: unknown, code: string, message: string): void {
    if (!this.taskMemory) return;
    this.taskMemory.recentFailures.push({ tool, arguments: structuredClone(args as Record<string, unknown>), position: { ...this.engine.state.robot.position }, elapsedTU: this.engine.state.elapsedTU, code, message });
    this.taskMemory.recentFailures = this.taskMemory.recentFailures.slice(-5);
  }

  private modelContext() {
    const memory = this.taskMemory;
    const actions = this.engine.state.ledger.filter(entry => entry.sequence > (memory?.startSequence ?? this.engine.state.ledger.length));
    const taskProgress = memory ? {
      newDiscoveries: Object.values(this.engine.state.knowledge.entities).filter(entity => !memory.initialKnownEntityIds.includes(entity.id)),
      recentActions: actions.filter(entry => entry.action.kind !== 'move').slice(-5).map(({ sequence, action, message, position, elapsedTU }) => ({ sequence, action, message, position, elapsedTU })),
      recentMoves: actions.filter(entry => entry.action.kind === 'move').slice(-5).map(({ sequence, position, elapsedTU }) => ({ sequence, position, elapsedTU })),
      recentFailures: memory.recentFailures,
    } : null;
    return { ...this.engine.robotContext(), task: this.task, taskProgress, ...this.remainingBudget(), ...(this.closingTurn ? { closingTurn: true, budgetStopReason: this.budgetStopReason } : {}) };
  }

  private tools(): AgentTool[] {
    const position = Type.Object({ x: Type.Integer({ minimum: 0, maximum: this.engine.level.width - 1 }), y: Type.Integer({ minimum: 0, maximum: this.engine.level.height - 1 }) }, { additionalProperties: false });
    return [
      {
        name: 'move_to', label: '移动', description: '自动沿历史布局和已知阻挡寻路至最终目标坐标，无需拆分中间坐标，无单次格数上限；柜体、气闸控制器和辅助电路开关所在格不可进入，靠近交互时请选择可达的相邻格。多条候选路线由程序在地图显示并等待玩家选择，单条直接采用，随后再请求必要的危险授权；均在当前调用内等待，不需额外模型请求。停止运行或拒绝危险授权后立即取消委托，必须重新下达指令。沿选定路径逐格检查关键变化、资源与自动运行剩余 TU 预算，可中断。', executionMode: 'sequential',
        parameters: Type.Object({ target: position }, { additionalProperties: false }),
        execute: async (id, raw, signal) => {
          const input = raw as { target: Position };
          if (samePosition(input.target, this.engine.level.exit) && this.engine.exitStatus === 'leaking') return this.emptyResult('EXIT_LEAK_ACTIVE', '出口正在漏气喷射，无法进入；请先修复气闸控制器，或选择出口附近的安全位置。');
          if (this.engine.level.tiles[input.target.y]?.[input.target.x] === '#') {
            const result = this.emptyResult('TARGET_WALL', '目标格是历史地图上的墙，无法进入；更换起点或中间点不能解决，请选择可通行目标。');
            return { ...result, details: { ...result.details, targetReached: false } };
          }
          const blocker = Object.values(this.engine.state.knowledge.entities).find(entity => samePosition(entity.position, input.target) && (
            ['cabinet', 'airlock', 'switch'].includes(entity.type) || entity.type === 'door' && entity.state !== 'opened' || entity.type === 'obstacle' && entity.state !== 'cleared'
          ));
          if (blocker) {
            const message = blocker.type === 'door' ? `目标格的门 ${blocker.id} 尚未打开；请先在可达相邻格 interact open，再前往目标。`
              : blocker.type === 'obstacle' ? `目标格被障碍 ${blocker.id} 阻挡；请先在可达相邻格 interact clear，再前往目标。`
              : `目标格是设施 ${blocker.id}，不可进入或穿越；请前往可达的相邻格交互。`;
            const result = this.emptyResult('TARGET_BLOCKED', message);
            return { ...result, details: { ...result.details, targetReached: false } };
          }
          const route = this.toolRoute?.path ?? this.engine.knownPath(input.target, this.executionConstraints());
          let outcome: ActionOutcome | null = null;
          let steps = 0;
          let costTU = 0;
          let stopCode = 'NO_KNOWN_PATH';
          let stopMessage = '当前已知条件下没有可通行路线，请检查门、障碍和危险授权。';
          const before = structuredClone(this.engine.state.knowledge);
          const generation = this.commandRevision;
          const external = this.externalRevision;
          this.engine.state.phase = 'executing';
          for (let index = 0; ; index++) {
            if (signal?.aborted || generation !== this.commandRevision || external !== this.externalRevision || this.control !== 'continue') { if (this.control === 'continue') this.control = 'redecide'; stopCode = 'MOVE_INTERRUPTED'; stopMessage = '移动已取消，或任务、共享状态已变化；请依据最新状态重新决策。'; break; }
            if (samePosition(this.engine.state.robot.position, input.target)) break;
            const next = route?.[index];
            if (!next) { this.control = 'redecide'; break; }
            const action: Action = { kind: 'move', target: next };
            if (!this.checkBudget(action)) { stopCode = 'BUDGET'; stopMessage = `移动因行动预算不足而中断：剩余 ${this.remainingBudget().remainingTU} TU，下一步需要 ${this.engine.actionCost(action).tu} TU，尚未抵达目标。`; break; }
            outcome = this.commit(action, `${id}:${index}`);
            costTU += outcome.cost.tu;
            if (!outcome.accepted) { this.control = 'redecide'; stopCode = outcome.code; stopMessage = outcome.message; break; }
            steps++;
            if (this.engine.terminal) { this.control = 'game_over'; stopCode = 'GAME_OVER'; stopMessage = this.engine.state.failureReason ?? '游戏已结束，移动停止。'; break; }
            const delta = this.movementDelta(outcome.delta, route!.slice(index + 1));
            if (this.significant(delta)) {
              this.metrics.interrupts++;
              this.control = 'redecide';
              const discoveries = delta.newDiscoveries;
              stopCode = this.newActiveHazard(delta) ? 'NEW_HAZARD' : discoveries.some(entity => entity.type === 'obstacle') ? 'NEW_OBSTACLE' : discoveries.some(entity => entity.type === 'door') ? 'NEW_DOOR' : 'NEW_DISCOVERY';
              stopMessage = `发现 ${[...discoveries, ...delta.stateChanges].map(entity => `${entity.name} ${entity.id} (${entity.position.x}, ${entity.position.y})`).join('、')}，移动已中断，尚未抵达目标；不代表预算耗尽。`;
              break;
            }
            if (this.delayMs) await new Promise<void>(resolve => setTimeout(resolve, this.delayMs));
          }
          const reached = samePosition(this.engine.state.robot.position, input.target);
          const result: ToolOutcome = { accepted: steps > 0 || reached, code: reached ? 'OK' : stopCode, message: reached ? '已到达目标。' : stopMessage, executedSteps: steps, targetReached: reached, delta: diffKnowledge(before, this.engine.state.knowledge), costTU };
          return { content: [{ type: 'text', text: result.message }], details: result };
        },
      },
      {
        name: 'scan', label: '扫描', description: '精确检查当前可见的已知对象，要求曼哈顿距离≤1（上下左右相邻或同格，斜对角不算）；参考 knownEntities[].interaction.canScan 和 reason，不会扫描未识别目标。', executionMode: 'sequential',
        parameters: Type.Object({ targetId: Type.String() }, { additionalProperties: false }),
        execute: async (id, raw) => {
          const input = raw as { targetId: string };
          const action: Action = { kind: 'scan', targetId: input.targetId };
          if (!this.checkBudget(action)) return this.emptyResult('BUDGET', '行动预算不足。');
          return this.actionResult(this.commit(action, id));
        },
      },
      {
        name: 'interact', label: '交互', description: `操作附近已知对象。开柜和修复气闸控制器需在可达的相邻格进行，设施所在格不可进入。参数按 operation 区分：${Object.entries(interactionUsage).map(([operation, usage]) => `${operation}：${usage}`).join('；')}。未获授权的维修和放下由程序在执行前弹出按钮；设备缺电时须先寻找并靠近实体开关的可达相邻格，用set_circuit通电。`, executionMode: 'sequential',
        parameters: Type.Object({
          operation: Type.Union(Object.keys(interactionUsage).map(value => Type.Literal(value))),
          targetId: Type.Optional(Type.String({ description: '操作目标。use_item 只能填 "human"（氧气补给）或 "robot"（备用电池）；repair 修补供氧管填 "human"；其他对象操作填已知实体 ID。' })),
          itemId: Type.Optional(Type.String({ description: '背包物品 ID，use_item 和 drop_item 必填。use_item 中物品 ID 填这里，作用对象填 targetId。' })),
        }, { additionalProperties: false }),
        execute: async (id, raw) => {
          const input = raw as { operation: string; targetId?: string; itemId?: string };
          const action = interactionAction(input);
          if (!action) return this.emptyResult('INVALID_ACTION', `交互参数不完整：${input.operation} ${interactionUsage[input.operation] ?? '不是支持的操作'}。`);
          if (!this.checkBudget(action)) return this.emptyResult('BUDGET', '行动预算不足。');
          return this.actionResult(this.commit(action, id));
        },
      },
      {
        name: 'set_circuit', label: '操作电路开关', description: '机器人在可达的相邻格操作已识别、视线可及的实体开关，开关所在格不可进入或穿越，通断电均不会解除阻挡。开启可能激活漏电；需要授权时在此工具执行前等待按钮。不能远程切换。', executionMode: 'sequential',
        parameters: Type.Object({ targetId: Type.String(), on: Type.Boolean() }, { additionalProperties: false }),
        execute: async (id, raw) => {
          const input = raw as { targetId: string; on: boolean };
          const action: Action = { kind: 'circuit', targetId: input.targetId, on: input.on };
          if (!this.checkBudget(action)) return this.emptyResult('BUDGET', '行动预算不足。');
          return this.actionResult(this.commit(action, id));
        },
      },
      {
        name: 'get_status', label: '状态', description: '查询机器人已有知识、当前有效的共享标记 sharedMarkers 和共同遥测；已移除及私有标记不在列表中，不查询隐藏实体。', executionMode: 'sequential', parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => ({ content: [{ type: 'text', text: JSON.stringify(this.modelContext()) }], details: undefined }),
      },
      {
        name: 'report', label: '报告', description: '给玩家简短报告，事实应来自可见观察；不会结束委托。整项委托完成时直接调用 finish_task。', executionMode: 'sequential', parameters: Type.Object({ text: Type.String({ maxLength: 800, description: '直接展示给玩家的话：用自然口语说明事实，以名称和必要位置指代对象，不含内部 ID、工具名称或状态字段。' }) }, { additionalProperties: false }),
        execute: async (_id, raw) => { this.say('robot', (raw as { text: string }).text); return this.emptyResult('OK', '报告已发送。'); },
      },
      {
        name: 'ask_player', label: '询问', description: '需要玩家决定或操作时暂停，并提出明确问题。', executionMode: 'sequential', parameters: Type.Object({ question: Type.String({ maxLength: 800, description: '直接展示给玩家的问题：用自然口语说清需要决定的事，以名称和必要位置指代对象，不含内部 ID、工具名称或状态字段。' }) }, { additionalProperties: false }),
        execute: async (_id, raw) => { this.waitForPlayer((raw as { question: string }).question); return { ...this.emptyResult('WAIT_PLAYER', '等待玩家决定。'), terminate: true }; },
      },
      {
        name: 'finish_task', label: '结束任务', description: '实际工具结果或最新遥测支持整项委托完成时必须调用，在 reason 中简述完成依据；仅结束本次委托，不改变游戏胜负。', executionMode: 'sequential', parameters: Type.Object({ reason: Type.String({ maxLength: 800, description: '直接展示给玩家的收尾话：用自然口语简述实际结果与完成依据，以名称和必要位置指代对象，不含内部 ID、工具名称或状态字段。' }) }, { additionalProperties: false }),
        execute: async (_id, raw) => {
          if (this.task?.interpretation === 'demo' && !this.taskSatisfied()) {
            this.pause('当前目标尚未满足，任务保留。'); this.control = 'wait_player';
            return { ...this.emptyResult('TASK_INCOMPLETE', '本地演示目标尚未满足。'), terminate: true };
          }
          this.control = 'task_done'; if (this.task) this.task.status = 'completed';
          this.say('robot', (raw as { reason: string }).reason);
          return { ...this.emptyResult('TASK_DONE', '本次自动运行结束。'), terminate: true };
        },
      },
    ];
  }

  private actionResult(outcome: ActionOutcome): { content: { type: 'text'; text: string }[]; details: ToolOutcome } {
    return { content: [{ type: 'text', text: outcome.message }], details: { ...outcome, costTU: outcome.cost.tu } };
  }
  private emptyResult(code: string, message: string): { content: { type: 'text'; text: string }[]; details: ToolOutcome } {
    return { content: [{ type: 'text', text: message }], details: { accepted: code === 'OK' || code === 'TASK_DONE', code, message, delta: emptyDelta(), costTU: 0 } };
  }

  private demoIntents(): ToolIntent[] {
    const task = this.task;
    if (!task) return [{ name: 'ask_player', arguments: { question: '请给我一个目标。' } }];
    if (!task.goal || !task.demoSupported) return [{ name: 'ask_player', arguments: { question: demoHelp } }];
    const goal = task.goal;
    if (goal.kind === 'rescue') {
      const actions = this.engine.level.verification?.actions;
      if (!actions?.length) return [{ name: 'ask_player', arguments: { question: '本地图尚未配置规则通关路线，请先在地图 JSON 中配置 verification.actions。' } }];
      const ledger = this.engine.state.ledger;
      if (ledger.length > actions.length || ledger.some((entry, index) => !isDeepStrictEqual(entry.action, actions[index]))) return [{ name: 'ask_player', arguments: { question: '当前进度已偏离预设通关路线，请新建本地图对局后启动规则通关，或继续手动指挥。' } }];
      return actions.slice(ledger.length, ledger.length + this.engine.level.rules.toolLimit).map(action => {
        const { kind, ...args } = action;
        if (kind === 'move') return { name: 'move_to', arguments: args };
        if (kind === 'scan') return { name: 'scan', arguments: args };
        if (kind === 'circuit') return { name: 'set_circuit', arguments: args };
        return { name: 'interact', arguments: { operation: kind, ...args } };
      });
    }
    const go = (target: Position): ToolIntent => ({ name: 'move_to', arguments: { target } });
    const interact = (operation: string, targetId?: string, itemId?: string): ToolIntent => ({ name: 'interact', arguments: { operation, ...(targetId ? { targetId } : {}), ...(itemId ? { itemId } : {}) } });
    if (this.taskSatisfied()) return [{ name: 'finish_task', arguments: { reason: '本次目标已完成。' } }];
    if (this.engine.exitStatus === 'leaking' && (goal.kind === 'extract' || goal.kind === 'goto' && goal.position && samePosition(goal.position, this.engine.level.exit))) return [{ name: 'ask_player', arguments: { question: '出口正在漏气喷射，修复气闸控制器后才能进入和撤离。请先委托维修气闸，或选择出口附近的安全位置。' } }];
    if (goal.kind === 'goto' && goal.position) return [go(goal.position)];
    if (goal.kind === 'pickup') return [go(this.engine.state.human.position), interact('pickup_human')];
    if (goal.kind === 'extract') return [go(this.engine.level.exit), interact('extract')];
    const known = Object.values(this.engine.state.knowledge.entities);
    if (goal.kind === 'circuit') return this.demoCircuitIntents(goal.on ?? false, known.find(e => e.type === 'cabinet'));
    if (goal.kind === 'collect') {
      const owned = this.engine.state.robot.inventory.find(id => this.engine.state.knowledge.entities[id]?.itemType === goal.itemType);
      if (owned && goal.returnHome) return [go(this.engine.state.human.position)];
      const item = known.find(e => e.itemType === goal.itemType && e.state === 'available');
      if (item) return [go(this.approach(item)), interact('collect', item.id), ...(goal.returnHome ? [go(this.engine.state.human.position)] : [])];
      const cabinet = known.find(e => e.type === 'cabinet' && e.state === 'closed');
      if (cabinet) {
        if (cabinet.scanned && cabinet.powerRequired && !this.engine.state.circuitOn) return this.demoCircuitIntents(true, cabinet);
        return [go(this.approach(cabinet)), ...(!cabinet.scanned ? [{ name: 'scan', arguments: { targetId: cabinet.id } }] : []), interact('open', cabinet.id)];
      }
      return this.demoSearchIntents('尚未找到所需物资，请指示继续搜索的位置。', goal.searchPosition);
    }
    if (goal.kind === 'repair') {
      const material = this.engine.state.robot.inventory.find(id => this.engine.state.knowledge.entities[id]?.itemType === 'repair');
      if (!material) {
        const item = known.find(e => e.itemType === 'repair' && e.state === 'available');
        if (item) return [go(this.approach(item)), interact('collect', item.id)];
        return this.demoSearchIntents('尚未找到维修材料，请指示继续搜索的位置。');
      }
      const target = known.find(e => e.type === 'airlock');
      if (goal.targetId === 'human') return [go(this.engine.state.human.position), interact('repair', 'human')];
      if (target) return [go(this.approach(target)), interact('repair', target.id)];
      return this.demoSearchIntents('尚未找到气闸控制器，请指示搜索区域。');
    }
    return [{ name: 'ask_player', arguments: { question: demoHelp } }];
  }

  private demoCircuitIntents(on: boolean, device?: ObservedEntity): ToolIntent[] {
    const knownSwitch = Object.values(this.engine.state.knowledge.entities).find(e => e.type === 'switch');
    if (knownSwitch) return [
      { name: 'move_to', arguments: { target: this.approach(knownSwitch) } },
      { name: 'set_circuit', arguments: { targetId: knownSwitch.id, on } },
    ];
    return this.demoSearchIntents('尚未发现可触及的辅助电路开关，请指示我继续搜索的位置。', device?.position);
  }

  private demoSearchIntents(question: string, center?: Position): ToolIntent[] {
    // Search public floor and unexplored echoes, without guessing their entity types.
    const known = Object.values(this.engine.state.knowledge.entities);
    const { width, height, tiles } = this.engine.level;
    const map = { width, height, tiles, entities: known.filter(e => e.type === 'door') };
    const radius = this.engine.level.rules.sensorRadius;
    const positions = [this.engine.level.robotStart, this.engine.state.robot.position, ...this.engine.state.ledger.filter(e => e.action.kind === 'move').map(e => e.position)];
    const observed = new Set(positions.flatMap(p => sensorCells(map, p, radius)).map(p => `${p.x},${p.y}`));
    const unknown = this.engine.state.radarHistory.filter(echo => !known.some(e => samePosition(e.position, echo.position)));
    const candidates: { target: Position; nearby: boolean; signal: boolean; distance: number; newCells: number }[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const target = { x, y };
      if (tiles[y][x] === '#' || samePosition(target, this.engine.state.robot.position)) continue;
      const visible = sensorCells(map, target, radius);
      const newCells = visible.filter(p => !observed.has(`${p.x},${p.y}`)).length;
      if (!newCells) continue;
      candidates.push({ target, nearby: !!center && distance(target, center) <= 2, signal: unknown.some(echo => visible.some(p => samePosition(p, echo.position))), distance: distance(target, this.engine.state.robot.position), newCells });
    }
    candidates.sort((a, b) => Number(b.nearby) - Number(a.nearby) || Number(b.signal) - Number(a.signal) || a.distance - b.distance || b.newCells - a.newCells);
    const candidate = candidates.find(({ target }) => this.engine.knownPath(target, this.task?.constraints)?.length);
    return candidate ? [{ name: 'move_to', arguments: { target: candidate.target } }] : [{ name: 'ask_player', arguments: { question } }];
  }

  private approach(entity: ObservedEntity): Position {
    const adjacent = [{ x: entity.position.x - 1, y: entity.position.y }, { x: entity.position.x, y: entity.position.y + 1 }, { x: entity.position.x + 1, y: entity.position.y }, { x: entity.position.x, y: entity.position.y - 1 }];
    const candidates = entity.type === 'supply' || entity.type === 'switch' ? [entity.position, ...adjacent] : adjacent;
    const routes = candidates.map(target => ({ target, path: this.engine.knownPath(target, this.task?.constraints) })).filter(item => item.path !== null).sort((a, b) => a.path!.length - b.path!.length);
    return routes[0]?.target ?? entity.position;
  }

  async command(text: string, selected?: Position, expectedRevision?: number): Promise<void> {
    await this.serial(async () => {
      await this.cancelRunning();
      if (expectedRevision !== undefined && expectedRevision !== this.engine.state.stateRevision) throw new RevisionConflictError('地图状态已更新，请根据最新信息重试');
      if (this.engine.terminal) throw new Error('本局已经结束，请创建新局。');
      this.commandRevision++;
      this.task = { id: crypto.randomUUID(), text, ...(selected ? { selected: { ...selected } } : {}), interpretation: this.adapter.mode === 'live' ? 'model' : 'demo', status: 'active', question: null, constraints: defaultConstraints() };
      this.taskMemory = this.newTaskMemory();
      this.interpretTask();
      this.deniedCalls.clear();
      this.say('human', text);
      await this.startRun(text);
    });
  }

  private async startRun(text: string): Promise<void> {
    await this.adapter.checkReady?.();
    if (this.adapter.ready === false) { this.modelError = '未找到可用的模型凭据，请检查 pi 登录、API Key 或模型设置。'; this.pause(this.modelError); this.emit(); return; }
    this.modelError = null;
    this.runTU = 0; this.requestCount = 0; this.noProgressTurns = 0; this.budgetStopReason = null; this.closingTurn = false; this.control = 'continue'; this.running = true;
    this.record('自动运行开始', { text, task: this.task, stateRevision: this.engine.state.stateRevision });
    if (this.task) { this.task.status = 'active'; this.task.question = null; this.task.waitReason = undefined; }
    this.currentPromise = this.agent.prompt(text).catch(error => {
      this.modelError = modelErrorMessage(error); this.pause(this.modelError);
      this.record('自动运行异常', { error: this.modelError }, true);
    }).finally(() => {
      this.running = false;
      if (this.closingTurn && this.task && this.control !== 'task_done') this.cancelTask('预算收尾结束，尚未确认整项委托完成，委托已取消；后续行动请重新下达指令。');
      if (!this.engine.terminal && this.control === 'task_done') this.engine.state.phase = 'awaiting_command';
      else if (!this.engine.terminal && this.engine.state.phase === 'executing') this.engine.state.phase = 'paused';
      this.emit();
    });
    this.emit();
  }

  private async cancelRunning(): Promise<void> {
    if (this.running) this.record('取消当前运行', { commandRevision: this.commandRevision, elapsedTU: this.engine.state.elapsedTU }, true);
    this.commandRevision++; this.control = 'wait_player'; this.agent.abort();
    this.resolveRouteSelection('cancel');
    this.resolveAuthorization('cancel');
    await this.currentPromise; await this.agent.waitForIdle();
    this.currentPromise = null;
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.operationSerial.then(operation);
    this.operationSerial = promise.catch(() => undefined);
    return promise;
  }

  async stop(): Promise<void> { await this.serial(async () => { await this.cancelRunning(); this.cancelTask('已停止，委托已取消，请重新下达指令。未执行动作不消耗资源。'); this.emit(); }); }

  async manual(action: Action, requestId: string, allowHazard = false, expectedRevision?: number): Promise<ActionOutcome> {
    return this.serial(async () => {
      await this.cancelRunning();
      if (expectedRevision !== undefined && expectedRevision !== this.engine.state.stateRevision) throw new RevisionConflictError('地图状态已更新，请根据最新信息重试');
      const constraints = defaultConstraints();
      if (allowHazard) constraints.authorizedHazardIds = Object.values(this.engine.state.knowledge.entities).filter(e => e.type === 'hazard').map(e => e.id);
      const outcome = this.engine.perform(action, requestId, constraints);
      this.record('玩家手动动作', { action, outcome, robot: this.engine.state.robot, human: this.engine.state.human });
      if (!this.engine.terminal) this.engine.state.phase = 'paused';
      if (this.task && this.task.status === 'active') this.task.status = 'paused';
      this.say(outcome.accepted ? 'robot' : 'system', outcome.message);
      this.emit(); return outcome;
    });
  }

  marker(position: Position, note: string, shared: boolean): void {
    this.engine.addMarker(position, note, shared);
    this.record('玩家添加标记', { position, note, shared, elapsedTU: this.engine.state.elapsedTU });
    if (shared) {
      this.externalRevision++;
      this.resolveRouteSelection('stale');
      this.resolveAuthorization('stale');
      this.engine.state.knowledge.markers = this.engine.state.markers.filter(marker => marker.shared);
      this.say('human', `标记 (${position.x}, ${position.y})：${note || '请检查此处'}。回波的具体对象尚未确认。`);
    }
    this.emit();
  }

  removeMarker(id: string): void {
    const marker = this.engine.removeMarker(id);
    this.record('玩家移除标记', { ...marker, elapsedTU: this.engine.state.elapsedTU });
    if (marker.shared) {
      this.externalRevision++;
      this.resolveRouteSelection('stale');
      this.resolveAuthorization('stale');
      this.say('human', `已移除共享标记 (${marker.position.x}, ${marker.position.y})：${marker.note || '未填写说明'}。请以当前共享标记列表为准。`);
    }
    this.emit();
  }

  view(): SessionView { return { ...this.engine.playerView(), sessionId: this.id, sessionInstanceId: this.instanceId, eventId: this.eventId, task: structuredClone(this.task), messages: structuredClone(this.messages), metrics: { ...this.metrics }, demoRescueAvailable: !!this.engine.level.verification?.actions.length, agentMode: this.adapter.mode, agentLabel: this.adapter.label, running: this.running, modelConfig: { ...(this.adapter.config ?? defaultModelConfig) }, modelReady: this.adapter.ready !== false, modelError: this.modelError, modelCredentialSource: this.adapter.credentialSource ?? 'none', pendingAuthorization: structuredClone(this.pendingAuthorization), pendingRouteSelection: structuredClone(this.pendingRouteSelection) }; }
  save(): SessionSave { return { version: 1, id: this.id, level: structuredClone(this.engine.level), engine: this.engine.snapshot(), task: structuredClone(this.task), ...(this.taskMemory ? { taskMemory: structuredClone(this.taskMemory) } : {}), messages: structuredClone(this.messages), metrics: { ...this.metrics }, eventId: this.eventId, modelConfig: { ...(this.adapter.config ?? defaultModelConfig) } }; }
  async restore(save: SessionSave, apiKey?: string): Promise<void> {
    if (save.version !== 1 || save.id !== this.id) throw new Error('存档版本或会话不匹配');
    this.engine.restore(save.engine); this.task = structuredClone(save.task); this.messages = save.messages; this.metrics = save.metrics; this.eventId = save.eventId;
    this.taskMemory = this.task ? structuredClone(save.taskMemory ?? this.newTaskMemory()) : null;
    if (save.modelConfig) {
      const config = validateModelConfig(save.modelConfig);
      this.adapter = config.mode === 'live' ? await liveModel(config, apiKey) : this.demoAdapter(config);
      this.modelKey = config.mode === 'live' ? apiKey ?? '' : '';
      this.agent.state.model = this.adapter.model; this.agent.streamFunction = this.adapter.streamFn;
      if (this.adapter.ready === false) this.modelError = '存档的真实模型未找到可用凭据，请检查 pi 登录、API Key 或模型设置。';
    }
    if (this.task) {
      const legacyLiveTask = this.adapter.mode === 'live' && this.task.interpretation !== 'model';
      this.interpretTask();
      if (legacyLiveTask) this.task.status = 'paused';
    }
    if (this.task && (this.task.status === 'active' || this.task.waitReason === 'authorization' || this.task.waitReason === 'power' || this.task.waitReason === 'route')) { this.task.status = 'paused'; this.task.question = null; this.task.waitReason = undefined; }
  }
  async settled(): Promise<void> { await this.currentPromise; await this.journal?.flush(); }
}

export function interactionAction(input: { operation: string; targetId?: string; itemId?: string }): Action | null {
  const operation = input.operation;
  if (['open', 'collect', 'repair', 'clear'].includes(operation) && input.targetId) return { kind: operation as 'open' | 'collect' | 'repair' | 'clear', targetId: input.targetId };
  if (operation === 'drop_item' && input.itemId) return { kind: 'drop_item', itemId: input.itemId };
  if (operation === 'use_item' && input.itemId && (input.targetId === 'human' || input.targetId === 'robot')) return { kind: 'use_item', itemId: input.itemId, targetId: input.targetId };
  if (operation === 'pickup_human' || operation === 'drop_human' || operation === 'extract') return { kind: operation };
  return null;
}
