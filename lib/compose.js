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
 * 把毫秒间隔说成人话（「3 分钟」「2 小时 15 分钟」）。
 *
 * 顾问要判断的是「上次对话过去多久了、还值不值得接着那个话题」，它需要的
 * 是一个能直接读的量级，不是 `1791897962612` 这种时间戳——模型从数字里
 * 换算间隔很容易算错，而这个换算是我们一次就能算准的事。
 *
 * @param {unknown} ms 毫秒数。
 * @returns {string}
 */
export function humanGap(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '未知';
  const seconds = Math.floor(n / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分钟`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} 天` : `${days} 天 ${hours % 24} 小时`;
}

/**
 * 从一段事件流里抽出「这个会话现在在干什么、上次说到哪」。
 *
 * 这是纯函数，只认宿主事件的信封（`{type, seq, time, data}`），不碰任何
 * 服务——所以它能脱离宿主单测（见 test/selftest.mjs），而那正是它该被测的
 * 原因：这里的判断逻辑（尤其是「话题是否还在继续」）之后会被模型当作事实
 * 来用，算错了没人看得出来。
 *
 * 「话题是否还在继续」的判据是**时间先后**而不是语义：上次咨询之后主会话
 * 又收到过新的人类输入，就说明它在往前走（新进展或换了话题）；没有，就说明
 * 它停在上次咨询那一刻的状态上。语义判断交给顾问自己——它读得到最近几轮
 * 的原文，我们只负责把时间事实摆准。
 *
 * @param {Array<object>} events 事件数组，按 seq 升序。
 * @param {{now?: number, lastConsultAt?: number, toolLimit?: number}} [options]
 * @returns {object}
 */
export function summarizeSession(events, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const lastConsultAt = Number.isFinite(Number(options.lastConsultAt)) ? Number(options.lastConsultAt) : 0;
  const toolLimit = Math.max(0, Math.floor(Number(options.toolLimit)) || 12);

  const summary = {
    eventCount: 0,
    turn: null,
    step: null,
    firstActivityAt: null,
    lastActivityAt: null,
    idleMs: null,
    idleText: null,
    lastUser: null,
    lastAssistant: null,
    tools: [],
    toolCount: 0,
    sinceLastConsultMs: null,
    sinceLastConsultText: null,
    topicMoved: null,
  };
  if (!Array.isArray(events)) return summary;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    summary.eventCount += 1;

    const at = Number.isFinite(event.time) ? event.time : null;
    if (at !== null) {
      if (summary.firstActivityAt === null) summary.firstActivityAt = at;
      summary.lastActivityAt = at;
    }

    const data = event.data ?? {};
    if (event.type === 'turn/start' || event.type === 'step/start') {
      if (Number.isFinite(data.turn)) summary.turn = data.turn;
    }
    if (event.type === 'step/start' && Number.isFinite(data.step)) summary.step = data.step;

    if (event.type === 'user/message') {
      const text = contentToText(data.content);
      // 空正文的 user 消息（比如只有图片）也要记下时间，否则「话题还在不在
      // 继续」会被判错——对方确实说了话，只是话里没有文字。
      if (text !== '' || at !== null) summary.lastUser = { text: clamp(text, 2000), at, empty: text === '' };
    }
    if (event.type === 'assistant/message') {
      const text = contentToText(data.message?.content);
      if (text !== '') summary.lastAssistant = { text: clamp(text, 2000), at };
    }
    if (event.type === 'tool/call') {
      summary.toolCount += 1;
      summary.tools.push({
        name: String(data.name ?? ''),
        at,
        args: clamp(String(data.arguments ?? ''), 300),
      });
    }
  }

  if (summary.lastActivityAt !== null) {
    summary.idleMs = Math.max(0, now - summary.lastActivityAt);
    summary.idleText = humanGap(summary.idleMs);
  }
  if (lastConsultAt > 0) {
    summary.sinceLastConsultMs = Math.max(0, now - lastConsultAt);
    summary.sinceLastConsultText = humanGap(summary.sinceLastConsultMs);
    // 上次咨询之后又来了新的人类输入 → 话题在往前走。
    summary.topicMoved = summary.lastUser?.at != null ? summary.lastUser.at > lastConsultAt : false;
  }

  // 只留最近几次工具调用：顾问关心的是「它卡在哪一步」，不是完整调用史。
  if (summary.tools.length > toolLimit) summary.tools = summary.tools.slice(-toolLimit);
  return summary;
}

/**
 * 把 `summarizeSession` 的结果渲染成给顾问读的实况报告。
 *
 * 刻意写成散文式短段而不是 JSON：这份文本要进的是顾问的上下文，不是程序。
 * 但每个数字都来自上面的结构化结果，绝不在这里另做推断——报告里出现的事实
 * 必须都能在 `summarizeSession` 的输出里找到出处。
 *
 * @param {object} summary `summarizeSession` 的输出。
 * @param {object} [meta] 会话元信息：`{sessionId, title, running, cwd}`。
 * @param {number} [maxChars] 上限。
 * @returns {string}
 */
export function renderPrincipalReport(summary, meta = {}, maxChars = 12000) {
  // summary 理应由 summarizeSession 产出，但它是从宿主事件流算出来的，中间
  // 任何一环（inspect 返回怪形状、会话是空的）都可能让它变成 null。报告本身
  // 是给顾问看的诊断材料，不能因为「没读到东西」就抛异常——那样顾问连
  // 「读不到」都看不到。
  const safe = summary && typeof summary === 'object' ? summary : {};
  const parts = ['【主会话实况】'];
  parts.push(`会话：${meta.sessionId ?? '未知'}${meta.title ? `（${meta.title}）` : ''}`);
  if (meta.cwd) parts.push(`工作目录：${meta.cwd}`);

  parts.push(
    '',
    '## 它现在在不在干活',
    meta.running === true
      ? `**正在运行**（最后一条事件在 ${safe.idleText ?? '未知'}之前，是它自己正在产出的事件）。`
      : meta.running === false
        ? `**空闲**（当前没有在跑；最后一次活动是 ${safe.idleText ?? '未知'}之前）。`
        : `运行状态未知；最后一条事件在 ${safe.idleText ?? '未知'}之前。`,
  );
  if (Number.isFinite(safe.turn)) {
    parts.push(`进度停在：第 ${safe.turn} 轮${Number.isFinite(safe.step) ? `第 ${safe.step} 步` : ''}。`);
  }

  parts.push('', '## 上次联系我们之后');
  if (safe.sinceLastConsultText === null || safe.sinceLastConsultText === undefined) {
    parts.push('它还没向你求助过（这是你们的第一次接触）。');
  } else if (safe.topicMoved === true) {
    parts.push(
      `距离上次求助已经过去 ${safe.sinceLastConsultText}，**而且它在求助之后又收到了新的人类输入**——`,
      '说明它已经往前走了：可能是新进展，也可能换了话题。下面「最近对方说的话」就是那条新输入。',
    );
  } else if (safe.topicMoved === false) {
    parts.push(
      `距离上次求助已经过去 ${safe.sinceLastConsultText}，之后**没有新的人类输入**。`,
      '也就是说它大概率还停在当时那个状态里——除非它自己又调了工具。',
    );
  } else {
    parts.push(`距离上次求助已经过去 ${safe.sinceLastConsultText}。`);
  }

  parts.push('', '## 最近对方说的话');
  if (safe.lastUser) {
    const when = safe.lastUser.at !== null && safe.lastUser.at !== undefined
      ? `${humanGap(Date.now() - safe.lastUser.at)}前`
      : '时间未知';
    parts.push(`（${when}）${safe.lastUser.text === '' || safe.lastUser.empty ? '（这条没有文字，可能是图片/附件）' : ''}`, safe.lastUser.text);
  } else {
    parts.push('（读不到人类输入）');
  }

  parts.push('', '## 它最后说的一段');
  if (safe.lastAssistant) {
    parts.push(safe.lastAssistant.text);
  } else {
    parts.push('（它还没有留下文字输出）');
  }

  const tools = Array.isArray(safe.tools) ? safe.tools : [];
  if (tools.length > 0) {
    parts.push('', `## 最近调用的工具（共 ${Number(safe.toolCount) || tools.length} 次，这里是最后 ${tools.length} 次）`);
    for (const tool of tools) {
      const when = tool.at !== null && tool.at !== undefined ? `${humanGap(Date.now() - tool.at)}前 · ` : '';
      parts.push(`- ${when}${tool.name}${tool.args ? ` ${tool.args}` : ''}`);
    }
  }

  parts.push('', '共读到 ' + (Number(safe.eventCount) || 0) + ' 条事件。');
  return clamp(parts.join('\n'), maxChars);
}

/**
 * 组装留给主会话看的便条文本。
 *
 * 顾问写便条时是「站在外面」看的，主会话读到它时可能已经又往前走了一段，
 * 所以每条都带上传出时间与新鲜度——主会话才判断得出这条便条是不是已经过时。
 *
 * @param {Array<{at: number, slot: number, text: string}>} notes
 * @param {number} [now]
 * @returns {string}
 */
export function renderNotes(notes, now = Date.now()) {
  const list = Array.isArray(notes) ? notes : [];
  if (list.length === 0) return '';
  const parts = ['【顾问留言】你的独立顾问在旁观察后留下了这些话（它不在你的对话里，看不到你后来做了什么，请自行判断是否已经过时）：'];
  for (const note of list) {
    const age = Number.isFinite(note?.at) ? `（${humanGap(now - note.at)}前留下` : '（时间未知';
    const slot = Number.isFinite(note?.slot) && note.slot > 1 ? `，来自第 ${note.slot} 号顾问）` : '）';
    parts.push('', `${age}${slot}`, String(note?.text ?? ''));
  }
  return parts.join('\n');
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
