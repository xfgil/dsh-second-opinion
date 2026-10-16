# dsh-second-opinion

> **给 DeepSeek Harness 的「第二意见」插件**——一个会话卡住时，把问题交给另一个**独立会话**单独思考，把方案拿回来。
> 求助方在自己的工具调用里**同步**等顾问答完，答案作为**工具结果**直接返回：不需要唤醒闲置会话，也不冒充用户发言。
>
> 反方向也通：用户可以**跑到顾问窗里**让它去看看主会话在干什么、留一张便条，全程不打断主会话。

[English](README.en.md) | 中文

![status](https://img.shields.io/badge/DEEPSEEK%20HARNESS-plugin-4B6BFB) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

| |
|---|
| [`dsh-proxy-on-demand`](https://github.com/xfgil/dsh-proxy-on-demand) — 按需代理，用完自动关 |
| [`dsh-game-guard`](https://github.com/xfgil/dsh-game-guard) — 游戏时收起打扰面 |
| [`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) — 改完插件源码不用重启 |
| [`dsh-session-clock`](https://github.com/xfgil/dsh-session-clock) — 按会话授时与空闲间隔 |
| **`dsh-second-opinion`** — 卡住时找另一个会话要第二意见（本仓库） |
| [`dsh-onebot-companion`](https://github.com/xfgil/dsh-onebot-companion) — QQ 通道一体化：出站沉默守卫 / 行为规则 / 对话节奏 / 人设 / 语音 |

---

## 一句话说明

模型陷入思维僵局时有个结构性缺陷：**打转当下每一步看上去都像在推进**。
站在里面的那个会话识别不出自己在原地绕圈，它只会继续试下一个变体。

打破僵局需要的是一个**外部视角**——不了解你的思路、不会被你的假设带着走，
从头读一遍问题然后说「你第三条假设错了」。

本插件提供这个视角，成本是一次工具调用：

```
A 卡住 → 调 ask_advisor → 插件为 A 建一个专属顾问会话（名为「辅助+前三字」）→ B 独立分析 → 答案回到 A
```

每个求助会话有**自己的**顾问（没求助过的会话不会被建），同一个问题想让第二个独立会话再想一遍时，传 `advisor: 2` 再要一个。

---

## 为什么需要它（宿主已有的两条路都不合用）

DSH 已经有跨会话通信能力，但两条现成通道都做不成这件事：

| 通道 | 能叫醒闲置会话 | 对方看到什么 | 为什么不用 |
| --- | --- | --- | --- |
| `sessionController.prompt` | ✅ 自动 resume | **「用户本人发言」** | 它把消息来源硬编码成 `kind: "user"`（`@deepseek-ai/dsh-api-session-controller` 内 `const source = { kind: "user", rpcId: request.requestId, ... }`）——**冒充用户**，不可接受 |
| `send_message` | ✅ 起新 turn | `agent-message · relay` | 授权档位把它限制在**父子链**上（`dsh-subagent` 里比对 `session.header.parentSession`），够不着两个平级会话 |

**缺口 = 跨任意会话 + 能唤醒 + 不冒充用户**——这三项组合宿主没有提供。

本插件的办法是**绕开「跨会话投递」这件事本身**：求助方不把问题发给顾问、
等它回头；而是**在自己的工具调用里同步等**。工具结果天然属于发出调用的那个会话，
根本不需要任何投递，于是上面三条限制一条都不撞，也没有任何人被冒充。

代价是求助方在等待期间阻塞——而这正是想要的语义：卡住的那个会话本来就该
**停下来**等一个外部判断，而不是一边打转一边等。

---

## 工作原理

```
┌──────────────┐   ask_advisor(...)      ┌─────────────────┐
│  会话 A      │ ──────────────────────▶ │ dsh-second-     │
│ （卡住了）    │                         │ opinion         │
│              │ ◀────────────────────── │                 │
└──────────────┘   工具结果 = B 的答案    └────────┬────────┘
                                                  │ ① resolveAgent / create
                                                  │ ② followup(prompt)
                                                  │ ③ 等 B 的 status 变回 idle
                                                  │ ④ snapshotEvents(边界) → 取最后非空 assistant 消息
                                                  ▼
                                          ┌─────────────────┐
                                          │  顾问会话 B      │
                                          │ （自动创建，每     │
                                          │  个求助方一个）    │
                                          └─────────────────┘
```

四个关键实现决定：

1. **答案边界靠 `session.seq` 快照。** 投递**之前**记下顾问的日志长度，
   投递后只读那段新增事件。这样即使顾问会话被复用了很多次，也只会取到
   本次咨询的答案，不会串到上一次。
2. **取答案用宿主自己的规则。** `lib/compose.js` 的 `extractAnswer` 与
   `@deepseek-ai/dsh-subagent` 的 `finalAssistantOutput` 保持一致：取
   **最后一条非空** assistant 消息，空 content 的消息（记账用）不能覆盖已有正文。
   这样顾问「先给正文、再补一次只有工具调用的空消息」时，正文不会被吞掉。
3. **同一个顾问槽位串行排队。** 每个求助会话有自己的顾问，但同一个槽位可能被
   并发咨询（同一会话的两处工具调用、或它派生的子代理），此时后者的答案边界会和
   前者重叠、读到别人的回答。per-advisor 的 Promise 链把并发请求排成队列。
4. **等待以 `agent.status` 为准，不靠 `whenIdle()` 单打独斗。** 宿主
   `wakeDriver` 在 agent 已经不是 idle 时会**直接 return、不新建 `activityDone`**
   （`dsh-agent-loop` 的 `wakeDriver()` 开头 `if (this.phase.kind !== "idle") { ... return; }`）。
   那种情况下 `whenIdle()` 解析的是**上一轮**的 promise，会在本轮答案产生之前
   就返回，让我们读到空结果。所以这里轮询 `status`，`whenIdle()` 只当加速信号。

---

## 工具

### `ask_advisor`

把一个卡住的问题交给独立的顾问会话。

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `question` | ✅ | 要顾问回答的具体问题。**写成一个明确的问句**，而不是「帮帮我」 |
| `situation` | ⭕ | 你卡在哪：正在做什么、期望什么、实际发生什么 |
| `tried` | ⭕ | 已试过哪些做法、各自为什么不行。**这段最有价值**——它让顾问不必重复你的死路 |
| `context` | ⭕ | 相关上下文原文：文件路径、代码片段、报错信息 |
| `advisor` | ⭕ | 用第几个顾问，默认 `1`。想让同一个问题由**另一个完全独立**的会话再想一遍时传 `2`、`3`……每个槽位是独立顾问会话，互不知道对方的存在 |

返回：

```json
{
  "ok": true,
  "advisor": { "sessionId": "session-...", "title": "辅助正则匹", "slot": 1, "cwd": "D:\\...\\你的工作目录" },
  "elapsedMs": 48213,
  "timedOut": false,
  "answer": "……顾问的完整回答……"
}
```

失败或超时返回 `{ ok: false, ... }`，**不抛异常**——工具内部整段 try/catch，
出错只返回错误对象，绝不会阻断对话。

### `advisor_status`

查**本会话**的顾问状态，或重置它。

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `reset` | ⭕ | 设为 `true` 则丢弃**本会话**的顾问记录，下次咨询会**新建**一个（不删除旧会话本身） |
| `all` | ⭕ | 设为 `true` 则额外列出所有求助会话各自的顾问 |

返回 `callerSessionId` / `callerTitle` / `advisors`（数组，每项含 `slot` /
`sessionId` / `title` / `cwd` / `live` / `consults` / `lastConsultAt` /
`createdAt`）/ `droppedAdvisorSessionIds` / `legacyAdvisorSessionId` /
`maxAdvisors` / `stateFile` / `notes`。

### `advisor_watch`（顾问专用）

上面两个工具是「求助方 → 顾问」方向；这个和下面的 `advisor_note` 是**反方向**：
用户自己跑到顾问窗里说「去看看主会话在干什么、搭把手」。

查看**你正在辅助的那个主会话**现在在干什么：在不在跑、进度停在哪一步、距上次
求助过了多久、有没有换话题、最近说过什么、最后调了哪些工具。

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `detail` | ⭕ | `summary`（默认）给完整实况；`tools` 只给最近的工具调用清单 |

**全程只读。** 它走 `sessionController.inspect`——宿主的注释明确写着
*without activating its Agent*：会话已附加时读内存快照，冷会话读持久化，两种情况
都**不会 resume、不会唤醒对方、不会往对方的日志里写任何东西**。运行状态另从
`sessionController.list()` 取（同样不 resume）。这正是「不打断主会话思考」的技术保障。

返回 `{ ok, principal: { sessionId, slot, title, running, cwd, lastActivityAt,
idleMs, sinceLastConsultMs, topicMoved }, report, note }`。`report` 是给人读的
散文实况；`running` 拿不到时是 `null`，报告里如实写「运行状态未知」——**绝不默认
成在跑或空闲，那是编造**。

### `advisor_note`（顾问专用）

给你辅助的那个主会话留一条便条。主会话**下次**调用 `ask_advisor` 或
`advisor_status` 时会连同工具结果一起看到它，从而知道你在旁边看着、以及你发现了什么。

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `text` | ✅ | 便条正文：你观察到了什么、建议它做什么、依据是什么 |

便条**只是留言**：它不弹窗、不改变主会话正在进行的思考，要等主会话自己下一次
调用才会读到。所以写的时候把结论和依据一起写清楚——主会话看到时可能已经又往前
走了一段，你得让它能自己判断这条是否还适用。

便条按**求助会话**归档，队列上限 `maxNotes`（默认 5 条，超限丢最旧——它们也最
可能已经过时），并且是**消费式**的：主会话读过就清空，不会每调一次工具就重新看到。

> **谁能调这两个工具？** 只有**本插件创建出来的顾问会话**能——靠反查状态文件里
> `advisors[求助方].slots[]` 判定归属，不另开一份记录。别的会话调它们会直接报错
> （它们整个语义都建立在「我是在辅助某个主会话」这个前提上；放开只会让任意会话
> 拿到窥探别人的能力）。主会话想求助请用 `ask_advisor`。

---

## 触发方式（三条路线）

### 1. 会话自己判断卡住了 → 直接调工具

`ask_advisor` 的 description 里写明了适用场景，模型会自行判断：

- 反复试错、来回改同一处却进展不顺；
- 同一个错误以不同形式重复出现；
- 用户提示「卡住了」「换个思路」。

### 2. 用户说一声 → 用户的话进到上下文，会话同样调这个工具

用户不需要做任何配置，说「你卡住了，问问顾问」即可。

### 3. 反过来：用户自己跑到顾问窗里下命令

用户不想打断主会话的思考时，可以直接**在顾问会话里**说「去看看它在干什么」——
顾问用 `advisor_watch` 读实况、用 `advisor_note` 留便条，全程不碰主会话的上下文。
主会话下次自己调工具时就会读到那条便条。

> **为什么不做「插件自动监听行为流发现打转就介入」？**
> 因为打转当下每一步都像在推进，站在里面的会话识别不出自己在打转——这正是
> 需要外部视角的原因。真要做被动检测，得另写一个**站在外面读会话日志**的
> 观察者，那是另一个插件的范围。本插件选择让触发显式。

---

## 顾问会话怎么命名

顾问会话的标题由插件写入，规则是 **`辅助` + 求助会话标题的前三字**（前缀可用
`advisorLabel` 改）；同一个求助会话的第 2、3 个顾问在后面加槽位号：

| 求助会话标题 | 槽位 | 顾问标题 |
| --- | --- | --- |
| 正则匹配不上 | 1 | 辅助正则匹 |
| 正则匹配不上 | 2 | 辅助正则匹2 |
| 真 | 1 | 辅助真 |

这样在会话列表里一眼就能看出每个顾问在为谁服务。

两个细节：求助会话还没起标题时（新会话首轮之前）退回**会话 id 的前几位**，
不至于空着；求助会话的标题之后变了，下次咨询会**顺带把顾问名一起更新**
（只在确实不同时才写，不会每次咨询都往日志里塞一条事件）。

命名走宿主的 `sessionController.rename`——它会把标题来源钉成 `user`，
之后不会再被自动标题生成覆盖，正是我们要的效果。

---

## 配置

写在 profile 的 `cordis.patch.yml` 里（**不会导出 Config schema**——profile 侧
解析不到 schemastery，导出非 schema 对象会让 loader 投影 config 时报错，所以配置项
只走运行时读取）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时不注册任何工具 |
| `waitMs` | `600000`（10 分钟） | 单次咨询等待顾问的上限。**超时不杀顾问**，只是求助方这边放弃等待 |
| `cwd` | `''` | 顾问会话的工作目录。**默认跟随求助方**（推荐——顾问才看得到同一批文件） |
| `maxPromptChars` | `20000` | 发给顾问的提示词上限（字符） |
| `maxAnswerChars` | `12000` | 返回给求助方的答案上限（字符） |
| `stateFile` | `''` | 状态文件路径；空则用 `$DSH_HOME/second-opinion/state.json` |
| `advisorLabel` | `辅助` | 顾问会话标题的前缀，后面接求助会话标题前三字 |
| `maxAdvisors` | `9` | 一个求助会话最多有几个顾问槽位 |
| `maxWatchedTools` | `12` | `advisor_watch` 报告里最多列几条工具调用（计数仍是全部的） |
| `maxReportChars` | `12000` | `advisor_watch` 报告的字符上限 |
| `maxNotes` | `5` | 每个求助会话的便条队列上限，超限丢最旧 |
| `maxNoteChars` | `4000` | 单条便条的字符上限 |

超长内容会**带标记截断**（`…（内容过长，已截断，原长 N 字符）`）——静默截断会让
模型以为内容本来就这么短，基于不完整信息下结论。

---

## 环境要求

### DSH 宿主

| 项 | 版本 |
| --- | --- |
| DSH | **0.2.0-rc.2**（实测于该版本） |
| Node（宿主内嵌） | >= 22（`package.json` 的 `engines`） |

### 依赖的宿主服务与接口

| 依赖 | 必需 | 说明 |
| --- | --- | --- |
| `ctx.sessionController` | ✅ | `create()` 新建顾问会话、`resolveAgent()` 恢复既有会话 |
| `ctx.tools` | ✅ | 注册四个工具 |
| `agent.followup(msg)` | ✅ | 把咨询请求投给顾问，**同时唤醒它** |
| `agent.whenIdle()` / `agent.status` | ✅ | 等顾问答完 |
| `agent.session.seq` / `snapshotEvents(from)` | ✅ | 划定答案边界、取回答 |
| `ctx.agents.get(id)` | ⭕ 可选 | `advisor_status` 用它报 `live`；没有也不影响咨询 |
| `ctx.sessionTitle.get(session)` | ⭕ 可选 | 读求助会话标题，作为顾问命名的来源；取不到就退回会话 id |
| `sessionController.rename()` | ⭕ 可选 | 给顾问会话改名。宿主太旧没有它时直接跳过，咨询照常 |
| `sessionController.inspect(id)` | ⭕ 可选 | `advisor_watch` 读主会话实况。**只读，不 resume Agent**；没有它时该工具返回失败 |
| `sessionController.list()` | ⭕ 可选 | `advisor_watch` 取 `running`。同样不 resume；拿不到就报「运行状态未知」 |
| `@deepseek-ai/dsh-llm` 的 `createUserMessage` | ⭕ 可选 | **刻意不用**：该包不在 profile 的 `node_modules` 里。本插件自己构造消息（见下） |

**零运行时依赖**：只用 `node:fs` / `node:os` / `node:path` / `node:crypto`，
外加 `./compose.js` 一个自带模块。

### 手写消息必须带 `id`

本插件不 import `@deepseek-ai/dsh-llm`（profile 侧解析不到它），自己构造
`user` 消息形状。这里有一个**必须**遵守的约定：

```js
{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind, form: 'snapshot', sections: [...] } }
```

`id` 不能省。宿主**写入时不校验、读取时严格校验**
（`assertMessageEventShape` 要求 `typeof message.id === 'string' && !== ''`），
缺 `id` 的消息能顺利落盘，直到**下次加载会话时才整条炸掉**：

```
SessionQueryError: stored session "..." is corrupt:
  session event at seq N lacks an identified message
```

后果比单个回合报错重得多——**整个会话永久打不开**。

### 状态文件

```
$DSH_HOME/second-opinion/state.json     # 默认；DSH_HOME 缺省时退回 ~/.dsh
```

状态按**求助会话的 id** 归档在 `advisors` 下；每份档案记 `createdAt`、最近一次读到的
求助方标题、`notes[]` 便条队列（顾问侧 `advisor_note` 写、主会话侧读，读过即清）、
以及 `slots[]` 槽位数组（每项含 `sessionId` / `title` / `cwd` /
`createdAt` / `consults` / `lastConsultAt`）。另有 `version`（当前 `3`），以及从
更早的扁平结构升级上来的会话留下的 `legacyAdvisorSessionId` 痕迹。

文件损坏时按空表继续，最坏情况只是重新建顾问。删掉它 = 下次咨询新建顾问
（旧会话本身还在）。

---

## 安装

```bash
dsh plugin --profile <你的profile> add link:/绝对路径/dsh-second-opinion
```

或者从 npm/GitHub 装（若已发布）：

```bash
dsh plugin --profile <你的profile> add dsh-second-opinion
```

装好后**通常无需重启**：宿主内置的 HMR 会监听到 profile 清单变化并自动 reconcile。
用 `/status` 或让模型调一次 `advisor_status` 确认装载成功。

---

## 怎么验证它真的在工作

最小验证流程（不需要真的卡住）：

1. 让模型调 `ask_advisor`，随便问一个它能验证的问题，例如
   `question: "2 的 10 次方是多少？"`；
2. 看返回的 `advisor.sessionId` 与 `advisor.title`——在 GUI 的会话列表里能找到
   那个会话，标题形如「辅助<你标题的前三字>」；
3. 打开顾问会话，应该能看到一条自我介绍（`ADVISOR_INTRO`）和你的提问原文；
4. 回到求助方，`answer` 字段就是顾问的回复正文。

---

## ⚠️ 自用免责声明

**这个插件是给自己用的小工具，按「现状」提供，不附带任何保证。**

- 作者不是 DSH / DeepSeek 官方，本插件与官方**没有关系**，也不被官方背书。
- 代码主要围绕**作者自己的一个 profile** 打磨，其它环境的兼容性没有验证过。
- 它会**自动创建新会话**并把你的问题内容发进去。请自行确认这符合你的隐私预期。
- 它依赖 DSH 的**内部未公开接口**：`ctx.sessionController.resolveAgent` /
  `create`、`agent.followup` / `whenIdle` / `session.snapshotEvents` 的形状、
  assistant 事件的 `message.content` / `stream` 结构。这些不是稳定 API，
  DSH 升级后**随时可能坏**。
- 使用风险自负。因使用本插件造成的任何直接或间接损失，作者不承担责任。

---

## License

MIT © 2026 xfgil
