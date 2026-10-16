# dsh-second-opinion

> **A "second opinion" plugin for DeepSeek Harness** — when one session gets stuck, hand the problem to another **independent session** for a fresh look, then bring the answer back.
> The asking session **waits synchronously** inside its own tool call and receives the advisor's answer **as a tool result**: no waking idle sessions, and no impersonating the user.
>
> The reverse direction works too: the user can **step into the advisor window** and have it check on the principal and leave a note — without interrupting the principal at all.

English | [中文](README.md)

![status](https://img.shields.io/badge/DEEPSEEK%20HARNESS-plugin-4B6BFB) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

| |
|---|
| [`dsh-proxy-on-demand`](https://github.com/xfgil/dsh-proxy-on-demand) — on-demand proxy, shuts itself down |
| [`dsh-game-guard`](https://github.com/xfgil/dsh-game-guard) — quiet down while gaming |
| [`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) — edit plugin source without restarting |
| [`dsh-session-clock`](https://github.com/xfgil/dsh-session-clock) — per-session clock and idle gaps |
| **`dsh-second-opinion`** — ask another session for a second opinion when stuck (this repo) |
| [`dsh-onebot-companion`](https://github.com/xfgil/dsh-onebot-companion) — QQ channel all-in-one: outbound gate, rules, rhythm, persona, voice |

---

## In one sentence

When a model spirals, it has a structural blind spot: **every step of a loop looks
like progress from the inside.** The session doing the looping cannot tell that it is
going in circles — it just keeps trying the next variant.

Breaking out requires an **outside view**: something that does not share your
assumptions, reads the problem fresh, and says "your third assumption is wrong."

This plugin provides that view for the cost of one tool call:

```
A is stuck → calls ask_advisor → the plugin creates an advisor dedicated to A (titled "辅助" + A's first three characters) → B analyzes → answer returns to A
```

Every asking session gets **its own** advisor (sessions that never ask are never given one);
to have the same question thought through by a second independent session, pass `advisor: 2`.

---

## Why it exists (both built-in routes fall short)

DSH already has cross-session messaging, but neither existing route can do this:

| Route | Wakes an idle session | What the peer sees | Why it doesn't work |
| --- | --- | --- | --- |
| `sessionController.prompt` | ✅ auto-resumes | **"the user said this"** | It hardcodes the message source as `kind: "user"` (`const source = { kind: "user", rpcId: request.requestId, ... }` inside `@deepseek-ai/dsh-api-session-controller`) — **impersonating the user**, unacceptable |
| `send_message` | ✅ starts a turn | `agent-message · relay` | Authorization restricts it to the **parent/child chain** (`dsh-subagent` compares `session.header.parentSession`); it cannot reach two sibling sessions |

**The gap = arbitrary session pair + can wake + does not impersonate the user** —
a combination the host does not provide.

This plugin's approach is to **sidestep cross-session delivery entirely**: instead of
posting the question to the advisor and waiting for it to come back, the asking session
**waits synchronously inside its own tool call**. A tool result naturally belongs to the
session that made the call, so no delivery is needed at all — none of the three
constraints above are hit, and nobody is impersonated.

The cost is that the asking session blocks while waiting — which is exactly the desired
semantics: a stuck session *should* stop and wait for an outside judgement rather than
spin while waiting.

---

## How it works

```
┌──────────────┐   ask_advisor(...)      ┌─────────────────┐
│  Session A   │ ──────────────────────▶ │ dsh-second-     │
│  (stuck)     │                         │ opinion         │
│              │ ◀────────────────────── │                 │
└──────────────┘  tool result = B's answer└────────┬────────┘
                                                  │ 1. resolveAgent / create
                                                  │ 2. followup(prompt)
                                                  │ 3. wait until B's status is idle again
                                                  │ 4. snapshotEvents(boundary) → last non-empty assistant message
                                                  ▼
                                          ┌─────────────────┐
                                          │  Advisor B       │
                                          │ (auto-created,   │
                                          │  one per caller) │
                                          └─────────────────┘
```

Four implementation decisions that matter:

1. **Answer boundaries come from a `session.seq` snapshot.** The advisor's log length
   is recorded **before** delivering, and only the events appended afterwards are read.
   Even though an advisor session is consulted many times, you only ever get this
   consult's answer — never a previous one's.
2. **Answer extraction follows the host's own rule.** `extractAnswer` in
   `lib/compose.js` mirrors `finalAssistantOutput` from `@deepseek-ai/dsh-subagent`:
   take the **last non-empty** assistant message; empty-content messages (recorded for
   accounting) must not overwrite earlier output. So when the advisor emits text and then
   a tool-only empty message, the text survives.
3. **Each advisor slot is serialized.** Every asking session has its own advisor, but one
   slot can still be consulted concurrently (two tool calls in the same session, or a
   subagent it spawned). The answer boundary of the later request would then overlap the
   earlier one and read someone else's reply. A per-advisor promise chain queues them.
4. **Waiting polls `agent.status` rather than trusting `whenIdle()` alone.** The host's
   `wakeDriver` **returns early without creating a new `activityDone`** when the agent is
   already not idle (`if (this.phase.kind !== "idle") { ... return; }` in
   `dsh-agent-loop`'s `wakeDriver()`). In that case `whenIdle()` resolves against the
   **previous** turn's promise and returns before this turn's answer exists, making us
   read an empty result. So we poll `status` and use `whenIdle()` only as a fast signal.

---

## Triggering (three routes)

### 1. The session realizes it is stuck → calls the tool itself

The `ask_advisor` description spells out when it applies, and the model decides:

- repeated trial and error, editing the same spot without progress;
- the same error recurring in different forms;
- the user saying "you're stuck" or "try a different angle".

### 2. The user says so → their words enter the context and the session calls the tool

No configuration needed — "you're stuck, ask the advisor" is enough.

### 3. The other way round: the user drives it from the advisor window

A user who does not want to interrupt the principal's thinking can say "go see what it is
doing" **inside the advisor session** — the advisor reads the live picture with
`advisor_watch` and leaves a note with `advisor_note`, never touching the principal's
context. The principal picks that note up the next time it calls a tool itself.

> **Why not passively watch the behavior stream and intervene on detected loops?**
> Because every step of a loop looks like progress from the inside — the session doing it
> cannot tell. That is precisely why an outside view is needed. Real passive detection
> would require a separate observer **reading the session log from the outside**, which is
> a different plugin's job. This plugin keeps triggering explicit.

---

## Tools

### `ask_advisor`

Hands a stuck problem to an independent advisor session.

| Parameter | Required | Description |
| --- | --- | --- |
| `question` | ✅ | The specific question for the advisor. **Make it a real question**, not "help me" |
| `situation` | ⭕ | Where you are stuck: what you were doing, what you expected, what happened |
| `tried` | ⭕ | What you already attempted and why each failed. **This is the most valuable part** — it stops the advisor from repeating your dead ends |
| `context` | ⭕ | Relevant raw context: file paths, code snippets, error messages |
| `advisor` | ⭕ | Which advisor to use, `1` by default. Pass `2`, `3`, … to have the **same question** thought through again by a completely **independent** session. Each slot is a separate advisor session; they do not know the others exist |

Returns:

```json
{
  "ok": true,
  "advisor": { "sessionId": "session-...", "title": "辅助正则匹", "slot": 1, "cwd": "D:\\...\\your working directory" },
  "elapsedMs": 48213,
  "timedOut": false,
  "answer": "...the advisor's full reply..."
}
```

Failures and timeouts return `{ ok: false, ... }` — it **never throws**. The tool body is
wrapped in try/catch and only ever returns an error object, so it can never break the
conversation.

### `advisor_status`

Inspects **this session's** advisors, or resets them.

| Parameter | Required | Description |
| --- | --- | --- |
| `reset` | ⭕ | `true` discards **this session's** advisor records; the next consult **creates** new ones (the old sessions themselves are not deleted) |
| `all` | ⭕ | `true` also lists the advisors of every asking session |

Returns `callerSessionId` / `callerTitle` / `advisors` (array; each entry has `slot`,
`sessionId`, `title`, `cwd`, `live`, `consults`, `lastConsultAt`, `createdAt`) /
`droppedAdvisorSessionIds` / `legacyAdvisorSessionId` / `maxAdvisors` / `stateFile` /
`notes`.

### `advisor_watch` (advisor-only)

The two tools above run "asking session → advisor". This one and `advisor_note` run the
**other way**: the user walks into the advisor window and says "go see what the principal
is doing and lend a hand".

It reports what **the principal session you advise** is doing right now: whether it is
running, which step it stopped at, how long since it last asked for help, whether the
topic has moved on, what was said recently, and which tools were called last.

| Parameter | Required | Description |
| --- | --- | --- |
| `detail` | ⭕ | `summary` (default) for the full picture; `tools` for just the recent tool calls |

**Strictly read-only.** It goes through `sessionController.inspect`, whose own comment
says *without activating its Agent*: an attached session yields an in-memory snapshot, a
cold one is read from persistence, and in both cases it **does not resume, does not wake
the other side, and writes nothing into its log**. The running flag comes separately from
`sessionController.list()` (also non-resuming). That is the technical guarantee behind
"do not interrupt the principal's thinking".

Returns `{ ok, principal: { sessionId, slot, title, running, cwd, lastActivityAt,
idleMs, sinceLastConsultMs, topicMoved }, report, note }`. `report` is a prose picture
meant for a human reader; when `running` cannot be determined it is `null` and the report
says "run state unknown" — **it never defaults to running or idle, because that would be
fabrication**.

### `advisor_note` (advisor-only)

Leaves a note for the principal session you advise. The principal sees it alongside the
tool result the **next time** it calls `ask_advisor` or `advisor_status`, and thereby
learns that you are watching and what you found.

| Parameter | Required | Description |
| --- | --- | --- |
| `text` | ✅ | The note: what you observed, what you suggest, and your evidence |

A note is **only a message**: it does not pop up, it does not alter the principal's
ongoing thinking, and it is read only when the principal itself calls a tool next. So
write the conclusion and the reasoning together — by the time the principal reads it, it
may have moved on, and it has to be able to judge whether the note still applies.

Notes are filed per **asking session**, capped at `maxNotes` (5 by default; the oldest is
dropped — it is also the likeliest to be stale), and they are **consumed on read**: once
the principal has seen them the queue is cleared, so a tool call does not re-show the same
old notes.

> **Who may call these two tools?** Only advisor sessions **created by this plugin** — it
> looks the ownership up in `advisors[askingSession].slots[]` in the state file rather
> than keeping a second record. Any other session gets an error (their whole semantics rest
> on "I am assisting some principal"; opening them up would hand every session the ability
> to snoop on others). A principal that needs help should use `ask_advisor`.

### How advisor sessions are named

The plugin titles each advisor session as **`辅助` + the first three characters of the
asking session's title** (change the prefix with `advisorLabel`). The 2nd, 3rd … advisor
of the same asking session gets its slot number appended:

| Asking session title | Slot | Advisor title |
| --- | --- | --- |
| 正则匹配不上 | 1 | 辅助正则匹 |
| 正则匹配不上 | 2 | 辅助正则匹2 |
| 真 | 1 | 辅助真 |

So at a glance in the session list you can tell which advisor serves whom.

Two details: before the asking session has a title (a fresh session's first turn) the
plugin falls back to the **first few characters of its session id** rather than leaving it
blank; and if the asking session is later renamed, the next consult **updates the advisor
title along with it** (only written when it actually differs, so a consult does not append
an event every single time).

Naming goes through the host's `sessionController.rename`, which pins the title source to
`user` so it is no longer overwritten by automatic title generation — exactly what we want.

---

## Configuration

Written in the profile's `cordis.patch.yml` (**no Config schema is exported** — the
profile side cannot resolve schemastery, and exporting a non-schema object makes the
loader fail while projecting config; config keys are therefore read only at runtime).

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` registers no tools at all |
| `waitMs` | `600000` (10 min) | Per-consult ceiling for waiting on the advisor. **A timeout does not kill the advisor** — the asking side simply gives up waiting |
| `cwd` | `''` | Advisor working directory. **Defaults to the asking session's** (recommended — the advisor sees the same files) |
| `maxPromptChars` | `20000` | Prompt size ceiling (characters) |
| `maxAnswerChars` | `12000` | Answer size ceiling returned to the asking session |
| `stateFile` | `''` | State file path; empty means `$DSH_HOME/second-opinion/state.json` |
| `advisorLabel` | `辅助` | Prefix for advisor session titles, followed by the asking session's first three characters |
| `maxAdvisors` | `9` | Maximum number of advisor slots per asking session |
| `maxWatchedTools` | `12` | How many tool calls `advisor_watch` lists (the count itself is always the full total) |
| `maxReportChars` | `12000` | Character ceiling for the `advisor_watch` report |
| `maxNotes` | `5` | Note-queue ceiling per asking session; the oldest is dropped past it |
| `maxNoteChars` | `4000` | Character ceiling for a single note |

Over-long content is truncated **with a visible marker**
(`…(content too long, truncated, original N characters)`). Silent truncation would let a
model conclude from incomplete information believing it was complete.

---

## Requirements

### DSH host

| Item | Version |
| --- | --- |
| DSH | **0.2.0-rc.2** (tested against this version) |
| Node (embedded in host) | >= 22 (`engines` in `package.json`) |

### Host services and interfaces used

| Dependency | Required | Notes |
| --- | --- | --- |
| `ctx.sessionController` | ✅ | `create()` to make an advisor, `resolveAgent()` to revive an existing one |
| `ctx.tools` | ✅ | Registers the four tools |
| `agent.followup(msg)` | ✅ | Delivers the consult request **and wakes the advisor** |
| `agent.whenIdle()` / `agent.status` | ✅ | Waits for the advisor to finish |
| `agent.session.seq` / `snapshotEvents(from)` | ✅ | Defines the answer boundary and reads the reply |
| `ctx.agents.get(id)` | ⭕ optional | `advisor_status` uses it for `live`; consults work without it |
| `ctx.sessionTitle.get(session)` | ⭕ optional | Reads the asking session's title as the naming source; falls back to the session id |
| `sessionController.rename()` | ⭕ optional | Titles advisor sessions. Skipped on an older host that lacks it; consults still work |
| `sessionController.inspect(id)` | ⭕ optional | `advisor_watch` reads the principal through it. **Read-only, does not resume the Agent**; without it the tool returns a failure |
| `sessionController.list()` | ⭕ optional | `advisor_watch` reads `running` from it. Also non-resuming; if unavailable the report says "run state unknown" |
| `@deepseek-ai/dsh-llm`'s `createUserMessage` | ⭕ optional | **Deliberately unused**: the package is not in the profile's `node_modules`. This plugin builds messages itself (see below) |

**Zero runtime dependencies**: only `node:fs` / `node:os` / `node:path` / `node:crypto`
plus one local module, `./compose.js`.

### A hand-built message must carry `id`

This plugin does not import `@deepseek-ai/dsh-llm` (the profile side cannot resolve it),
so it constructs the `user` message shape itself. One convention is **mandatory**:

```js
{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind, form: 'snapshot', sections: [...] } }
```

`id` cannot be omitted. The host **does not validate on write but validates strictly on
read** (`assertMessageEventShape` requires `typeof message.id === 'string' && !== ''`),
so a message without `id` is written happily and then blows up **the next time the session
is loaded**:

```
SessionQueryError: stored session "..." is corrupt:
  session event at seq N lacks an identified message
```

The consequence is far worse than a single failed turn — **the whole session becomes
permanently unopenable**.

### State file

```
$DSH_HOME/second-opinion/state.json     # default; falls back to ~/.dsh when DSH_HOME is unset
```

State lives under `advisors`, keyed by the **asking session's id**; each entry holds
`createdAt`, the last known asking title, a `notes[]` queue (written by the advisor via
`advisor_note`, read by the principal, cleared on read), and a `slots[]` array of advisor
records (`sessionId`, `title`, `cwd`, `createdAt`, `consults`, `lastConsultAt`). Plus a
`version` (currently `3`) and, for sessions upgraded from an earlier flat layout, a
`legacyAdvisorSessionId` note. A corrupt file falls back to an empty table — the worst case
is simply freshly created advisors. Deleting it means the next consult creates new advisors
(the old sessions themselves remain).

---

## Install

```bash
dsh plugin --profile <your profile> add link:/absolute/path/dsh-second-opinion
```

Or from npm/GitHub (if published):

```bash
dsh plugin --profile <your profile> add dsh-second-opinion
```

**No restart is normally required**: the host's built-in HMR notices the profile manifest
change and reconciles. Check with `/status`, or have the model call `advisor_status` once.

---

## How to verify it actually works

Minimal flow (you do not have to be genuinely stuck):

1. Have the model call `ask_advisor` with something it can check, e.g.
   `question: "What is 2 to the power of 10?"`;
2. Look at the returned `advisor.sessionId` and `advisor.title` — that session is visible
   in the GUI session list, titled "辅助" + the first three characters of your own title;
3. Open the advisor session; you should see a self-introduction (`ADVISOR_INTRO`) and your question;
4. Back in the asking session, `answer` holds the advisor's reply text.

---

## ⚠️ Personal-use disclaimer

**This plugin is a small personal tool, provided "as is", without warranty of any kind.**

- The author is not DSH / DeepSeek; this plugin is **not affiliated with or endorsed by** them.
- The code is tuned around **one specific profile**; compatibility with other setups is untested.
- It **creates a new session automatically** and sends your problem content into it.
  Make sure that matches your privacy expectations.
- It relies on DSH's **internal, undocumented interfaces**: the shape of
  `ctx.sessionController.resolveAgent` / `create`, `agent.followup` / `whenIdle` /
  `session.snapshotEvents`, and the `message.content` / `stream` structure of assistant
  events. These are not stable APIs and **may break at any time** after a DSH upgrade.
- Use at your own risk. The author accepts no liability for any direct or indirect
  damages arising from use of this plugin.

---

## License

MIT © 2026 xfgil
