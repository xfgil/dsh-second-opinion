/**
 * dsh-second-opinion / compose.js
 *
 * 提示词构造与答案提取。刻意与 index.js 分开：这两件事是纯函数，可以脱离
 * 宿主单独测试（见 test/selftest.mjs），而 index.js 里全是宿主交互。
 */

/**
 * 顾问会话的自我介绍。只发一次，之后就只发咨询请求。
 *
 * 措辞上有几处是刻意写死的：
 *   - 明确说「你看不到对方的对话记录」——否则顾问会去猜、去问，浪费一轮；
 *   - 明确说「不要反问、直接给判断」——顾问缺信息时的默认行为是反问，而
 *     反问对求助方毫无价值（求助方本来就卡住了，没法再补一轮）；
 *   - 明确说「给出可执行步骤」——泛泛的方向性建议对卡住的人没有用。
 */
export const ADVISOR_INTRO = [
  '你是「第二意见」顾问会话。别的主会话在卡住时会把问题发给你，请你独立判断。',
  '',
  '几条规矩：',
  '',
  '1. 你看不到求助方的对话记录，只看得到它写给你的内容。信息不够时**不要反问**——',
  '   反问会让求助方再等一轮，而它本来就卡住了。请基于已有信息直接给判断，',
  '   并在需要时明确写出你的假设。',
  '2. 你可以读文件、跑命令来自己核实。求助方会在每条请求里写明它自己的工作',
  '   目录；如果那与你的目录不一致，按它给的目录去理解相对路径，读文件时直接',
  '   用绝对路径。',
  '3. 求助方写给你的「已试过」清单是高价值信息——不要重复它已经走死的路，',
  '   除非你有把握说明它为什么错。',
  '4. 给可执行的步骤，不要给方向性口号。如果结论是「求助方的思路根本错了」，',
  '   就直接说，并说明该换成什么。',
  '5. 你的回答会被原样带回求助方。所以直接写答案本身，不要写「好的我来看看」',
  '   这类前言，也不要写「希望有帮助」这类结语。',
  '',
  '准备好就开始，不需要回复本条。',
].join('\n');

/**
 * 取字符串的前 n 个「字」。
 *
 * 用 `Array.from` 而不是 `slice`：`slice` 按 UTF-16 码元切，会把 emoji 和
 * 部分汉字切成半个代理对，得到一个乱码字符。按码点切才是「字」。
 *
 * n 不是正数（0、负数、NaN）时按默认 3 处理——「取 0 个字」不是有意义的
 * 请求，多半是调用方没给值。
 *
 * @param {unknown} text 原文。
 * @param {number} n 取几个字。
 * @returns {string}
 */
export function leadingChars(text, n = 3) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value === '') return '';
  const count = Math.floor(Number(n));
  return Array.from(value)
    .slice(0, Number.isFinite(count) && count > 0 ? count : 3)
    .join('');
}

/**
 * 顾问会话的标题：`辅助` + 求助会话标题前三字（+ 槽位号）。
 *
 * 命名规则来自用户要求：顾问会话要注明它在辅助哪个会话，取原会话前三字；
 * 同一个会话有多个顾问时依次加 2、3……（第一个不带数字，否则单个顾问的
 * 标题会平白多一个「1」）。
 *
 * 取到的片段要再去一次尾随空格：标题的第三个字可能正好是空格（「空格 开头」
 * 取三字得「空格 」），留在侧栏名字里很难看。
 *
 * 拿不到求助方标题时（新会话还没起标题）由调用方回退成会话 id 的前三字。
 *
 * @param {unknown} sourceTitle 求助会话的标题。
 * @param {number} slot 顾问槽位，从 1 开始。
 * @param {string} prefix 标题前缀，默认「辅助」。
 * @returns {string}
 */
export function advisorTitle(sourceTitle, slot = 1, prefix = '辅助') {
  const head = leadingChars(sourceTitle, 3).trimEnd() || '未命名';
  const n = Math.floor(Number(slot) || 1);
  return `${String(prefix ?? '辅助')}${head}${n > 1 ? n : ''}`;
}

/**
 * 组装一次咨询的提示词。
 *
 * 结构固定为「求助方 / 处境 / 已试过 / 上下文 / 问题」五段，缺的段直接省略，
 * 不留空标题——顾问是个独立会话，标题留空只会让它以为信息被截断了。
 *
 * @param {{from: string, cwd?: string, advisorCwd?: string, situation?: string, tried?: string, context?: string, question: string}} input
 * @param {number} maxChars 全文上限；超出时按「保留问题、修剪上下文」的优先级裁剪。
 * @returns {string}
 */
export function buildConsultPrompt(input, maxChars = 20000) {
  const question = String(input?.question ?? '').trim();
  const parts = [
    '【第二意见请求】',
    `求助方会话：${input?.from ?? 'unknown'}`,
    '',
    '## 我的问题',
    question,
  ];

  // 顾问会话是复用的，它的默认目录未必等于求助方的目录（换了工作区之后尤其
  // 如此）。不写清楚的话，求助方给的相对路径会被顾问在自己目录下解析成别的
  // 文件，而且它会以为自己读对了。
  //
  // 只有**两边都已知且确实不同**才加这一段：任一侧读不到时我们并不知道是否
  // 一致，此时写「两处不一致」是在编造事实，比不提更糟。
  const from = String(input?.cwd ?? '').trim();
  const advisor = String(input?.advisorCwd ?? '').trim();
  if (from !== '' && advisor !== '' && from !== advisor) {
    parts.push(
      '',
      '## 工作目录',
      `求助方的目录是 ${from}，而你的默认目录是 ${advisor}。`,
      '两处不一致，求助方提到的相对路径请按它的目录理解；需要读文件时直接用绝对路径。',
    );
  }

  const situation = String(input?.situation ?? '').trim();
  if (situation !== '') parts.push('', '## 我卡在哪', situation);

  const tried = String(input?.tried ?? '').trim();
  if (tried !== '') parts.push('', '## 已经试过的（请勿重复）', tried);

  const context = String(input?.context ?? '').trim();
  if (context !== '') parts.push('', '## 相关上下文', context);

  parts.push(
    '',
    '## 请你',
    '给出你的独立判断：哪些假设错了、下一步该做什么。如果需要先读文件或跑命令核实，请直接做。',
  );

  return clamp(parts.join('\n'), maxChars);
}

/**
 * 从顾问会话的事件区间里取出它的最终回答。
 *
 * 规则与宿主 `@deepseek-ai/dsh-subagent` 的 `finalAssistantOutput` 保持一致
 * （那是最权威的定义，但该包不在 profile 的 node_modules 里，只能自己实现）：
 * **取最后一条非空 assistant 消息的 content**；若一条都没有，退化到把流式
 * 文本片段拼起来。空 content 的消息只是记账用的，不能覆盖前面已有的回答。
 *
 * 这样选而不是「取最后一条 assistant 消息」，是因为顾问可能在一轮里先输出
 * 正文、再补一次只有工具调用的空消息，那种空消息不该把正文吞掉。
 *
 * @param {Array<object>} events 事件数组（已按 seq 升序）。
 * @returns {string} 回答正文；没有则空字符串。
 */
export function extractAnswer(events) {
  if (!Array.isArray(events)) return '';

  let message = undefined;
  const partial = [];

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const data = event.data ?? {};

    if (event.type === 'assistant/message') {
      const content = data.message?.content;
      if (Array.isArray(content) && content.length > 0) message = content;
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const text = joinStreamText(data.stream);
      if (text !== '') partial.push(text);
    }
  }

  if (message !== undefined) return contentToText(message);
  return partial.join('');
}

/**
 * 把消息 content 数组拼成纯文本。只取 text 块，工具调用块对求助方没有意义。
 *
 * @param {Array<object>} content
 * @returns {string}
 */
function contentToText(content) {
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
  return out.join('\n').trim();
}

/**
 * 把宿主 assistant 消息里内嵌的 stream 拼成文本。
 *
 * stream 的形状在不同版本里见过两种：直接的字符串，或 `{type:'text', text}` /
 * `{type:'text-delta', delta}` 之类的事件数组。这里都兜住，认不出来就返回空串
 * ——退化成空串只是拿不到兜底文本，不会出错。
 *
 * @param {unknown} stream
 * @returns {string}
 */
function joinStreamText(stream) {
  if (typeof stream === 'string') return stream;
  if (!Array.isArray(stream)) return '';
  const out = [];
  for (const piece of stream) {
    if (typeof piece === 'string') {
      out.push(piece);
      continue;
    }
    if (!piece || typeof piece !== 'object') continue;
    if (typeof piece.text === 'string') out.push(piece.text);
    else if (typeof piece.delta === 'string') out.push(piece.delta);
  }
  return out.join('');
}

/**
 * 按字符数截断，并在末尾留下明确标记。
 *
 * 必须留标记：顾问和求助方都是模型，静默截断会让它们以为内容本来就这么短，
 * 从而基于不完整信息下结论。
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clamp(text, max) {
  const value = String(text ?? '');
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
  const note = `\n\n…（内容过长，已截断，原长 ${value.length} 字符）`;
  // 上限比标记本身还短时，标记会把结果撑超上限——那种情况下只能放弃标记，
  // 硬截断。优先级：结果绝不超上限 > 留下截断痕迹。
  if (note.length >= limit) return value.slice(0, limit);
  return value.slice(0, limit - note.length) + note;
}
