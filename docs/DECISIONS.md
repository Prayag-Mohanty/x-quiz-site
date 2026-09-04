# Technical Decisions

**Purpose:** these choices are already made. Claude Code should implement against them
rather than asking the author to choose. Where a decision is genuinely the author's to
make (a product question, not an engineering one), it is marked **AUTHOR** and should be
raised — but raised as a plain-language question with a recommendation, never as a menu
of unexplained options.

The author is a hardware/computer-architecture person. He reasons fluently about state
machines, concurrency, memory hierarchies and pipelines. He has not built production web
applications. **Explain web-stack tradeoffs; do not explain systems concepts.**

---

## How to raise a question with the author

If something genuinely needs his input:

1. State the decision in plain language, no jargon, one sentence.
2. Give the two realistic options and what each costs him *later* — not what they are.
3. Recommend one and say why.
4. Proceed with the recommendation if he doesn't have a preference.

Bad: *"Should I use Prisma or Drizzle for the ORM layer?"*
Good: *"Two ways to talk to the database. Prisma generates the query code for you and is
easier to read; Drizzle is closer to raw SQL and faster at runtime. For a project this size
the difference won't matter — I'd use Prisma so the schema file stays readable. Fine?"*

---

## Stack — decided, do not relitigate

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript, `strict: true` | Non-negotiable. The whole point of the engine is compile-time safety on state transitions. |
| Runtime | Node 22 LTS | Already what the engine is built and tested against. |
| Package manager | **pnpm** | Workspaces work properly; disk-efficient. `npm` is acceptable if pnpm causes friction. |
| Monorepo | pnpm workspaces, no Turborepo | Three packages does not justify a build orchestrator. Add one only if builds get slow. |
| Server | **Fastify** | Faster than Express, first-class TypeScript, good WebSocket plugin. |
| WebSocket | **`ws`** via `@fastify/websocket`, not Socket.IO | Socket.IO's reconnection and room abstractions fight the server-authoritative model. We hand-roll reconnection because we need exact snapshot-then-delta semantics. |
| Database | **Postgres 16** | The ledger is relational and will be queried with SQL. |
| Local Postgres | **Docker Compose** | One `docker compose up`. Do not ask the author to install Postgres natively. |
| DB access | **Drizzle ORM** | Schema-as-TypeScript, generates migrations, thin enough that the ledger queries stay legible as SQL. |
| Migrations | `drizzle-kit` | Checked into the repo. Never edit a migration that has been applied. |
| Frontend | **Vite + React 18 + TypeScript** | Not Next.js — there is no SSR, no SEO, no routing complexity worth the framework. This is a single-page real-time app. |
| Client state | **Zustand** | Small. The server is the source of truth; client state is a render cache. |
| Styling | **Tailwind** | The QM console is information-dense and needs fast iteration on layout. |
| Tests (engine) | `node:test` + `node:assert` | Already in use. Zero dependencies. Keep it. |
| Tests (server/client) | **Vitest** | Same config as Vite; use for anything the engine's zero-dep rule doesn't cover. |
| IDs | **nanoid** | Short, URL-safe. Needed for join codes anyway. |
| Video (Phase 3) | **LiveKit Cloud** first | Self-host only if cost becomes a problem. Do not build raw WebRTC signalling. |
| Object storage (Phase 2) | **Cloudflare R2** | No egress fees. Ten clients preloading video makes egress the dominant cost on S3. |
| Deployment | **Deferred** | Runs on localhost until Phase 1 is proven. Do not set up CI/CD or hosting yet. |

---

## Repo layout — decided

```
packages/
  engine/     pure state machine + ledger. Zero deps. Already built.
  server/     Fastify + ws. Wraps the engine. Owns Postgres.
  client/     Vite + React. QM console, team client, scoreboard.
  shared/     types shared between server and client (wire protocol).
```

`engine` must never import from `server`, `client`, or `shared`. It stays portable and
trivially testable. If you find yourself wanting to import Postgres types into the engine,
the design has gone wrong.

---

## Architecture decisions the author should not be asked about

**Server-authoritative state.** Clients send intents, never state. The server runs the
reducer and broadcasts the result. A client never computes a score. This is already
decided and is the reason the engine is pure.

**One room, one in-memory state object, Postgres for durability.** Ten teams fit in memory
trivially. Do not introduce Redis. Persist the ledger and the current phase after every
action so a server restart can recover; do not try to make the room state itself
distributed.

**Reconnection: full snapshot on connect, deltas after.** Every client that connects
receives the complete current state, then incremental updates. Do not attempt event
replay on the client. This must work from day one — it is the most likely live failure.

**Timers are display-only.** A timer may render a countdown and play a sound. A timer must
never dispatch an action. If you are writing `setTimeout(() => dispatch(...))` against quiz
state, stop — see CLAUDE.md.

**The wire protocol mirrors the engine's `Action` type.** Do not invent a second vocabulary
for the network layer. Client → server messages are `Action`s plus an auth envelope;
server → client messages are state snapshots and deltas.

**Auth is join-codes, not accounts.** No passwords, no email verification, no OAuth. The QM
creates a quiz and gets a QM link; each team gets a short join code. A team member enters
the code and a display name. Sessions are cookie-backed so a refresh does not eject you.
This is a quiz for people the QM already knows — account infrastructure is pure cost.

---

## Open — genuinely the author's call (**AUTHOR**)

These are product decisions. Ask them one at a time, in plain language, when the relevant
phase is reached. Do not ask them all up front.

1. **Can a team that pounced wrong still answer on bounce?**
   `RuleOptions.wrongPouncerMayBounce` exists and defaults to `true`, but the reducer does
   not yet read it. Wire it up once he confirms. *(FORMAT_SPEC §5.1)*

2. **Can a team stake more than one written-round answer?** Defaults to yes. *(§5.2)*

3. **Does a long visual connect bounce after the fourth reveal, or die?** Defaults to dying.
   *(§5.4)*

4. **How does a team member join — one code per team, or one per person?** One per team is
   simpler; one per person lets you show who is present. Recommend one per team, with the
   person typing their own name.

5. **What happens if a team's three members disagree about the answer mid-pounce?** The
   current design is a shared draft that anyone may submit. An alternative is a nominated
   captain who alone can submit. Recommend shared draft — it is closer to how a team in a
   room actually behaves.

6. ~~**Should teams see the live scoreboard during the quiz, or only the QM?**~~
   **ANSWERED (2026-09-05): teams see it live.** The team client carries a live
   scoreboard alongside the question. Note this is the *public* score — `APPLIED`
   events only — so a withheld partial stays invisible until the reveal, exactly as
   FORMAT_SPEC §2.1 requires. The QM's own view shows the provisional score including
   withheld partials.

---

## Anti-goals — do not build these

- **Anti-cheat, proctoring, tab-focus detection, keystroke analysis.** Not solvable in a
  browser. The participant has a phone. If asked to add it, push back and explain why.
- **A generic rules engine for other quiz formats.** This implements one format precisely.
  Generalising later is a known, bounded refactor; generalising now produces something that
  handles every format badly.
- **Prelims / 100+ participant scale.** Different product. Deferred deliberately.
- **User accounts, teams-across-quizzes, organisations, billing.** Not now.
- **Mobile-native apps.** The web client should be usable on a tablet; that is the extent.
