# dsh-second-opinion

> **A "second opinion" plugin for DeepSeek Harness** — when one session gets stuck, hand the problem to another **independent session** for a fresh look, then bring the answer back.
> The asking session **waits synchronously** inside its own tool call and receives the advisor's answer **as a tool result**: no waking idle sessions, and no impersonating the user.

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
A is stuck → calls ask_advisor → plugin creates/reuses advisor session B → B analyzes → answer returns to A
```

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
                                          │  reused)         │
                                          └─────────────────┘
```

Four implementation decisions that matter:

1. **Answer boundaries come from a `session.seq` snapshot.** The advisor's log length
   is recorded **before** delivering, and only the events appended afterwards are read.
   Even though the advisor session is reused across many consults, you only ever get this
   consult's answer — never a previous one's.
2. **Answer extraction follows the host's own rule.** `extractAnswer` in
   `lib/compose.js` mirrors `finalAssistantOutput` from `@deepseek-ai/dsh-subagent`:
   take the **last non-empty** assistant message; empty-content messages (recorded for
   accounting) must not overwrite earlier output. So when the advisor emits text and then
   a tool-only empty message, the text survives.
3. **One advisor is serialized.** If two sessions consult the same advisor at once, the
   second one's answer boundary overlaps the first's and it reads someone else's reply.
   A per-advisor promise chain queues concurrent requests.
4. **Waiting polls `agent.status` rather than trusting `whenIdle()` alone.** The host's
   `wakeDriver` **returns early without creating a new `activityDone`** when the agent is
   already not idle (`if (this.phase.kind !== "idle") { ... return; }` in
   `dsh-agent-loop`'s `wakeDriver()`). In that case `whenIdle()` resolves against the
   **previous** turn's promise and returns before this turn's answer exists, making us
   read an empty result. So we poll `status` and use `whenIdle()` only as a fast signal.

---

## Triggering (two routes)

### 1. The session realizes it is stuck → calls the tool itself

The `ask_advisor` description spells out when it applies, and the model decides:

- repeated trial and error, editing the same spot without progress;
- the same error recurring in different forms;
- the user saying "you're stuck" or "try a different angle".

### 2. The user says so → their words enter the context and the session calls the tool

No configuration needed — "you're stuck, ask the advisor" is enough.

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

Returns:

```json
{
  "ok": true,
  "advisor": { "sessionId": "session-...", "cwd": "D:\\...\\your working directory" },
  "elapsedMs": 48213,
  "timedOut": false,
  "answer": "...the advisor's full reply..."
}
```

Failures and timeouts return `{ ok: false, ... }` — it **never throws**. The tool body is
wrapped in try/catch and only ever returns an error object, so it can never break the
conversation.

### `advisor_status`

Inspects the advisor session, or resets it when it misbehaves.

| Parameter | Required | Description |
| --- | --- | --- |
| `reset` | ⭕ | `true` discards the current advisor record; the next consult **creates** a new one (the old session itself is not deleted) |

Returns `advisorSessionId` / `cwd` / `live` / `consults` / `lastConsultAt` /
`createdAt` / `stateFile`.

---

## Configuration

Written in the profile's `cordis.patch.yml` (**no Config schema is exported** — the
profile side cannot resolve schemastery, and exporting a non-schema object makes the
loader fail while projecting config; a lesson from `dsh-onebot-guard`. Config keys are
therefore read only at runtime).

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` registers no tools at all |
| `waitMs` | `600000` (10 min) | Per-consult ceiling for waiting on the advisor. **A timeout does not kill the advisor** — the asking side simply gives up waiting |
| `cwd` | `''` | Advisor working directory. **Defaults to the asking session's** (recommended — the advisor sees the same files) |
| `maxPromptChars` | `20000` | Prompt size ceiling (characters) |
| `maxAnswerChars` | `12000` | Answer size ceiling returned to the asking session |
| `stateFile` | `''` | State file path; empty means `$DSH_HOME/second-opinion/state.json` |
| `advisorLabel` | `second-opinion-advisor` | Advisor label (naming only) |

Over-long content is truncated **with a visible marker**
(`…(content too long, truncated, original N characters)`). Silent truncation would let a
model conclude from incomplete information believing it was complete.

---

## Requirements

### DSH host

| Item | Version |
| --- | --- |
| DSH | **0.2.0-rc.2** (developed and tested against) |
| Node (embedded in host) | >= 22 (`engines` in `package.json`) |

### Host services and interfaces used

| Dependency | Required | Notes |
| --- | --- | --- |
| `ctx.sessionController` | ✅ | `create()` to make an advisor, `resolveAgent()` to revive an existing one |
| `ctx.tools` | ✅ | Registers the two tools |
| `agent.followup(msg)` | ✅ | Delivers the consult request **and wakes the advisor** |
| `agent.whenIdle()` / `agent.status` | ✅ | Waits for the advisor to finish |
| `agent.session.seq` / `snapshotEvents(from)` | ✅ | Defines the answer boundary and reads the reply |
| `ctx.agents.get(id)` | ⭕ optional | `advisor_status` uses it for `live`; consults work without it |
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

Only three fields matter: `advisorSessionId` (the reused advisor), `consults` (total
count), `createdAt`. A corrupt file falls back to an empty table — the worst case is
simply a freshly created advisor. Deleting it means the next consult creates a new advisor
(the old session itself remains).

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
2. Look at the returned `advisor.sessionId` — that session is visible in the GUI session list;
3. Open the advisor session; you should see a self-introduction (`ADVISOR_INTRO`) and your question;
4. Back in the asking session, `answer` holds the advisor's reply text.

Self-tests (pure functions + a host mock, **no real DSH needed**):

```bash
npm test        # = node test/selftest.mjs && node test/host-mock.mjs
```

- `test/selftest.mjs` (44 assertions): `compose.js` pure functions — prompt assembly,
  answer extraction (including the streaming fallback and "empty message must not swallow
  the body"), truncation markers.
- `test/host-mock.mjs` (51 assertions): calls `apply()` for real against a fake ctx,
  covering tool registration, a normal answer, timeout, empty answer, **recursion guard**,
  advisor revive failure, creation failure, **concurrent serialization**, and corrupt-state
  recovery.

It cannot replace a real session run (a fake agent does not actually think), but it pins
down the **contract**: who throws, who returns an error object, and which event range the
answer is read from.

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

## Development

```
lib/
  index.js     # main: advisor lifecycle, consult queue, waiting, tool registration
  compose.js   # pure functions: prompt assembly, answer extraction, truncation (testable without the host)
test/
  selftest.mjs   # unit tests for compose.js
  host-mock.mjs  # runs apply() for real against a fake ctx, covering index.js
cordis.patch.yml
```

- Zero runtime dependencies (only `node:` builtins).
- `lib/compose.js` is deliberately split from `index.js` so the most error-prone part
  ("answer extraction") can be pinned down assertion by assertion without the host.
- For live edits while developing, pair it with
  [`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) to apply changes
  without restarting.

---

## License

MIT © 2026 xfgil
