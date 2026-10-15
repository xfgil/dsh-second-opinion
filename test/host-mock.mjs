/**
 * dsh-second-opinion / test/host-mock.mjs
 *
 * selftest.mjs 只测 compose.js 的纯函数，index.js 一行都没测到——那是最大的
 * 盲区：工具注册、错误路径、顾问复用/重建、串行排队、答案边界、超时，全在那边。
 *
 * 这里用一个假的 ctx 把宿主顶掉，真实调用 `apply()`，把两条路走一遍：
 *   1. 注册出的工具形状正确、能拿到；
 *   2. 工具的 execute 在各条路径下的行为（正常回答、超时、空回答、递归、
 *      顾问恢复失败、创建失败、并发排队）。
 *
 * 它当然不能替代真实会话跑通（假的 agent 不会真的思考），但能钉住**契约**：
 * 谁抛错、谁返回错误对象、答案从哪段事件区间取。
 *
 * 运行：node test/host-mock.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 插件之前设好，否则状态文件会落到真实的 ~/.dsh 里。
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-second-opinion-test-'));
process.env.DSH_HOME = sandbox;

const { apply } = await import('../lib/index.js');

let pass = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    pass += 1;
    return;
  }
  failures.push(label);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass += 1;
    return;
  }
  failures.push(`${label}\n    实际: ${a}\n    期望: ${b}`);
}

// ── schema 校验器（照抄宿主的 enforced 子集）───────────────────────────────

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const CONSTRAINT_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples']);

/**
 * 校验一个 schema 节点是否落在宿主 `@deepseek-ai/dsh-tools` 的 enforced 子集里。
 *
 * 为什么测试里要复刻一遍：`tools.register()` **根本不校验 `parameters`**，只看
 * `output.schema`。所以 parameters 写错了注册照样成功，一路漏到真实请求才以
 * `invalid_function_parameters` / code 11129 炸掉——本地是唯一能在提交前拦住
 * 它的地方。2026-10-14 就是漏了这一步，把 `ask_advisor` 的扁平参数映射发了出去。
 *
 * @param {unknown} schema 待校验节点。
 * @param {string} path 诊断路径。
 * @param {string[]} out 违规描述收集器。
 */
function checkSchema(schema, path, out) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    out.push(`${path} 必须是对象`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) out.push(`${path}.${key} 不是受支持的关键字`);
  }
  const type = schema.type;
  if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
    out.push(`${path}.type 必须是 ${[...SCHEMA_TYPES].join('/')} 之一（当前 ${JSON.stringify(type)}）`);
    return;
  }
  if (type !== 'object') {
    for (const key of ['properties', 'required', 'additionalProperties']) {
      if (Object.hasOwn(schema, key)) out.push(`${path}.${key} 只能出现在 object 节点上`);
    }
  }
  if (type !== 'array' && Object.hasOwn(schema, 'items')) out.push(`${path}.items 只能出现在 array 节点上`);
  if (type === 'object') {
    if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
      out.push(`${path}.additionalProperties 必须是布尔`);
    }
    const props = schema.properties;
    if (props !== undefined && (props === null || typeof props !== 'object' || Array.isArray(props))) {
      out.push(`${path}.properties 必须是对象`);
    } else if (props !== undefined) {
      for (const [name, sub] of Object.entries(props)) checkSchema(sub, `${path}.properties.${name}`, out);
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((n) => typeof n !== 'string')) {
        out.push(`${path}.required 必须是字符串数组`);
      } else if (props && typeof props === 'object' && !Array.isArray(props)) {
        for (const name of schema.required) {
          if (!Object.hasOwn(props, name)) out.push(`${path}.required 引用了不存在的属性 ${name}`);
        }
      }
    }
  }
  if (type === 'array' && schema.items !== undefined) checkSchema(schema.items, `${path}.items`, out);
  if (Array.isArray(schema.enum) && schema.enum.length === 0) out.push(`${path}.enum 不能为空数组`);
}

/** 校验一个已注册工具；返回违规描述（空数组 = 合规）。 */
function toolSchemaViolations(tool) {
  const out = [];
  const parameters = tool.parameters;
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    out.push('parameters 必须是对象');
    return out;
  }
  if (parameters.type !== 'object') {
    out.push(
      `parameters.type 必须是 "object"（当前 ${JSON.stringify(parameters.type)}）` +
        '—— 扁平属性映射会被原样透传给上游，触发 code 11129',
    );
  }
  checkSchema(parameters, 'parameters', out);
  checkSchema(tool.output.schema, 'output.schema', out);
  return out;
}

// ── 假宿主 ────────────────────────────────────────────────────────────────

/**
 * 造一个假 ctx。
 *
 * `inject` 要同步回调（真实 Cordis 是 effect 里的），这里直接调用以便 apply
 * 返回后就能拿到注册结果。
 */
function makeCtx({ controller, titles, agents } = {}) {
  const tools = new Map();
  const ctx = {
    logger: undefined,
    get(name) {
      if (name === 'sessionController') return controller;
      if (name === 'sessionTitle') return titles;
      if (name === 'agents') return agents ?? { get: () => undefined };
      return undefined;
    },
    inject(deps, callback) {
      callback({
        effect: (fn) => fn(),
        tools: {
          register(spec) {
            tools.set(spec.name, spec);
            return () => tools.delete(spec.name);
          },
        },
      });
      return () => {};
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, tools };
}

/** 造一个假顾问 agent：投递后往会话里追加事件，模拟「答完了」。 */
function makeAgent({ id = 'session-advisor', cwd = 'D:\\work', answer = '顾问的答案', hang = false } = {}) {
  const log = [];
  const agent = {
    id,
    session: {
      id,
      header: { cwd },
      get seq() {
        return log.length;
      },
      snapshotEvents(from = 0) {
        return log.slice(from);
      },
    },
    phase: { kind: 'idle' },
    get status() {
      return this.phase.kind === 'idle' ? 'idle' : 'running';
    },
    sent: [],
    followup(message) {
      this.sent.push(message);
      this.phase = { kind: 'running' };
      if (hang) return;
      // 同步把回答写进会话，然后回到 idle——真实宿主是异步的，
      // 但这里只关心「边界取到的事件区间对不对」。
      log.push({ type: 'user/message', data: { message } });
      log.push({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: answer }] } },
      });
      queueMicrotask(() => {
        this.phase = { kind: 'idle' };
      });
    },
    async whenIdle() {
      while (this.phase.kind !== 'idle') await new Promise((r) => setTimeout(r, 1));
    },
  };
  return agent;
}

/**
 * 造一个假 sessionController。
 *
 * `inspections` 是「会话 id → 事件流」的表，`listItems` 是 `list()` 要返回的
 * 会话行。两者都只是读接口：顾问侧的 `advisor_watch` 全靠它们拿实况，而它
 * 必须**只读**——所以这里连写入入口都不提供，测试里也就没法（也不可能）
 * 通过这两个方法改动任何东西。
 */
function makeController({ existing, createResult, resolveErrors = {}, inspections = {}, listItems = null } = {}) {
  const state = { existing, created: [], resolveCalls: [], renames: [], inspected: [], listed: 0 };
  return {
    state,
    async resolveAgent(sessionId) {
      state.resolveCalls.push(sessionId);
      const err = resolveErrors[sessionId];
      if (err) return { error: err };
      const agent = state.existing?.id === sessionId ? state.existing : undefined;
      if (agent) return { agent };
      return { error: { code: 'session/not-found', message: 'no such session' } };
    },
    async create(request) {
      state.created.push(request);
      if (createResult === undefined) return { sessionId: 'session-new' };
      return createResult;
    },
    async rename(request) {
      state.renames.push(request);
      return { title: request.title, seq: 1 };
    },
    async inspect(sessionId) {
      state.inspected.push(sessionId);
      const found = inspections[sessionId];
      if (found === undefined) throw new Error(`session "${sessionId}" not found`);
      return { meta: { id: sessionId, cwd: found.cwd ?? 'D:\\work' }, events: found.events ?? [] };
    },
    async list() {
      state.listed += 1;
      const items = listItems ?? state.inspected.map((id) => ({ sessionId: id, running: false }));
      return { items };
    },
  };
}

/**
 * 造一个假 sessionTitle 服务。
 *
 * 顾问的标题取自**求助会话**的标题，所以要能按会话给出不同标题。
 */
function makeTitleService(titles = {}) {
  return {
    get(session) {
      const title = titles[session?.id];
      return title === undefined ? undefined : { title };
    },
  };
}

/**
 * 造一份「某个求助会话已经有第 slot 个顾问」的状态。
 *
 * 顾问会话 id 是**记在状态文件里**的，插件只认自己记录过的那个顾问。所以想
 * 测「复用已有顾问」，必须先把这个 id 写进状态，光给一个活着的 agent 是不够的。
 *
 * @param {string} callerId 求助方会话 id。
 * @param {string} advisorId 顾问会话 id。
 * @param {number} slot 槽位（从 1 开始）。
 */
function seedAdvisor(callerId, advisorId, slot = 1) {
  const slots = [];
  slots[slot - 1] = { sessionId: advisorId, title: null, cwd: null, createdAt: 1, consults: 0, lastConsultAt: 0 };
  return { version: 2, advisors: { [callerId]: { createdAt: 1, title: '', slots } } };
}

async function setup({ controller, titles, name, seed, config = {} } = {}) {
  const file = join(sandbox, `${name}.json`);
  if (seed) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(seed), 'utf8');
  }
  const { ctx, tools } = makeCtx({ controller, titles });
  apply(ctx, { stateFile: file, ...config });
  return { ctx, tools, file };
}

/** 让 controller 能解析出某个新建的 agent。 */
function teach(controller, agent) {
  const original = controller.resolveAgent.bind(controller);
  controller.resolveAgent = async (id) => (id === agent.id ? { agent } : original(id));
}

// ── 1. 工具注册 ───────────────────────────────────────────────────────────

{
  const { ctx, tools } = makeCtx({ controller: makeController({}) });
  apply(ctx, {});
  ok(tools.has('ask_advisor'), '注册了 ask_advisor');
  ok(tools.has('advisor_status'), '注册了 advisor_status');

  const tool = tools.get('ask_advisor');

  // register() 自己不查 parameters，这里不拦就会一路漏到上游变成 400。
  for (const [name, registered] of tools) {
    const violations = toolSchemaViolations(registered);
    ok(
      violations.length === 0,
      `${name} 的 schema 落在宿主支持子集内${violations.length === 0 ? '' : `\n    ${violations.join('\n    ')}`}`,
    );
  }

  eq(tool.parameters.type, 'object', 'ask_advisor 的 parameters 是完整 JSON Schema');
  eq(Object.keys(tool.parameters.properties), ['question', 'situation', 'tried', 'context', 'advisor'], 'ask_advisor 参数表');
  eq(tool.parameters.required, ['question'], 'question 是唯一必填项');
  eq(tool.parameters.properties.question.type, 'string', 'question 是字符串');
  eq(tool.parameters.properties.situation.required, undefined, '选填项不写逐属性 required');
  eq(tool.isConcurrencySafe(), false, '咨询按不安全处理（要串行）');
  ok(typeof tool.description === 'string' && tool.description.length > 50, '工具描述有实质内容');

  const status = tools.get('advisor_status');
  eq(typeof status.execute, 'function', 'advisor_status 有 execute');
  eq(status.parameters.type, 'object', 'advisor_status 的 parameters 也是完整 JSON Schema');
  eq(status.parameters.properties.reset.type, 'boolean', 'reset 是布尔');
  eq(status.parameters.required, undefined, 'advisor_status 没有必填项');
  eq(typeof status.output.schema, 'object', 'advisor_status 声明 output schema');
}

// 校验器本身必须抓得住这个坑——护栏抓不住 bug 就等于没有护栏。
// 下面三份都是 2026-10-14 真实出现过的畸形形态。
{
  const flat = {
    parameters: { question: { type: 'string', required: true, description: 'x' } },
    output: { schema: { type: 'object', additionalProperties: true } },
  };
  const caught = toolSchemaViolations(flat);
  ok(caught.length > 0, '校验器能识别扁平 parameters 写法');
  ok(
    caught.some((v) => v.includes('parameters.type 必须是 "object"')),
    '诊断信息点明 parameters.type 必须是 object',
  );

  const nested = {
    parameters: { type: 'object', properties: { q: { type: 'string', required: true } } },
    output: { schema: { type: 'object', additionalProperties: true } },
  };
  ok(
    toolSchemaViolations(nested).some((v) => v.includes('required 只能出现在 object 节点上')),
    '校验器能识别写在属性里的 required',
  );

  const badOutput = {
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'json' } },
  };
  ok(toolSchemaViolations(badOutput).length > 0, '校验器能识别 output.schema 里的 { type: "json" }');
}

// enabled:false 时一个工具都不注册
{
  const { ctx, tools } = makeCtx({ controller: makeController({}) });
  apply(ctx, { enabled: false });
  eq(tools.size, 0, 'enabled=false 时不注册工具');
}

// ── 2. 正常一次咨询 ───────────────────────────────────────────────────────

{
  const advisor = makeAgent({ id: 'session-keep', cwd: 'D:\\work', answer: '把正则拆成两步' });
  const controller = makeController({ existing: advisor });
  const { tools } = await setup({
    controller,
    titles: makeTitleService({ 'session-caller': '正则匹配不上' }),
    name: 'a',
    seed: seedAdvisor('session-caller', 'session-keep'),
  });

  const result = await tools.get('ask_advisor').execute(
    { question: '我的正则为什么匹配不上？', situation: '在解析 YAML' },
    { agent: { session: { id: 'session-caller', header: { cwd: 'D:\\work' } } } },
  );

  eq(result.ok, true, '正常咨询 ok=true');
  eq(result.answer, '把正则拆成两步', '答案取自顾问的 assistant 消息');
  eq(result.advisor.sessionId, 'session-keep', '复用已有顾问会话');
  eq(controller.state.created.length, 0, '有可用顾问时不新建会话');
  eq(advisor.sent.length, 1, '向顾问投递了一条消息');
  eq(advisor.sent[0].role, 'user', '投递的消息 role=user');
  ok(typeof advisor.sent[0].id === 'string' && advisor.sent[0].id !== '', '投递的消息带非空 id（否则会话会损坏）');
  ok(
    advisor.sent[0].content[0].text.includes('我的正则为什么匹配不上？'),
    '提示词里含求助方的问题',
  );
  ok(
    advisor.sent[0].content[0].text.includes('session-caller'),
    '提示词里含求助方会话 id',
  );
}

// ── 3. 顾问在别的目录：必须告知 ───────────────────────────────────────────

{
  const advisor = makeAgent({ id: 'session-other', cwd: 'D:\\somewhere-else' });
  const controller = makeController({ existing: advisor });
  const { tools } = await setup({
    controller,
    name: 'b',
    seed: seedAdvisor('session-caller', 'session-other'),
  });

  await tools.get('ask_advisor').execute(
    { question: 'Q' },
    { agent: { session: { id: 'session-caller', header: { cwd: 'D:\\work' } } } },
  );

  const text = advisor.sent[0].content[0].text;
  ok(text.includes('## 工作目录'), '顾问目录不同时提示词含工作目录段');
  ok(text.includes('D:\\work') && text.includes('D:\\somewhere-else'), '工作目录段同时列出两边');
}

// ── 4. 必须新建顾问时 ─────────────────────────────────────────────────────

{
  const controller = makeController({ createResult: { sessionId: 'session-fresh' } });
  const created = makeAgent({ id: 'session-fresh', cwd: 'D:\\work', answer: '新建顾问的答案' });
  teach(controller, created);

  const { tools } = await setup({ controller, name: 'c' });

  const result = await tools.get('ask_advisor').execute(
    { question: 'Q' },
    { agent: { session: { id: 'session-caller', header: { cwd: 'D:\\work' } } } },
  );

  eq(controller.state.created.length, 1, '没有顾问时创建了一个');
  eq(controller.state.created[0].cwd, 'D:\\work', '新顾问的 cwd 跟随求助方');
  eq(result.answer, '新建顾问的答案', '新顾问的答案正确取回');
  eq(created.sent.length, 2, '新顾问先收自我介绍，再收咨询请求');
  ok(created.sent[0].content[0].text.includes('第二意见'), '第一条是自我介绍');
}

// ── 5. 顾问恢复失败：应重建，而不是报错 ───────────────────────────────────

{
  const controller = makeController({
    createResult: { sessionId: 'session-reborn' },
    resolveErrors: { 'session-dead': { code: 'gateway/internal', message: 'resume 失败' } },
  });
  const reborn = makeAgent({ id: 'session-reborn', cwd: 'D:\\work', answer: '重建后的答案' });
  teach(controller, reborn);

  const { tools } = await setup({
    controller,
    name: 'd',
    seed: seedAdvisor('session-caller', 'session-dead'),
  });

  const result = await tools.get('ask_advisor').execute(
    { question: 'Q' },
    { agent: { session: { id: 'session-caller', header: { cwd: 'D:\\work' } } } },
  );

  eq(controller.state.created.length, 1, '旧顾问恢复失败后重建了');
  eq(result.answer, '重建后的答案', '重建后正常取得答案');
  ok(controller.state.resolveCalls.includes('session-dead'), '确实尝试过恢复旧顾问');
}

// ── 6. 顾问递归保护 ───────────────────────────────────────────────────────

{
  const advisor = makeAgent({ id: 'session-advisor-self' });
  const controller = makeController({ existing: advisor });
  const { tools } = await setup({
    controller,
    name: 'e',
    seed: seedAdvisor('session-owner', 'session-advisor-self'),
  });

  const result = await tools.get('ask_advisor').execute(
    { question: 'Q' },
    { agent: { session: { id: 'session-advisor-self' } } },
  );

  ok(result.error !== undefined, '顾问自己调用时返回错误对象');
  eq(advisor.sent.length, 0, '顾问自己调用时不投递任何消息（不递归）');
}

// ── 7. 参数与上下文错误 ───────────────────────────────────────────────────

{
  const advisor = makeAgent({ id: 'session-p' });
  const { tools } = await setup({
    controller: makeController({ existing: advisor }),
    name: 'f',
    seed: seedAdvisor('session-caller', 'session-p'),
  });
  const tool = tools.get('ask_advisor');

  const noSession = await tool.execute({ question: 'Q' }, undefined);
  ok(noSession.error !== undefined, '拿不到会话 id 时返回 error');

  const noQuestion = await tool.execute({ question: '   ' }, { agent: { session: { id: 's1' } } });
  ok(noQuestion.error !== undefined, '空问题时返回 error');

  eq(advisor.sent.length, 0, '参数非法时不投递');
}

// ── 8. 顾问卡住不动：超时返回，不挂死 ─────────────────────────────────────

{
  const advisor = makeAgent({ id: 'session-hang', hang: true });
  const { tools } = await setup({
    controller: makeController({ existing: advisor }),
    name: 'g',
    seed: seedAdvisor('session-caller', 'session-hang'),
    config: { waitMs: 1500 },
  });

  const t0 = Date.now();
  const result = await tools.get('ask_advisor').execute(
    { question: 'Q' },
    { agent: { session: { id: 'session-caller' } } },
  );
  const elapsed = Date.now() - t0;

  eq(result.ok, false, '顾问不结束时 ok=false');
  eq(result.timedOut, true, '标记 timedOut=true');
  ok(result.note !== undefined, '超时时给出说明');
  ok(elapsed >= 1400 && elapsed < 6000, `超时按 waitMs 生效（实测 ${elapsed}ms）`);
}

// ── 9. 顾问答了但没留文字 ─────────────────────────────────────────────────

{
  const advisor = makeAgent({ id: 'session-silent', answer: '' });
  const { tools } = await setup({
    controller: makeController({ existing: advisor }),
    name: 'h',
    seed: seedAdvisor('session-caller', 'session-silent'),
  });

  const result = await tools.get('ask_advisor').execute(
    { question: 'Q' },
    { agent: { session: { id: 'session-caller' } } },
  );

  eq(result.ok, false, '空回答时 ok=false');
  ok(result.note !== undefined, '空回答给出说明');
}

// ── 10. 两次并发咨询同一顾问：必须串行，答案不能串 ───────────────────────

{
  // 让顾问的回答随投递次序递变，任何交叉都会立刻暴露
  let n = 0;
  const log = [];
  const advisor = {
    id: 'session-serial',
    session: {
      id: 'session-serial',
      header: { cwd: 'D:\\work' },
      get seq() {
        return log.length;
      },
      snapshotEvents(from = 0) {
        return log.slice(from);
      },
    },
    phase: { kind: 'idle' },
    get status() {
      return this.phase.kind === 'idle' ? 'idle' : 'running';
    },
    followup(message) {
      const mine = ++n;
      this.phase = { kind: 'running' };
      setTimeout(() => {
        log.push({ type: 'user/message', data: { message } });
        log.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: `回答${mine}` }] } },
        });
        this.phase = { kind: 'idle' };
      }, 30);
    },
    async whenIdle() {
      while (this.phase.kind !== 'idle') await new Promise((r) => setTimeout(r, 2));
    },
  };

  const { tools } = await setup({
    controller: makeController({ existing: advisor }),
    name: 'i',
    seed: seedAdvisor('session-1', 'session-serial'),
  });
  const tool = tools.get('ask_advisor');

  const [a, b] = await Promise.all([
    tool.execute({ question: '第一个问题' }, { agent: { session: { id: 'session-1' } } }),
    tool.execute({ question: '第二个问题' }, { agent: { session: { id: 'session-1' } } }),
  ]);

  eq(a.answer, '回答1', '第一个咨询拿到第一次回答');
  eq(b.answer, '回答2', '第二个咨询拿到第二次回答（未被串味）');
}

// ── 11. advisor_status ───────────────────────────────────────────────────

{
  const advisor = makeAgent({ id: 'session-status' });
  const { tools, file } = await setup({
    controller: makeController({ existing: advisor }),
    titles: makeTitleService({ 'session-caller': '会话时钟测试' }),
    name: 'j',
    seed: seedAdvisor('session-caller', 'session-status'),
  });
  const status = tools.get('advisor_status');
  const caller = { agent: { session: { id: 'session-caller' } } };

  const before = await status.execute({}, caller);
  eq(before.advisors.length, 1, '读出本会话的顾问');
  eq(before.advisors[0].sessionId, 'session-status', '顾问会话 id 正确');
  eq(before.advisors[0].consults, 0, '尚未咨询时计数为 0');
  eq(before.callerTitle, '会话时钟测试', '读出求助会话标题');
  ok(typeof before.stateFile === 'string' && before.stateFile.includes('j.json'), '报告状态文件位置');

  await tools.get('ask_advisor').execute({ question: 'Q' }, caller);

  const after = await status.execute({}, caller);
  eq(after.advisors[0].consults, 1, '咨询计数递增');

  const reset = await status.execute({ reset: true }, caller);
  eq(reset.advisors.length, 0, 'reset 后清空本会话的顾问记录');
  eq(reset.droppedAdvisorSessionIds, ['session-status'], 'reset 报告被丢弃的顾问 id');
  ok(file.length > 0, '状态文件路径可用');
}

// ── 12. 状态文件损坏时不该起不来 ──────────────────────────────────────────

{
  const { writeFileSync } = await import('node:fs');
  const file = join(sandbox, 'k.json');
  writeFileSync(file, '{ 这不是 json', 'utf8');

  const { ctx, tools } = makeCtx({ controller: makeController({}) });
  apply(ctx, { stateFile: file });
  ok(tools.has('ask_advisor'), '状态文件损坏时插件照常注册');

  const status = await tools.get('advisor_status').execute({});
  eq(status.advisors, [], '损坏状态按空处理');
  eq(status.legacyAdvisorSessionId, null, '损坏状态没有遗留顾问');
}

// ── 13. 顾问按求助会话分开，互不影响 ─────────────────────────────────────

{
  const controller = makeController({});
  const a = makeAgent({ id: 'session-advisor-a', answer: 'A 的答案' });
  const b = makeAgent({ id: 'session-advisor-b', answer: 'B 的答案' });
  controller.resolveAgent = async (id) => {
    if (id === 'session-advisor-a') return { agent: a };
    if (id === 'session-advisor-b') return { agent: b };
    return { error: { code: 'session/not-found', message: 'no such session' } };
  };
  controller.create = async (request) => {
    controller.state.created.push(request);
    return { sessionId: `session-made-${controller.state.created.length}` };
  };
  const madeA = makeAgent({ id: 'session-made-1', answer: 'A 的答案' });
  const madeB = makeAgent({ id: 'session-made-2', answer: 'B 的答案' });
  const originResolve = controller.resolveAgent;
  controller.resolveAgent = async (id) => {
    if (id === 'session-made-1') return { agent: madeA };
    if (id === 'session-made-2') return { agent: madeB };
    return originResolve(id);
  };

  const { tools } = await setup({
    controller,
    titles: makeTitleService({ 'session-alpha': '阿尔法任务', 'session-beta': '贝塔任务' }),
    name: 'm',
  });
  const tool = tools.get('ask_advisor');

  const ra = await tool.execute({ question: 'Q-A' }, { agent: { session: { id: 'session-alpha' } } });
  const rb = await tool.execute({ question: 'Q-B' }, { agent: { session: { id: 'session-beta' } } });

  eq(ra.ok, true, '会话 A 咨询成功');
  eq(rb.ok, true, '会话 B 咨询成功');
  eq(controller.state.created.length, 2, '两个不同会话各建了一个顾问');
  ok(ra.advisor.sessionId !== rb.advisor.sessionId, '两个会话的顾问是不同会话');
  eq(ra.answer, 'A 的答案', '会话 A 拿到自己的答案');
  eq(rb.answer, 'B 的答案', '会话 B 拿到自己的答案');

  // 名称来自各自求助会话的标题前三字
  const titles = controller.state.renames.map((r) => r.title);
  ok(titles.includes('辅助阿尔法'), `会话 A 的顾问按标题命名（实际 ${JSON.stringify(titles)}）`);
  ok(titles.includes('辅助贝塔任'), '会话 B 的顾问按标题命名（「贝塔任务」取前三字是「贝塔任」）');
}

// ── 14. 同一会话要第二个顾问：另建独立会话 ───────────────────────────────

{
  const controller = makeController({ createResult: { sessionId: 'session-second' } });
  const first = makeAgent({ id: 'session-first', answer: '第一个顾问的答案' });
  const second = makeAgent({ id: 'session-second', answer: '第二个顾问的答案' });
  controller.resolveAgent = async (id) => {
    if (id === 'session-first') return { agent: first };
    if (id === 'session-second') return { agent: second };
    return { error: { code: 'session/not-found', message: 'no such session' } };
  };

  const { tools } = await setup({
    controller,
    titles: makeTitleService({ 'session-caller': '来回打转的会话' }),
    name: 'n',
    seed: seedAdvisor('session-caller', 'session-first'),
  });
  const tool = tools.get('ask_advisor');

  const one = await tool.execute({ question: 'Q1' }, { agent: { session: { id: 'session-caller' } } });
  eq(one.advisor.slot, 1, '默认用第 1 个顾问');
  eq(one.advisor.sessionId, 'session-first', '第 1 个顾问是已有的那个');
  eq(controller.state.created.length, 0, '第 1 个顾问存在时不新建');

  const two = await tool.execute(
    { question: 'Q2', advisor: 2 },
    { agent: { session: { id: 'session-caller' } } },
  );
  eq(controller.state.created.length, 1, '要第 2 个顾问时新建了一个会话');
  eq(two.advisor.slot, 2, '返回的槽位是 2');
  eq(two.advisor.sessionId, 'session-second', '第 2 个顾问是新会话');
  eq(two.answer, '第二个顾问的答案', '第 2 个顾问的答案正确');
  eq(first.sent.length, 1, '第 1 个顾问只收到自己那一条');

  const names = controller.state.renames.map((r) => r.title);
  ok(names.includes('辅助来回打'), `第 1 个顾问按标题命名（实际 ${JSON.stringify(names)}）`);
  ok(names.includes('辅助来回打2'), '第 2 个顾问带槽位号 2');
}

// ── 15. 取不到求助会话标题时回退 ─────────────────────────────────────────

{
  const controller = makeController({ createResult: { sessionId: 'session-named' } });
  const made = makeAgent({ id: 'session-named', answer: 'ok' });
  controller.resolveAgent = async (id) =>
    id === 'session-named' ? { agent: made } : { error: { code: 'session/not-found', message: 'no' } };

  // 故意不给 titles：模拟宿主没挂 sessionTitle 服务
  const { tools } = await setup({ controller, name: 'o' });
  await tools.get('ask_advisor').execute(
    { question: 'Q' },
    { agent: { session: { id: 'session-0f3a91c2-77bd' } } },
  );

  const shown = controller.state.renames.map((r) => r.title);
  ok(shown.length === 1, '仍然尝试命名');
  ok(shown[0].startsWith('辅助'), '回退命名仍带前缀');
  ok(shown[0].includes('0f3'), `拿不到标题时回退成会话 id 前几字（实际 ${JSON.stringify(shown)}）`);
}

// ── 16. 旧版扁平状态能平滑升级 ───────────────────────────────────────────

{
  const controller = makeController({ createResult: { sessionId: 'session-migrated' } });
  const made = makeAgent({ id: 'session-migrated', answer: 'ok' });
  controller.resolveAgent = async (id) =>
    id === 'session-migrated' ? { agent: made } : { error: { code: 'session/not-found', message: 'no' } };

  const { tools, file } = await setup({
    controller,
    name: 'p',
    seed: { advisorSessionId: 'session-old-flat', consults: 7, createdAt: 1, lastConsultAt: 2 },
  });

  const status = await tools.get('advisor_status').execute({});
  eq(status.legacyAdvisorSessionId, 'session-old-flat', '旧顾问 id 被留痕');
  eq(status.advisors, [], '旧记录不硬塞给任何会话（归属未知）');

  const result = await tools.get('ask_advisor').execute(
    { question: 'Q' },
    { agent: { session: { id: 'session-new-caller' } } },
  );
  eq(result.ok, true, '迁移后照常咨询');
  eq(result.advisor.sessionId, 'session-migrated', '为这次求助新建了顾问');

  // 旧版的全局计数字段要清掉：留着会让人误以为顾问是全局共享的。
  const { readFileSync } = await import('node:fs');
  const upgraded = JSON.parse(readFileSync(file, 'utf8'));
  eq('advisorSessionId' in upgraded, false, '旧 advisorSessionId 已删除');
  eq('consults' in upgraded, false, '旧全局 consults 已删除');
  eq('lastConsultAt' in upgraded, false, '旧全局 lastConsultAt 已删除');
  // v3 给每个求助会话加了便条队列（顾问侧 advisor_note 写、主会话侧读）。
  eq(upgraded.version, 3, '状态版本升到 3');
  eq(Array.isArray(upgraded.advisors['session-new-caller'].notes), true, 'v3 给新建的档案带上便条队列');
}

// ── 17. 顾问侧两个工具（advisor_watch / advisor_note） ───────────────────
//
// 这一组是反方向的用法：用户跑到顾问窗里说「去看看主会话在干什么」。两个工具
// 的语义都建立在「我是某个主会话的顾问」上，所以**必须先反查得到归属**才肯干
// 活——不是顾问就直接报错。下面的断言重点在「挡住不该调的」和「读的确实是
// 主会话的实况」，而不是报告文案本身（文案由 selftest 的纯函数断言管）。

{
  const T0 = 1_800_000_000_000;
  const mkev = (type, seq, time, data) => ({ type, seq, time, data });

  // 主会话的事件流。顾问看到的「实况」全从它算出来，所以这里刻意混了
  // 人类输入、工具调用、助手输出三类，验证各自都进了报告。
  const principal = [
    mkev('turn/start', 5, T0, { turn: 4 }),
    mkev('step/start', 7, T0 + 10, { turn: 4, step: 3 }),
    mkev('user/message', 9, T0 + 20, { content: [{ type: 'text', text: '继续修那个下载 bug' }] }),
    mkev('tool/call', 23, T0 + 30, { name: 'ops_bash', arguments: '{"command":"ls"}' }),
    mkev('assistant/message', 22, T0 + 40, { message: { content: [{ type: 'text', text: '我看过了，是超时配置的问题。' }] } }),
  ];

  const controller = makeController({
    inspections: { 'caller-1': { cwd: 'D:\\proj', events: principal } },
    listItems: [{ sessionId: 'caller-1', running: true }],
  });

  // 上次求助发生在 T0+15，而最后一条人类输入在 T0+20——也就是说**求完助之后
  // 对方又说了话**，顾问应当读到「话题还在往前走」。
  const { tools } = await setup({
    controller,
    name: 'p',
    seed: {
      version: 2,
      advisors: {
        'caller-1': {
          createdAt: 1,
          title: '修下载',
          slots: [{ sessionId: 'advisor-1', title: '辅助修下', cwd: null, createdAt: 1, consults: 1, lastConsultAt: T0 + 15 }],
        },
      },
    },
  });

  const watch = tools.get('advisor_watch');
  const note = tools.get('advisor_note');
  ok(watch !== undefined, '注册了 advisor_watch');
  ok(note !== undefined, '注册了 advisor_note');
  for (const name of ['advisor_watch', 'advisor_note']) {
    const violations = toolSchemaViolations(tools.get(name));
    ok(violations.length === 0, `${name} 的 schema 落在宿主支持子集内${violations.length === 0 ? '' : `\n    ${violations.join('\n    ')}`}`);
  }
  eq(watch.parameters.properties.detail.enum, ['summary', 'tools'], 'advisor_watch 的 detail 是枚举');
  eq(note.parameters.required, ['text'], 'advisor_note 的 text 必填');
  eq(watch.isConcurrencySafe(), true, 'advisor_watch 只读，可并发');
  eq(note.isConcurrencySafe(), true, 'advisor_note 只写自己的队列，可并发');

  // 主会话（非顾问）来调要被挡住，而且要指路到正确的工具——它想求助就该用
  // ask_advisor，而不是来窥探别的会话。
  const refused = await watch.execute({}, { agent: { session: { id: 'caller-1' } } });
  ok(typeof refused.error === 'string', '主会话调 advisor_watch 被拒');
  ok(refused.error.includes('ask_advisor'), '拒绝信息指路到 ask_advisor');
  const refusedNote = await note.execute({ text: 'x' }, { agent: { session: { id: 'caller-1' } } });
  ok(typeof refusedNote.error === 'string', '主会话调 advisor_note 被拒');

  // 顾问来调：拿到的是**它辅助的那个**会话的实况。
  const got = await watch.execute({}, { agent: { session: { id: 'advisor-1' } } });
  eq(got.ok, true, '顾问调用 advisor_watch 成功');
  eq(got.principal.sessionId, 'caller-1', '报告指向它辅助的主会话');
  eq(got.principal.slot, 1, '带上槽位号');
  eq(got.principal.running, true, '运行状态取自 list()');
  eq(got.principal.cwd, 'D:\\proj', '工作目录取自 inspect()');
  eq(got.principal.topicMoved, true, '识别出「求完助之后对方又说了话」');
  ok(got.report.includes('正在运行'), '报告明说正在运行');
  ok(got.report.includes('继续修那个下载 bug'), '报告含最近人类输入原文');
  ok(got.report.includes('我看过了'), '报告含它最后一段输出');
  ok(got.report.includes('ops_bash'), '报告含工具调用');

  // detail='tools' 只给工具清单，不带人类输入段落——顾问想快速扫一眼它调了
  // 什么时用这个。
  const toolsOnly = await watch.execute({ detail: 'tools' }, { agent: { session: { id: 'advisor-1' } } });
  ok(toolsOnly.report.includes('ops_bash'), 'tools 分支含工具调用');
  ok(!toolsOnly.report.includes('最近对方说的话'), 'tools 分支不含人类输入段落');

  // 读不到目标会话（已删除 / inspect 抛错）时如实返回失败，而不是抛出去。
  const gone = makeController({});
  const { tools: tools2 } = await setup({
    controller: gone,
    name: 'p2',
    seed: {
      version: 2,
      advisors: { 'caller-x': { createdAt: 1, title: '', slots: [{ sessionId: 'advisor-x', title: null, cwd: null, createdAt: 1, consults: 0, lastConsultAt: 0 }] } },
    },
  });
  const missing = await tools2.get('advisor_watch').execute({}, { agent: { session: { id: 'advisor-x' } } });
  eq(missing.ok, false, '目标会话读不到时返回 ok:false');
  ok(typeof missing.error === 'string' && missing.error.length > 0, '失败时带上原因');

  // ── 便条：写进主会话名下的队列，等它下次自己来读 ──
  const wrote = await note.execute({ text: '那个超时是 set 在 socket 上的。' }, { agent: { session: { id: 'advisor-1' } } });
  eq(wrote.ok, true, '顾问能留便条');
  eq(wrote.deliveredTo, 'caller-1', '便条落在它辅助的主会话名下');
  eq(wrote.pending, 1, '队列里有一条待读');

  // 便条是挂在某个会话名下的，所以读的时候必须带上「我是谁」（exec.agent.session.id）。
  // 注意返回值是**渲染好的文本**（renderNotes 的产物），不是数组——主会话直接把
  // 它当自然语言读，所以这里断言的是内容而不是条数。
  const asCaller = { agent: { session: { id: 'caller-1' } } };
  const read1 = await tools.get('advisor_status').execute({}, asCaller);
  ok(typeof read1.notes === 'string', '主会话调 advisor_status 就能读到便条');
  ok(read1.notes.includes('socket'), '便条正文完整带回');

  // 消费式：读过就清空，否则主会话每调一次工具都会重新看到同一批旧便条。
  const read2 = await tools.get('advisor_status').execute({}, asCaller);
  eq(read2.notes, null, '便条取走即清空（不会重复塞）');

  // 上限丢最旧：长期不读的会话不该把状态文件和主会话上下文无限撑大。
  // 便条是拼在一起的文本，数「第 N 条」这个小标题就知道留下了哪几条。
  for (let i = 1; i <= 6; i += 1) {
    await note.execute({ text: `第 ${i} 条` }, { agent: { session: { id: 'advisor-1' } } });
  }
  const read3 = await tools.get('advisor_status').execute({}, asCaller);
  ok(!read3.notes.includes('第 1 条'), '超限时丢掉最旧的那条');
  ok(read3.notes.includes('第 2 条'), '从第 2 条开始保留');
  ok(read3.notes.includes('第 6 条'), '保留最新的一条');

  // ask_advisor 也带便条（同一个 takeNotes）——主会话主动求助时同样能收到。
  await note.execute({ text: '求助时顺带给你的一条。' }, { agent: { session: { id: 'advisor-1' } } });
  const made = makeAgent({ id: 'advisor-1', answer: '看这里' });
  teach(controller, made);
  const asked = await tools.get('ask_advisor').execute(
    { question: '问一句' },
    { agent: { session: { id: 'caller-1' } } },
  );
  eq(asked.ok, true, '主会话仍能正常求助');
  ok(asked.notes !== null && asked.notes.includes('顺带给你的一条'), 'ask_advisor 也会一并带回便条');
}

// ── 结果 ──────────────────────────────────────────────────────────────────

rmSync(sandbox, { recursive: true, force: true });

const total = pass + failures.length;
if (failures.length === 0) {
  console.log(`HOST-MOCK: PASS  ${pass}/${total}`);
  process.exit(0);
}
console.log(`HOST-MOCK: FAIL  ${pass}/${total} pass, ${failures.length} fail`);
for (const f of failures) console.log(`  ✘ ${f}`);
process.exit(1);
