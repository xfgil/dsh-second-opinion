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

import { ADVISOR_INTRO, buildConsultPrompt, extractAnswer, clamp } from '../lib/compose.js';

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

// ── 结果 ────────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length === 0) {
  console.log(`SELFTEST: PASS  ${pass}/${total}`);
  process.exit(0);
}
console.log(`SELFTEST: FAIL  ${pass}/${total} pass, ${failures.length} fail`);
for (const f of failures) console.log(`  ✘ ${f}`);
process.exit(1);
