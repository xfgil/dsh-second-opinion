/**
 * dsh-second-opinion / index.js
 *
 * 跨会话「第二意见」：一个会话卡住时，把问题连同它自己的判断交给另一个
 * 独立会话单独思考，把方案拿回来。
 *
 * ## 为什么是同步的（这是本插件的设计核心）
 *
 * 宿主其实已经提供了一条更省事的思路：把问题投递给顾问会话，让它跑完，
 * 再把答案投递回来。那条路走不通，因为**跨会话回传需要唤醒一个已经闲置的
 * 会话**，而宿主只给了两条唤起通道，都不合用：
 *
 *   - `sessionController.prompt` 能自动 resume + 唤醒，但它把消息来源硬编码
 *     成 `kind: "user"`（`@deepseek-ai/dsh-api-session-controller` 内
 *     `const source = { kind: "user", rpcId: request.requestId, ... }`），
 *     用它回传，求助方看到的是**「用户本人发言」**——冒充用户，不可接受；
 *   - `send_message` 走的是父子的 `agent-message` 正规来源，但被授权档位
 *     限制在父子链上，够不着「任意两个平级会话」。
 *
 * 所以这里改走**同步咨询**：求助方在自己的工具调用里等顾问会话跑完，答案
 * 直接作为**工具结果**回到求助方手里。工具结果天然属于发出调用的那个会话，
 * 根本不需要任何跨会话投递，也就绕开了上面两条限制，而且不冒充任何人。
 *
 * 代价是求助方在等待期间是阻塞的——这对「我卡住了，请独立想一遍」正是想要
 * 的语义：它本来就该停下来等一个外部判断，而不是一边打转一边等。
 *
 * ## 触发方式（双路线）
 *
 *   1. **A 自己判断卡住了** → 直接调用 `ask_advisor` 工具。
 *   2. **用户说一声「卡住了」** → 用户的话进到 A 的上下文，A 同样调这个工具。
 *
 * 插件不做行为流监听。理由见 README：打转当下每一步都像在推进，站在里面的
 * 那个会话识别不出自己在打转；真要做被动检测，得另写一个站在外面读会话日志
 * 的观察者，那是另一个插件的事。
 *
 * ## 三条硬约束（都是踩过的坑）
 *
 *   - **绝不阻断对话**：工具内部整段 try/catch，出错返回错误对象而不是抛。
 *   - **同一顾问必须串行**：两个会话同时咨询同一个顾问时，后者的答案边界会
 *     和前者重叠，导致读到别人的回答。用 per-advisor 的 Promise 链排队。
 *   - **绝不导出 Config schema**：profile 侧解析不到 schemastery，导出非
 *     schema 对象会让 loader 投影 config 时报错（dsh-onebot-guard 的教训）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADVISOR_INTRO, buildConsultPrompt, extractAnswer, clamp } from './compose.js';

export const name = 'second-opinion';

/**
 * 顾问会话、会话控制器、agent 服务都是宿主自带能力，缺失时工具会如实报错，
 * 所以放进 `ctx.inject` 而不是硬依赖声明。
 */
export const inject = [];

const DEFAULTS = {
  /** 总开关。关掉后不注册任何工具。 */
  enabled: true,
  /** 单次咨询等待顾问的上限（毫秒）。超时不杀顾问，只是求助方这边放弃等待。 */
  waitMs: 10 * 60 * 1000,
  /** 顾问会话的工作目录；空则跟随求助方会话的 cwd（推荐，顾问才看得到同一批文件）。 */
  cwd: '',
  /** 传给顾问的提示词上限（字符）。 */
  maxPromptChars: 20000,
  /** 返回给求助方的答案上限（字符）。 */
  maxAnswerChars: 12000,
  /** 状态文件；空则用 `$DSH_HOME/second-opinion/state.json`。 */
  stateFile: '',
  /** 顾问会话的固定 id 前缀（仅用于命名，不是硬约束）。 */
  advisorLabel: 'second-opinion-advisor',
};

const TOOL_NAME = 'ask_advisor';

/**
 * 可选的加载期诊断。
 *
 * 默认静默：`ctx.logger` 才是正式通道，不该在每次加载时都往磁盘写文件。
 * 需要盯「插件加载到哪一步」这类启动期时序时，设
 * `DSH_SECOND_OPINION_DEBUG=1`，才会往 `$DSH_HOME/second-opinion/diag.log`
 * 追加一行。
 */
function diag(message) {
  if (!process.env.DSH_SECOND_OPINION_DEBUG) return;
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'second-opinion', 'diag.log');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${new Date().toISOString()} ${message}\n`, { flag: 'a' });
  } catch {
    /* 诊断本身绝不能影响加载 */
  }
}

export function apply(ctx, rawConfig = {}) {
  diag('apply-enter');
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  if (config.enabled === false) return;

  const stateFile = String(config.stateFile || '') || defaultStateFile();
  const state = loadState(stateFile);

  /** 同一顾问的咨询排队，避免答案边界互相污染。 */
  const queues = new Map();

  function log(level, message, extra) {
    const logger = ctx.logger;
    if (logger && typeof logger[level] === 'function') {
      if (extra === undefined) logger[level](`[second-opinion] ${message}`);
      else logger[level](`[second-opinion] ${message}`, extra);
      return;
    }
    if (level === 'error') console.error(`[second-opinion] ${message}`, extra ?? '');
  }

  function persist() {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      log('warn', `状态写入失败（不影响本次咨询）：${describe(error)}`);
    }
  }

  /**
   * 取得顾问会话的活 Agent，必要时创建。
   *
   * `resolveAgent` 已经处理了「已活则直接返回 / 已持久化则 resume」两种情况，
   * 所以这里只需要负责「完全没有」时的创建。
   *
   * @param {string} cwd 顾问会话的工作目录。
   * @returns {Promise<object>} 顾问会话的 Agent。
   */
  async function ensureAdvisor(cwd) {
    const controller = ctx.get('sessionController');
    if (!controller) throw new Error('sessionController 不可用（宿主版本过旧？）');

    if (typeof state.advisorSessionId === 'string' && state.advisorSessionId !== '') {
      const resolved = await controller.resolveAgent(state.advisorSessionId);
      // resolveAgent 返回 { agent } | { error } 的联合类型，必须显式判 error，
      // 不能只看有没有 agent——否则失败会被当成成功，后面的调用全崩。
      if (resolved && !('error' in resolved) && resolved.agent) {
        // 顾问的工作目录跟随求助方而非固定值，否则换了工作区就看错文件。
        return resolved.agent;
      }
      log('warn', `旧顾问会话 ${state.advisorSessionId} 无法恢复，重新创建一个`);
      state.advisorSessionId = '';
    }

    const created = await controller.create(cwd ? { cwd } : {});
    const sessionId = created?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('创建顾问会话失败：宿主没有返回 sessionId');
    }
    state.advisorSessionId = sessionId;
    state.createdAt = Date.now();
    persist();

    const resolved = await controller.resolveAgent(sessionId);
    if (!resolved || 'error' in resolved || !resolved.agent) {
      const reason =
        resolved && 'error' in resolved
          ? resolved.error?.message ?? resolved.error?.code ?? '未知原因'
          : '宿主未返回 agent';
      throw new Error(`创建后无法取得顾问会话 ${sessionId}：${reason}`);
    }

    // 自我介绍只发一次：顾问会话需要知道自己的角色与边界。
    const agent = resolved.agent;
    try {
      const intro = buildUserMessage(ADVISOR_INTRO, 'second-opinion-intro');
      agent.followup(intro);
      await agent.whenIdle();
    } catch (error) {
      log('warn', `顾问自我介绍发送失败（继续咨询）：${describe(error)}`);
    }
    log('info', `已创建顾问会话 ${sessionId}`);
    return agent;
  }

  /**
   * 向顾问提一次问，等它答完，取回答案正文。
   *
   * 同步等待是本插件能工作的前提：答案作为工具结果回到求助方，不经过任何
   * 跨会话投递，因此不需要唤醒闲置会话、也不冒充用户发言。
   *
   * @param {object} agent 顾问会话的 Agent。
   * @param {string} prompt 提示词全文。
   * @param {number} waitMs 等待上限。
   * @returns {Promise<{answer: string, elapsedMs: number, timedOut: boolean}>}
   */
  async function consult(agent, prompt, waitMs) {
    // 上一次咨询若是超时放弃的，顾问可能还在跑。必须先等它收尾，否则这次取出
    // 的事件区间会混进上一次回答的尾巴，答案就串了。
    await settleBefore(agent, waitMs);

    // 边界必须在投递**之前**取：之后任何新增事件都属于本次咨询。
    const boundary = agent.session.seq;
    const startedAt = Date.now();
    agent.followup(buildUserMessage(prompt, 'second-opinion-request'));

    const timedOut = await waitIdle(agent, waitMs);
    const events = agent.session.snapshotEvents(boundary);
    const answer = extractAnswer(events);
    return { answer, elapsedMs: Date.now() - startedAt, timedOut };
  }

  /**
   * 等顾问结束当前这一轮；返回是否等到了（true = 超时仍未结束）。
   *
   * 为什么不能只 `await agent.whenIdle()`：宿主 `wakeDriver` 在 agent 已经
   * 不是 idle 时**直接 return，不新建 activityDone**（`dsh-agent-loop`
   * `wakeDriver()` 开头 `if (this.phase.kind !== "idle") { ... return; }`）。
   * 那种情况下 `whenIdle()` 解析的是**上一轮**的 promise，会在本轮的答案
   * 产生之前就返回，令我们读到空结果。所以这里以 `agent.status` 为准做轮询，
   * `whenIdle()` 只作为加速用的信号。
   */
  async function waitIdle(agent, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) return agent.status === 'running';
      // 短 tick 兜底：即使 whenIdle() 因上述原因提前解析，也很快会重查状态。
      await Promise.race([
        agent.whenIdle(),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(remain, 250));
          timer.unref?.();
        }),
      ]);
      if (agent.status !== 'running') return false;
    }
  }

  /**
   * 等上一次遗留的咨询收尾。
   *
   * 只在顾问确实还在跑时才等，且给一个不长的上限——等待本身不是目的，
   * 目的是让本次取到的边界干净。等不到就让上层照常走（答案可能含上一次的
   * 尾巴，但至少不会永久卡死）。
   */
  async function settleBefore(agent, waitMs) {
    if (agent.status !== 'running') return;
    log('info', '顾问仍在处理上一次咨询，先等它收尾再提问');
    const settled = !(await waitIdle(agent, Math.min(waitMs, 60_000)));
    if (!settled) log('warn', '顾问上一轮仍未结束，本次答案可能包含其残留输出');
  }

  /** 把一次咨询排进对应顾问的串行队列。 */
  function enqueue(advisorId, task) {
    const previous = queues.get(advisorId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // 队列本身不携带失败：失败在 task 内部已经转成了返回值。
    queues.set(
      advisorId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  ctx.inject(['tools'], (toolCtx) => {
    diag(`inject-tools-fired hasRegister=${typeof toolCtx?.tools?.register}`);
    toolCtx.effect(
      () => {
        diag('effect-ask_advisor-fired');
        let disposer;
        try {
          disposer = toolCtx.tools.register({
          name: TOOL_NAME,
          description:
            '把一个卡住的问题交给独立的「第二意见」顾问会话单独思考，拿回它的判断和方案。' +
            '适用于：你反复试错、来回修改同一处却进展不顺，或用户提示你「卡住了」的时候。' +
            '顾问看不到你的对话记录，只有你在这里写给它的内容——所以 situation/tried/context 要写全。' +
            '顾问由插件自动创建并复用，不需要用户介入。',
          // parameters 必须是**完整 JSON Schema**，不能写 defineTool() 那套扁平
          // 属性映射。宿主 register() 只校验 output.schema，对 parameters 不做
          // 任何编译（见 @deepseek-ai/dsh-tools 的 register 实现）——扁平写法会
          // 被原样透传给上游，触发 invalid_function_parameters / code 11129
          // （「工具定义不合规，请新建任务重试」）。2026-10-14 实测踩坑。
          // 另外 required 只能出现在对象层（数组形式），不能写在单个属性里。
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: '你要顾问回答的具体问题。写成一个明确的问句，而不是「帮帮我」。',
              },
              situation: {
                type: 'string',
                description: '你卡在哪：正在做什么、期望什么、实际发生什么。',
              },
              tried: {
                type: 'string',
                description: '你已经试过哪些做法、各自为什么不行。这段最有价值：它让顾问不必重复你的死路。',
              },
              context: {
                type: 'string',
                description: '相关上下文原文：文件路径、代码片段、报错信息。顾问会自己读文件，但描述能省它一轮。',
              },
            },
            required: ['question'],
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [
              { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
            ],
          },
          // 咨询会串行排队，并发调用同一顾问只会互相等待，所以按不安全处理。
          isConcurrencySafe: () => false,
          execute: async (args, exec) => {
            const self = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : null;
            if (self === null) return { error: 'no session in scope' };

            const question = String(args?.question ?? '').trim();
            if (question === '') return { error: 'question is required' };

            // 防止顾问自己求助自己形成递归。
            if (self === state.advisorSessionId) {
              return { error: '顾问会话不能调用 ask_advisor（会递归）。请直接给出你的判断。' };
            }

            const cwd = String(config.cwd || '') || String(exec?.agent?.session?.header?.cwd ?? '') || process.cwd();
            const waitMs = Math.max(1000, Number(config.waitMs) || DEFAULTS.waitMs);

            try {
              const agent = await ensureAdvisor(cwd);
              const advisorId = typeof agent.session?.id === 'string' ? agent.session.id : state.advisorSessionId;
              const advisorCwd = String(agent.session?.header?.cwd ?? '');

              // 提示词要在拿到顾问之后才组装：只有那时才知道顾问的实际目录，
              // 而两个目录不一致时必须写进去（否则相对路径会被解析到别处）。
              const prompt = buildConsultPrompt(
                {
                  from: self,
                  cwd,
                  advisorCwd,
                  situation: args?.situation,
                  tried: args?.tried,
                  context: args?.context,
                  question,
                },
                Math.max(500, Number(config.maxPromptChars) || DEFAULTS.maxPromptChars),
              );

              const result = await enqueue(advisorId, () => consult(agent, prompt, waitMs));
              state.consults = (Number(state.consults) || 0) + 1;
              state.lastConsultAt = Date.now();
              persist();

              if (result.answer === '') {
                return {
                  ok: false,
                  advisor: { sessionId: advisorId, cwd },
                  elapsedMs: result.elapsedMs,
                  timedOut: result.timedOut,
                  note: result.timedOut
                    ? `顾问会话在 ${Math.round(waitMs / 1000)} 秒内没有结束。它可能还在工作，你可以稍后直接查看该会话。`
                    : '顾问会话结束了这一轮但没有留下文字回答。可能是它只调用了工具就停了。',
                };
              }

              return {
                ok: true,
                advisor: { sessionId: advisorId, cwd },
                elapsedMs: result.elapsedMs,
                timedOut: result.timedOut,
                answer: clamp(result.answer, Math.max(200, Number(config.maxAnswerChars) || DEFAULTS.maxAnswerChars)),
              };
            } catch (error) {
              log('error', `咨询失败：${describe(error)}`);
              return { ok: false, error: describe(error) };
            }
          },
        });
        } catch (error) {
          diag(`register-ask_advisor-THREW ${error?.message ?? error}`);
          // 走正式日志通道，别再依赖上面那个按需开关。
          log('error', `注册工具 ${TOOL_NAME} 失败：${describe(error)}`);
          throw error;
        }
        diag(`register-ask_advisor-ok disposer=${typeof disposer}`);
        return disposer;
      },
      `${name}: ${TOOL_NAME}`,
    );

    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'advisor_status',
          description:
            '查「第二意见」顾问会话的状态：会话 id、工作目录、累计咨询次数、最近一次咨询时间。也用于在顾问行为异常时重新创建它。',
          // 同上：parameters 必须是完整 JSON Schema，扁平映射会被透传给上游。
          parameters: {
            type: 'object',
            properties: {
              reset: {
                type: 'boolean',
                description: '设为 true 则丢弃当前顾问会话记录，下次咨询会新建一个（不删除旧会话本身）。',
              },
            },
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [
              { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
            ],
          },
          isConcurrencySafe: () => true,
          execute: async (args) => {
            const previous = state.advisorSessionId || null;
            if (args?.reset === true && previous !== null) {
              state.advisorSessionId = '';
              persist();
            }
            const live = previous !== null ? Boolean(ctx.get('agents')?.get(previous)) : false;
            // 注意：返回值必须**无损 JSON**——`undefined` 不是合法 JSON，宿主的
            // `output.schema` 校验会判「value is not lossless JSON」把整个工具
            // 结果判为非法（2026-10-14 实测）。所以可选字段用 null，不用 undefined。
            return {
              advisorSessionId: state.advisorSessionId || null,
              previousAdvisorSessionId: args?.reset === true ? previous : null,
              cwd: String(config.cwd || '') || null,
              live,
              consults: Number(state.consults) || 0,
              lastConsultAt: state.lastConsultAt ? new Date(state.lastConsultAt).toISOString() : null,
              createdAt: state.createdAt ? new Date(state.createdAt).toISOString() : null,
              stateFile,
            };
          },
        }),
      `${name}: advisor_status`,
    );
  });
}

/**
 * 构造一条宿主可接受、且**带 id** 的 user 消息。
 *
 * id 是硬要求：宿主写入时不校验、读取时严格校验（`assertMessageEventShape`
 * 要求 `typeof message.id === 'string' && !== ''`），缺 id 的消息能顺利落盘，
 * 直到下次加载会话才整条炸掉——整个会话永久打不开。所以宁可自己补一个 uuid，
 * 也不能赌。
 *
 * @param {string} text 正文。
 * @param {string} kind 写进 source.kind 的标识，便于事后分辨来源。
 * @returns {object}
 */
function buildUserMessage(text, kind) {
  const content = [{ type: 'text', text }];
  const source = { kind, form: 'snapshot', sections: [{ name: kind, text }] };
  return deepFreeze({ id: randomUUID(), role: 'user', content, source });
}

/** 状态文件默认落在 DSH_HOME（与其它 DSH 插件一致）。 */
function defaultStateFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'second-opinion', 'state.json');
}

/**
 * 读状态。损坏时返回空表而不是让插件起不来——最坏情况只是重新建一个顾问。
 *
 * @param {string} file
 * @returns {object}
 */
function loadState(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function describe(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  return error.stack || error.message || String(error);
}

export default { name, apply };
