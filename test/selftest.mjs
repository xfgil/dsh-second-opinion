/**
 * dsh-second-opinion / test/selftest.mjs
 *
 * 只测 compose.js 的纯函数。index.js 全是宿主交互，脱离宿主测不了——
 * 那边的正确性靠真实会话跑通来验证（见 README「怎么验证」）。
 *
 * 重点是 `extractAnswer`：它决定顾问的回答会不会被吞掉。规则抄自宿主
 * `@deepseek-ai/dsh-subagent` 的 `finalAssistantOutput`，这里逐条钉住。
 *
 * 运行：node test/selftest.mjs
 */

import {
  ADVISOR_INTRO,
  advisorTitle,
  buildConsultPrompt,
  extractAnswer,
  clamp,
  leadingChars,
  humanGap,
  summarizeSession,
  renderPrincipalReport,
  renderNotes,
} from '../lib/compose.js';

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass += 1;
    return;
  }
  failures.push(`${label}\n    实际: ${a}\n    期望: ${b}`);
}

function ok(condition, label) {
  if (condition) {
    pass += 1;
    return;
  }
  failures.push(label);
}

/** 造一条 assistant/message 事件。 */
function msg(content, stream) {
  return { type: 'assistant/message', data: { message: { content }, ...(stream === undefined ? {} : { stream }) } };
}

/** 造一条 assistant/attempt 事件（只有流式文本，没有最终消息）。 */
function attempt(stream) {
  return { type: 'assistant/attempt', data: { stream } };
}

// ── extractAnswer：取最后一条非空 assistant 消息 ───────────────────────────
eq(
  extractAnswer([msg([{ type: 'text', text: '第一版' }]), msg([{ type: 'text', text: '第二版' }])]),
  '第二版',
  '取最后一条非空消息',
);

// 空 content 的消息只是记账，不能覆盖前面已有的回答
eq(
  extractAnswer([
    msg([{ type: 'text', text: '有用的答案' }]),
    msg([]),
  ]),
  '有用的答案',
  '空 content 不覆盖前面的回答',
);

// 没有消息时退化到流式文本拼接
eq(
  extractAnswer([attempt([{ type: 'text', text: '流式' }]), attempt([{ type: 'text', text: '片段' }])]),
  '流式片段',
  '无消息时退化到 stream 拼接',
);

// 有消息时优先用消息体，不混入 stream
eq(
  extractAnswer([attempt([{ type: 'text', text: '过程' }]), msg([{ type: 'text', text: '结论' }])]),
  '结论',
  '有消息时以消息为准，不拼 stream',
);

// 多个 text 块用换行连接；非 text 块（工具调用）忽略
eq(
  extractAnswer([
    msg([
      { type: 'text', text: '第一段' },
      { type: 'tool-call', name: 'read' },
      { type: 'text', text: '第二段' },
    ]),
  ]),
  '第一段\n第二段',
  '多个 text 块拼接、忽略工具块',
);

// stream 是纯字符串的形态
eq(extractAnswer([attempt('裸字符串流')]), '裸字符串流', 'stream 为字符串');

// stream 用 delta 字段的形态
eq(extractAnswer([attempt([{ type: 'text-delta', delta: '增量' }])]), '增量', 'stream 用 delta 字段');

// 空事件 / 畸形事件不崩
eq(extractAnswer([]), '', '空数组');
eq(extractAnswer(null), '', 'null 输入');
eq(extractAnswer([null, undefined, 42, 'x']), '', '畸形事件不崩');
eq(extractAnswer([{ type: 'tool/call', data: {} }]), '', '无关事件类型');

// 空白内容应被 trim 掉
eq(extractAnswer([msg([{ type: 'text', text: '  结论  ' }])]), '结论', '首尾空白被 trim');

// ── buildConsultPrompt：五段结构 ─────────────────────────────────────────
const full = buildConsultPrompt({
  from: 'session-abc',
  situation: '在改解析器',
  tried: '试过正则',
  context: 'file.js:12',
  question: '正则为什么不行',
});

ok(full.includes('session-abc'), 'prompt 含求助方 id');
ok(full.includes('## 我的问题') && full.includes('正则为什么不行'), 'prompt 含问题段');
ok(full.includes('## 我卡在哪') && full.includes('在改解析器'), 'prompt 含处境段');
ok(full.includes('## 已经试过的（请勿重复）') && full.includes('试过正则'), 'prompt 含已试过段');
ok(full.includes('## 相关上下文') && full.includes('file.js:12'), 'prompt 含上下文段');

// 缺的段不留空标题——留空标题会让顾问以为信息被截断了
const sparse = buildConsultPrompt({ from: 's1', question: '只有问题' });
ok(!sparse.includes('## 我卡在哪'), '缺的段不出现');
ok(!sparse.includes('## 已经试过的'), '缺的段不出现（已试过）');
ok(sparse.includes('## 我的问题'), '问题段始终存在');

// 只有空白字符的字段等同于缺失
const blank = buildConsultPrompt({ from: 's1', question: 'Q', situation: '   ', tried: '' });
ok(!blank.includes('## 我卡在哪'), '纯空白字段视为缺失');

// 超长时截断并留标记
const long = buildConsultPrompt({ from: 's1', question: 'Q', context: 'x'.repeat(5000) }, 1000);
ok(long.length <= 1000, 'prompt 截断到上限内');
ok(long.includes('已截断'), '截断留有明确标记');
ok(long.includes('## 我的问题'), '截断后问题段仍在（问题在上下文之前）');

// ── 工作目录段：只在两边不一致时出现 ────────────────────────────────────
// 顾问会话是复用的，它的目录未必等于求助方的目录。不告知的话，求助方给的
// 相对路径会被顾问在自己目录下解析成别的文件，而且它会以为自己读对了。
const sameDir = buildConsultPrompt({ from: 's1', question: 'Q', cwd: 'D:\\a', advisorCwd: 'D:\\a' });
ok(!sameDir.includes('## 工作目录'), '目录一致时不加工作目录段（避免噪音）');

const diffDir = buildConsultPrompt({ from: 's1', question: 'Q', cwd: 'D:\\a', advisorCwd: 'D:\\b' });
ok(diffDir.includes('## 工作目录'), '目录不一致时加工作目录段');
ok(diffDir.includes('D:\\a') && diffDir.includes('D:\\b'), '工作目录段同时列出两边目录');
ok(diffDir.includes('绝对路径'), '工作目录段提示改用绝对路径');

// 任一侧缺失时也不该报出「不一致」——否则会误导顾问以为对方在别的目录
const noAdvisor = buildConsultPrompt({ from: 's1', question: 'Q', cwd: 'D:\\a' });
ok(!noAdvisor.includes('## 工作目录'), '顾问目录未知时不加工作目录段');
const noFrom = buildConsultPrompt({ from: 's1', question: 'Q', advisorCwd: 'D:\\b' });
ok(!noFrom.includes('## 工作目录'), '求助方目录未知时不加工作目录段');

// ── clamp ───────────────────────────────────────────────────────────────
eq(clamp('abc', 10), 'abc', 'clamp 不超限时原样返回');
ok(clamp('abcdef', 4).length <= 4, 'clamp 上限极小时硬截断、绝不超上限');
ok(clamp('abcdef', 4).startsWith('abcd'), 'clamp 上限极小时保留前缀');
ok(!clamp('abcdef', 4).includes('已截断'), 'clamp 上限放不下标记时不强塞标记');
// 上限够宽时要留下截断痕迹，让模型知道内容不完整
const wide = clamp('x'.repeat(200), 100);
ok(wide.length <= 100, 'clamp 上限够宽时不超上限');
ok(wide.includes('已截断'), 'clamp 上限够宽时留有明确标记');
eq(clamp('abc', 0), 'abc', 'clamp 上限为 0 时视为不设限');
eq(clamp(null, 10), '', 'clamp null 安全');
eq(clamp('abc', NaN), 'abc', 'clamp 非法上限时视为不设限');

// ── ADVISOR_INTRO ───────────────────────────────────────────────────────
ok(ADVISOR_INTRO.includes('不要反问'), '自我介绍明确禁止反问');
ok(ADVISOR_INTRO.includes('看不到'), '自我介绍说明顾问看不到对话记录');
// 顾问是复用的，目录可能变；不能说「你的 cwd 就是它的 cwd」——那会在换工作区后误导
ok(!ADVISOR_INTRO.includes('你的 cwd'), '自我介绍不硬断言两边目录相同');
ok(ADVISOR_INTRO.includes('目录'), '自我介绍说明按求助方给的目录理解相对路径');
ok(ADVISOR_INTRO.length > 100, '自我介绍有实质内容');

// ── leadingChars：取「字」不能按 UTF-16 码元切 ──────────────────────────
eq(leadingChars('正则匹配不上', 3), '正则匹', '取前三字');
eq(leadingChars('ab', 3), 'ab', '不足三字时全取');
eq(leadingChars('  前后有空格  ', 2), '前后', '先归一化空白再取');
eq(leadingChars('a b c', 3), 'a b', '内部空白折叠成一个空格后参与计数');
eq(leadingChars('', 3), '', '空串返回空');
eq(leadingChars(null, 3), '', 'null 安全');
eq(leadingChars(undefined, 3), '', 'undefined 安全');
eq(leadingChars(123, 2), '12', '非字符串转成字符串再取');
// 这一条是选 Array.from 而不是 slice 的理由：slice 会把代理对切成半个字符
eq(leadingChars('👍👍👍', 2), '👍👍', 'emoji 按整字符切（slice 会切成乱码）');
eq(Array.from(leadingChars('👍👍👍', 2)).length, 2, '切出来正好两个码点');
eq(leadingChars('abc', 0), 'abc', 'n<=0 视为没给值，退回默认 3 个字');
eq(leadingChars('abc', NaN), 'abc', 'n 是 NaN 时退回默认 3 个字');

// ── advisorTitle：顾问会话命名规则 ───────────────────────────────────────
eq(advisorTitle('正则匹配不上', 1), '辅助正则匹', '第一个顾问：辅助 + 前三字，不带数字');
eq(advisorTitle('正则匹配不上', 2), '辅助正则匹2', '第二个顾问加数字 2');
eq(advisorTitle('正则匹配不上', 3), '辅助正则匹3', '第三个顾问加数字 3');
eq(advisorTitle('xy', 1), '辅助xy', '不足三字时全用');
eq(advisorTitle('', 1), '辅助未命名', '取不到标题时回退「未命名」');
eq(advisorTitle(null, 1), '辅助未命名', 'null 标题回退');
eq(advisorTitle('标题', 1, '顾问'), '顾问标题', '前缀可配置');
eq(advisorTitle('标题', 1, ''), '标题', '空前缀时只剩标题，不炸');
eq(advisorTitle('标题', 0), '辅助标题', '槽位 0 当作 1（不加数字）');
eq(advisorTitle('标题', -5), '辅助标题', '负数槽位当作 1');
eq(advisorTitle('  空格  开头', 1), '辅助空格', '标题先归一化空白，且不留尾随空格');

// ── humanGap：把毫秒说成人话 ────────────────────────────────────────────
//
// 这一组存在的理由：顾问判断「上次聊完过去多久了」全靠这个换算，而模型从
// 时间戳做除法是会算错的。宁可在纯函数里钉死它。
eq(humanGap(0), '0 秒', '0 毫秒 = 0 秒');
eq(humanGap(30_000), '30 秒', '不足一分钟按秒');
eq(humanGap(59_999), '59 秒', '59.999 秒仍是 59 秒，不进位成分钟');
eq(humanGap(60_000), '1 分钟', '整一分钟');
eq(humanGap(90_000), '1 分钟', '分针向下取整，不四舍五入');
eq(humanGap(3_600_000), '1 小时', '整一小时不带「0 分钟」');
eq(humanGap(8_100_000), '2 小时 15 分钟', '小时+分钟');
eq(humanGap(86_400_000), '1 天', '整一天不带「0 小时」');
eq(humanGap(180_000_000), '2 天 2 小时', '天+小时');
eq(humanGap(-1), '未知', '负数间隔视为未知，不产出「-1 秒」');
eq(humanGap(NaN), '未知', 'NaN 安全');
eq(humanGap(undefined), '未知', 'undefined 安全');
eq(humanGap('abc'), '未知', '非数字安全');

// ── summarizeSession：从事件流里读出「它在干什么」 ──────────────────────
//
// 造事件的小工具。宿主的信封是 `{type, seq, time, data}`。
const ev = (type, seq, time, data) => ({ type, seq, time, data });
const usr = (text, seq, time) => ev('user/message', seq, time, { content: [{ type: 'text', text }] });
const asst = (text, seq, time) => ev('assistant/message', seq, time, { message: { content: [{ type: 'text', text }] } });
const tool = (name, args, seq, time) => ev('tool/call', seq, time, { name, arguments: args });

const T0 = 1_800_000_000_000;

// 空输入不能炸，且每个字段都该有确定的初值（而不是 undefined 漏进报告里）
const empty = summarizeSession([], { now: T0 });
eq(empty.eventCount, 0, '空事件流：计数为 0');
eq(empty.turn, null, '空事件流：turn 为 null');
eq(empty.lastUser, null, '空事件流：没有 lastUser');
eq(empty.lastAssistant, null, '空事件流：没有 lastAssistant');
eq(empty.idleMs, null, '空事件流：空闲时长为 null（而不是 0，0 会被误读成「刚刚活动过」）');
eq(summarizeSession(null, { now: T0 }).eventCount, 0, 'null 事件流安全');
eq(summarizeSession('nope', { now: T0 }).eventCount, 0, '非数组事件流安全');

const flow = [
  ev('turn/start', 5, T0, { turn: 3 }),
  ev('step/start', 7, T0 + 10, { turn: 3, step: 2 }),
  usr('去修一下那个 bug', 9, T0 + 20),
  tool('ops_bash', '{"command":"ls"}', 23, T0 + 30),
  asst('我先看看目录结构。', 22, T0 + 40),
];
const s1 = summarizeSession(flow, { now: T0 + 100, lastConsultAt: 0 });
eq(s1.eventCount, 5, '事件计数含所有类型');
eq(s1.turn, 3, '取到当前轮次');
eq(s1.step, 2, '取到当前步');
eq(s1.lastUser.text, '去修一下那个 bug', '取到最后一条人类输入');
eq(s1.lastAssistant.text, '我先看看目录结构。', '取到最后一段助手输出');
eq(s1.toolCount, 1, '工具调用计数');
eq(s1.tools[0].name, 'ops_bash', '工具名');
eq(s1.tools[0].args, '{"command":"ls"}', '工具参数原文');
eq(s1.lastActivityAt, T0 + 40, '最后活动时间取所有事件的最大 time');
eq(s1.idleMs, 60, '空闲时长 = now - 最后活动时间');
eq(s1.idleText, '0 秒', '空闲时长的人话形式也一并给出');
eq(s1.sinceLastConsultMs, null, '没求助过时，距上次求助为 null');
eq(s1.topicMoved, null, '没求助过时，话题是否继续为 null（不是 false）');

// 「话题有没有往前走」＝ 上次求助之后有没有新的人类输入。
// 这是时间先后的事实判断，不是语义判断——语义留给顾问自己。
const afterConsult = summarizeSession(
  [...flow, usr('不是那个，是另一个函数', 40, T0 + 200)],
  { now: T0 + 300, lastConsultAt: T0 + 100 },
);
eq(afterConsult.topicMoved, true, '求助之后又有新输入 → 话题在往前走');
eq(afterConsult.sinceLastConsultMs, 200, '距上次求助的间隔');

const noNewInput = summarizeSession(flow, { now: T0 + 300, lastConsultAt: T0 + 200 });
eq(noNewInput.topicMoved, false, '求助之后没有新输入 → 它停在那时的状态里');

// 求助时刻正好晚于最后一条输入：不能算「往前走」
const boundary = summarizeSession(flow, { now: T0 + 300, lastConsultAt: T0 + 40 });
eq(boundary.topicMoved, false, '最后输入早于求助时刻（相等边界除外）→ 不算新进展');

// 工具列表要截断并保留最近的：顾问关心「卡在哪一步」，不是完整调用史
const many = summarizeSession(
  Array.from({ length: 30 }, (_, i) => tool(`t${i}`, '{}', i, T0 + i)),
  { now: T0 + 100, toolLimit: 3 },
);
eq(many.tools.length, 3, '工具列表按上限截断');
eq(many.tools.map((t) => t.name).join(','), 't27,t28,t29', '截断时保留最近的几次（丢最旧的）');
eq(many.toolCount, 30, '截断的是列表，总数仍然如实统计');

// 只有图片、没有文字的 user 消息也是「对方说了话」，时间点必须记下来，
// 否则 topicMoved 会被判成 false，顾问会以为对方没动过。
const imageOnly = summarizeSession(
  [ev('user/message', 9, T0 + 500, { content: [{ type: 'image', path: 'a.png' }] })],
  { now: T0 + 600, lastConsultAt: T0 + 100 },
);
eq(imageOnly.lastUser.empty, true, '无文字的人类输入标记为空正文');
eq(imageOnly.lastUser.at, T0 + 500, '无文字输入仍记录时间');
eq(imageOnly.topicMoved, true, '无文字输入也算话题在往前走');

// 超长正文要截断（事件流可能含整篇文件内容，全塞进报告会撑爆上下文）
const huge = summarizeSession([usr('x'.repeat(5000), 9, T0)], { now: T0 });
ok(huge.lastUser.text.length <= 2000, '超长的人类输入被截断');
ok(huge.lastUser.text.includes('已截断'), '截断留有痕迹，顾问不会以为原文就这么短');

// ── renderPrincipalReport：给顾问读的实况报告 ───────────────────────────
const report = renderPrincipalReport(
  summarizeSession(flow, { now: T0 + 100, lastConsultAt: T0 + 50 }),
  { sessionId: 'session-abc', title: '修 bug', running: true, cwd: 'D:\\work' },
);
ok(report.includes('session-abc'), '报告含会话 id');
ok(report.includes('修 bug'), '报告含会话标题');
ok(report.includes('D:\\work'), '报告含工作目录');
ok(report.includes('正在运行'), 'running=true 时明说在跑');
ok(!report.includes('空闲'), 'running=true 时不能同时说空闲');
ok(report.includes('第 3 轮第 2 步'), '报告含进度');
ok(report.includes('去修一下那个 bug'), '报告含最近的人类输入');
ok(report.includes('我先看看目录结构。'), '报告含最后的助手输出');
ok(report.includes('ops_bash'), '报告含最近的工具调用');
ok(report.includes('没有新的人类输入'), '未换话题时如实说明');

// running 未知时必须说未知，不能默认成「空闲」或「正在跑」——那是编造。
const unknownRun = renderPrincipalReport(summarizeSession(flow, { now: T0 }), { sessionId: 's', running: null });
ok(unknownRun.includes('未知'), 'running 为 null 时如实报未知');
ok(!unknownRun.includes('正在运行'), 'running 未知时不谎称在跑');

// 从没求助过
const firstContact = renderPrincipalReport(summarizeSession(flow, { now: T0 }), { sessionId: 's', running: false });
ok(firstContact.includes('第一次接触'), '没求助过时说明是第一次');

// 报告也要有上限（事件流可能很长）
ok(renderPrincipalReport(summarizeSession(flow, { now: T0 }), { sessionId: 's' }, 200).length <= 200, '报告遵守字符上限');
eq(renderPrincipalReport(null, { sessionId: 's' }, 9999).includes('【主会话实况】'), true, 'summary 为 null 时不炸、仍给出标题');

// ── renderNotes：留给主会话的便条 ───────────────────────────────────────
eq(renderNotes([]), '', '没有便条时返回空串（调用方据此不往结果里加字段）');
eq(renderNotes(null), '', 'null 安全');
const notes = renderNotes(
  [
    { at: T0, slot: 1, text: '你在第 3 步重复删了同一个目录，建议先看一眼它是否存在。' },
    { at: T0 + 60_000, slot: 2, text: '第二个顾问：这个报错其实来自缓存。' },
  ],
  T0 + 120_000,
);
ok(notes.includes('顾问'), '便条抬头点明来源是顾问');
ok(notes.includes('不会打断') || notes.includes('看不到你后来做了什么'), '便条说明它不是实时、可能已过时');
ok(notes.includes('2 分钟前留下'), '便条带新鲜度');
ok(notes.includes('第 2 号顾问'), '便条标出槽位（多个顾问时能分辨谁写的）');
ok(!notes.includes('第 1 号顾问'), '一号顾问不加多余标注');
ok(notes.includes('重复删了同一个目录'), '便条正文原样带出');

// ── 结果 ────────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length === 0) {
  console.log(`SELFTEST: PASS  ${pass}/${total}`);
  process.exit(0);
}
console.log(`SELFTEST: FAIL  ${pass}/${total} pass, ${failures.length} fail`);
for (const f of failures) console.log(`  ✘ ${f}`);
process.exit(1);
