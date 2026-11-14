# discordllm

A Discord bot backed by Claude that acts through MCP servers. Self-hosted.

You mention the bot in a channel and it opens a thread. In the thread it works
through whichever [MCP](https://modelcontextprotocol.io) servers you gave it,
and anything risky waits for someone to press **Approve**.

This repository is the part that is the same for every such bot. It knows
nothing about any particular service. A bot is a separate repository that
depends on this one and says only what is its own: which servers to run, which
of their tools are dangerous, and what the agent is told. homeboxcordllm,
hasscordllm and fitcordllm are built this way.

Claude is the default model, through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk); the model sits
behind [one interface](#another-model) and can be replaced.

## What you get

| | |
| --- | --- |
| **Threads** | One conversation per Discord thread, queued per thread, resumable after a restart or a week of silence. |
| **Approval** | A ladder of tiers you name. A call in a tier at or above the approval level posts a card with Approve / Deny and waits. |
| **Scheduled briefs** | "Every morning at 7, tell me…". Runs in a fresh conversation, posts to the channel, and can be continued as a thread. A scheduled run can only look. |
| **Polls** | The agent asks multiple-choice questions as native Discord polls. |
| **Profiles** | One bot process serving several people or households, each with its own channel, credentials and settings. |
| **Quota guard** | An hourly turn budget and a concurrency cap, so the bot cannot exhaust the subscription you also use in your editor. |
| **Ledger** | Sessions, turns, every tool call and every approval, in SQLite by default or Postgres. |
| **REPL** | The same bot from a terminal, with no Discord, for trying things. |
| **Prompt inspection** | Say `prompt` and the bot posts exactly what its agent is told. Every turn's system prompt is kept in the ledger. |
| **Image build** | One Dockerfile and one script for every bot; the image is named after the bot's repository. |

## A bot with no code

Name the servers and say what the bot is for:

```json
{
  "name": "boxbot",
  "about": "You help look after a household inventory kept in Homebox.",
  "servers": {
    "homebox": {
      "command": "homebox-mcp",
      "env": { "HOMEBOX_URL": "${HOMEBOX_URL}", "HOMEBOX_TOKEN": "${HOMEBOX_TOKEN}" }
    }
  },
  "tools": { "read": ["inventory_stats"], "destructive": ["import_csv"] }
}
```

```bash
pnpm exec discordllm chat discordllm.json
```

```bash
pnpm exec discordllm start discordllm.json
```

`${NAME}` is read from the environment at startup, so the file holds no secrets.
Tools are sorted onto `read / write / destructive` by name (`get_`, `list_`, …
are reads; `delete_`, `remove_`, … are destructive; anything else is a write),
and `tools` corrects what the names get wrong. See
[`src/configbot.ts`](src/configbot.ts).

## A bot with code

When a tool's risk depends on its arguments, or the bot needs its own rules,
tools or workspace, it is a `defineBot`:

```ts
// src/bot.ts
import { defineBot, optionalString, classifyByName, sections } from "discordllm";

export default defineBot({
  name: "boxbot",
  tiers: ["read", "write", "destructive"],
  secrets: ["HOMEBOX_TOKEN"],
  env: { HOMEBOX_URL: optionalString, HOMEBOX_TOKEN: optionalString },

  setup({ env }) {
    return {
      // The token goes into the server's environment and nowhere else.
      servers:
        env.HOMEBOX_URL && env.HOMEBOX_TOKEN
          ? { homebox: { type: "stdio", command: "homebox-mcp", env: { HOMEBOX_URL: env.HOMEBOX_URL, HOMEBOX_TOKEN: env.HOMEBOX_TOKEN } } }
          : {},
      classify: classifyByName(["homebox"], { destructive: ["import_csv"] }),
      turn: (info) => ({
        systemPrompt: [
          "## Where you are running\n\nYou look after a household inventory, through Discord.",
          sections.schedules(info),
          sections.polls(info),
          sections.formatting(),
        ].join("\n\n"),
      }),
    };
  },
});
```

```ts
// src/main.ts                       // src/chat.ts
import { main } from "discordllm";   import { chat } from "discordllm";
import bot from "./bot.js";          import bot from "./bot.js";
main(bot);                           chat(bot);
```

What a bot can supply, all optional except `servers` and `turn`
([`src/definition.ts`](src/definition.ts)):

| | |
| --- | --- |
| `servers` | The MCP servers. This is the whole list: nothing in the working directory can add one. |
| `classify` | Sorts a call into a tier. Sees the arguments, so "turn on a light" and "unlock the door" can differ. |
| `policy` | Extra synchronous rules. Can only refuse more than the library already does. |
| `describe` | The one-line summary on an approval card. |
| `phrasebook` | Wording for the live progress message. |
| `turn` | Per turn: the system prompt, extra header lines, and extra tools. |
| `workspace` | Where the agent stands. Default: one directory shared by all threads, with a `CLAUDE.md` the agent keeps as notes. |
| `tools` (from `turn`) | In-process tools for things that need what the agent must not hold, like a token to publish with. |

## What keeps the agent contained

A bot chooses its servers, rules and prompt. It does not choose these, and
[`src/agent/options.test.ts`](src/agent/options.test.ts) pins them:

- **No shell**, unless the bot is defined with `shell: true`. A shell could read
  a server's token out of that server's environment.
- **File tools stay inside the working directory.**
- **`allowedTools` is empty**, so nothing is approved before the approval step
  is asked.
- **Only the bot's own MCP servers** (`strictMcpConfig`), and only project-level
  settings.
- **The agent's environment is a short allowlist.** No Discord token, no
  server's token, no database URL.
- **No subagents and no `WebFetch`.**
- **A scheduled run only looks**: every call above the first tier is refused.

## Another model

Claude, through the Claude Agent SDK, is the default. It is also the only part
of this library that knows which model is behind the bot: everything else
talks to one interface, [`AgentBackend`](src/agent/backend.ts), and a test
([`src/agent/seam.test.ts`](src/agent/seam.test.ts)) fails if a model SDK is
imported anywhere outside a backend's own directory.

```ts
import { defineBot, type AgentBackend } from "discordllm";

const myModel: AgentBackend = {
  name: "my-model",
  secrets: ["MY_MODEL_KEY"],
  ready: (env) => (env.MY_MODEL_KEY ? { ok: true, source: "api-key" } : { ok: false, problem: "set MY_MODEL_KEY" }),
  canResume: async (conversationId, workDir) => false,
  run: async (run, sink) => {
    // run.systemPrompt, run.prompt, run.servers, run.tools, run.builtinTools …
    // Before any tool runs: await run.guard.authorize(name, input, { signal, toolUseId })
    return { ok: true, sessionId: run.sessionId, result: "…", numTurns: 1, costUsd: 0 };
  },
};

export default defineBot({ name: "boxbot", backend: myModel, /* … */ });
```

A backend is handed a complete description of each turn (where to stand, what
to say, which MCP servers and in-process tools exist) and a guard. What it
owes in return is in the header of [`backend.ts`](src/agent/backend.ts); the
part the library's safety rests on is that **every tool call goes through
`run.guard.authorize` before it runs**. That one call is the file confinement,
the bot's own rules, the scheduled-run restriction and the approval card.

Bots, their tools (`tool(...)`), their classifiers and their prompts are
written once and do not change with the backend.
[`test/scripted.ts`](test/scripted.ts) is the smallest complete backend: the
stand-in the session manager's own tests run on.

Only the Claude backend exists today. A backend for another provider has to
bring its own agent loop: connect to the MCP servers, offer whichever of the
built-in file tools it wants under the library's names, and keep its own
record of a conversation so a thread can be resumed.

## Configuration

Everything is environment variables. The common ones:

| Variable | |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | for the default Claude backend: from `claude setup-token`; or `ANTHROPIC_API_KEY` |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` | |
| `DISCORD_CHAT_CHANNEL_IDS` | the bot's own channel(s). Or `DISCORD_CHAT_USER_IDS` / `ROLE_IDS`. One of them is required. |
| `DISCORD_APPROVER_USER_IDS` / `ROLE_IDS` | who may press Approve. Empty means whoever may chat. |
| `DISCORD_PROMPT_USER_IDS` / `ROLE_IDS` | who may ask for the prompt. Empty means whoever may approve. |
| `PROMPT_INSPECTION` | `false` turns the `prompt` command off in Discord. Default `true`. |
| `APPROVAL_LEVEL` | the lowest tier that waits, or `none`. Default: only the top tier. |
| `BOT_TIMEZONE` | IANA zone for schedules and the date the agent is told |
| `DATA_DIR`, `HOME` | both on persistent storage |
| `AGENT_TURNS_PER_HOUR`, `AGENT_MAX_CONCURRENT_RUNS` | the quota guard |

The full list, with why each exists, is [`src/config.ts`](src/config.ts).

### Seeing what the agent is told

When a bot does not behave as you want, look at what it was given. The bot
builds this itself, from the same code that builds a real turn; it is not the
model describing its instructions.

- **In Discord:** mention the bot with `prompt`, or say `prompt` in one of its
  threads. It replies with `prompt.md`: the system prompt, the header that
  opens every message, the servers and tools, and the approval level. In a
  thread it adds the last turn as it was actually sent, and that turn's system
  prompt if it has changed since.
- **In the REPL:** `/prompt`.
- **Without a model credential:** `pnpm chat --prompt` (a bot with code) or
  `pnpm exec discordllm prompt discordllm.json` prints it and exits, so you can
  edit a prompt section and see the result. Add `--brief` for what a scheduled
  run is told.

Every turn's system prompt is also kept in the ledger: `turns.system_prompt_hash`
names a row in `system_prompts`, stored once per distinct text.

Two things are not shown, because the library does not have them: the
backend's own base prompt that yours is added to, and the tools each MCP
server offers.

### The database

The ledger is a SQLite file under `DATA_DIR` by default. To use Postgres, set
`DATABASE_URL` to a `postgres://` URL and add the `pg` package to the bot's
dependencies. `DATABASE_SCHEMA` gives the bot a schema of its own, so several
bots can share one database.

`DATA_DIR` has to persist either way: the SDK's transcripts and the agent's
working directory live there, not in the database.

### Profiles

```bash
BOT_PROFILES=sam,alex
PROFILE_SAM_DISCORD_CHAT_CHANNEL_IDS=…   PROFILE_ALEX_DISCORD_CHAT_CHANNEL_IDS=…
PROFILE_SAM_HOMEBOX_TOKEN=…              PROFILE_ALEX_HOMEBOX_TOKEN=…
```

A plain variable is the default for every profile; `PROFILE_<NAME>_<VARIABLE>`
overrides it for one. That applies to the bot's own variables too. The channel
a message arrives in decides whose it is. Mind it with secrets: a plain
`HOMEBOX_TOKEN` would be every profile's token.

## Building a bot's image

From the bot's repository:

```bash
pnpm exec discordllm-build
```

```bash
pnpm exec discordllm-build --push
```

```bash
pnpm exec discordllm-build --print
```

The image is `ghcr.io/<owner>/<repo>`, taken from the bot's `origin` remote (or
`GITHUB_REPOSITORY` in CI). The Dockerfile is this repository's
([`docker/Dockerfile`](docker/Dockerfile)); a bot only says what it bakes in, in
its `package.json`:

```json
"discordllm": {
  "uvTools": ["homebox-mcp==1.5.1"],
  "aptPackages": ["git"],
  "smoke": "python -c 'import homebox_mcp'"
}
```

A bot's CI is one job:

```yaml
jobs:
  bot:
    uses: adepssimius/discordLLM/.github/workflows/bot.yml@main
    permissions:
      contents: read
      packages: write
```

It typechecks, tests and builds, then on a push publishes the image.

## Developing this library

```bash
pnpm install
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

The store tests run on SQLite and on Postgres. Postgres is PGlite, in-process,
through the real `pg` driver; set `TEST_DATABASE_URL` to run them against a
server instead.

Bots depend on a packed tarball (`pnpm pack`), which CI attaches to a GitHub
release on every `v*` tag.
