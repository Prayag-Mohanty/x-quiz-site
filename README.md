# Quizmaster

An online quiz platform for **finals-format quizzing** — one application replacing the
current stack of Meet + slides + Google Forms + WhatsApp + Google Sheets. 

## The problem

Online competitive quizzing today spans four platforms. Questions are screenshared from
slides, answers arrive via Google Forms, pounces come as private WhatsApp messages, scores
live in a spreadsheet, and teammates in different cities coordinate over a separate call.
The QM needs a team of volunteers just to keep track. This collapses all of it into one
screen. This is my take on streamlining pounces online.

The product solves coordination.This does **not** solve cheating/googling.
## Start here

| Document | What it covers |
|---|---|
| `CLAUDE.md` | Project context and architecture invariants. Read first. |
| `docs/FORMAT_SPEC.md` | **Normative** quiz rules. Code that disagrees is a bug. |
| `docs/DECISIONS.md` | Stack and architecture choices, pre-made. What's still open. |
| `docs/GLOSSARY.md` | Web/database terms explained for a hardware person. |
| `docs/ARCHITECTURE.md` | Data model, media pipeline, QM console, stack rationale. |
| `docs/DATA_MODEL.md` | How the engine's types map onto the Postgres schema. |
| `docs/BUILD_ORDER.md` | Phased plan with what "done" means per phase. |

---

## Running it

You need PostgreSQL 14+ and Node 22+. Create a database, apply the migrations in order,
then start the two processes.

```
psql -d quizmaster -v ON_ERROR_STOP=1 -f packages/db/migrations/001_content.sql
psql -d quizmaster -v ON_ERROR_STOP=1 -f packages/db/migrations/002_runtime.sql
psql -d quizmaster -v ON_ERROR_STOP=1 -f packages/db/migrations/003_sessions.sql
psql -d quizmaster -v ON_ERROR_STOP=1 -f packages/db/migrations/004_credential_defaults.sql
```

Put a `DATABASE_URL` in `packages/server/.env`, then, in two terminals. One command per
line — Windows PowerShell 5.1 has no `&&`, and this is a Windows project:

```
cd packages/server
npm install
npm run build
npm start
```

```
cd packages/client
npm install
npm run dev
```

Open <http://localhost:5173> — `localhost`, not `127.0.0.1`, since Vite binds the IPv6
name. On Windows PowerShell use `npm.cmd` rather than `npm`; `packages/client/README.md`
explains that and the other shell papercuts.
`packages/db/README.md` has a recipe for a disposable Postgres if you would rather not
install a permanent one.

### The four screens

| URL | Who it is for |
|---|---|
| `/` | Authoring. Write the quiz: teams, rounds, questions, parts, answers. |
| `/qm` | The quizmaster console. Drives the live quiz. |
| `/play` | The team client. Teams join with a short code. |
| `/scoreboard?quiz=…` | Read-only scoreboard, safe to project or share. |

The authoring screen has a **Run this quiz** panel with your console link, the scoreboard
link, and one join code per team.

---

## Packages

### `packages/engine` — the state machine

Pure: no I/O, no clock, no randomness, no dependencies. Every transition is a function of
the previous state and one explicit QM action. `npm test` runs 47 tests covering every rule
in `FORMAT_SPEC`.

### `packages/db` — schema and mapping

Raw SQL migrations, row types, and the translation between database rows and the engine's
types. No `pg` and no queries — it is the schema and the mapping, nothing else. 31 SQL
assertions run against a real Postgres, plus 21 mapping tests.

### `packages/shared` — the wire protocol

Types only. Client-to-server messages mirror the engine's `Action` type rather than
inventing a second vocabulary for the network.

### `packages/server` — Fastify, Postgres, WebSockets

The authoring API, the live room, and the socket layer. One quiz in flight is one room
holding one `QuizState` in memory; Postgres is durability, not the live store. 42 tests,
against a real database and real sockets.

### `packages/client` — Vite + React

All four screens in one bundle. The server is the source of truth; the client is a render
cache.

---

## Three ideas that shape the code

**The QM drives the state machine; timers never mutate state.** Every transition is an
explicit quizmaster action. The format has human judgment embedded in it — partial credit,
when to reveal, whether an answer is close enough — and automating those produces a worse
quiz than a spreadsheet. Timers may render a countdown; a timer callback that dispatches an
action is a bug.

**Scores are an append-only ledger, not an integer.** Partial credit must be *recorded but
unpublished* until the answer reveal, otherwise later teams could infer a confirmed part
from a visible score change. `PENDING → APPLIED` does exactly that, and gives undo,
post-quiz breakdowns, and tiebreak stats for free. The database enforces this with a
trigger: ledger rows cannot be deleted or edited, only voided.

**Nobody receives the quiz state.** The server holds one `QuizState` and sends each client
a projection built for its role. That is not a rendering convenience — a team can open dev
tools and read whatever their browser received, so anything they must not know is never
sent. The answer is absent until the reveal, a team gets its own pounce text and never
another's, and withheld partials never cross the wire to a team at all.

---

## Status

**Phase 0 is complete** apart from media upload. You can author a quiz — teams, rounds,
questions, multi-part answers, per-part point splits — and it is stored.

**Phase 1 is built and tested, but has not yet run a real quiz.** That is the phase's own
definition of done, and it is the honest gap: no test tells you whether the console is
usable while you are talking to ten people.

What works end to end, verified against a real database and real sockets:

- Teams join with a short code; several people share one team identity
- The QM console drives the whole question lifecycle, keyboard first
- Written-blind pounces — the QM sees who has pounced, not what, until the window closes
- Partial credit recorded when it happens and published at the reveal, invisible to teams
  until then
- Infinite bounce with the order always on screen, and correct direct-team advancement
- Undo, live scoreboard, and reconnection into the exact current state
- Moving between rounds and questions without replaying, which cannot interrupt a
  question in play and never rewinds the ledger
- Five clients connecting and acting simultaneously, all converging on the same state

### Not built yet

- **Media upload.** Image and audio questions cannot be shown. Last Phase 0 item.
- **Written and visual-connect round UIs.** The engine supports both; the screens are
  Phase 4.
- **Native video.** Phase 1 deliberately leaves video on an embedded Meet link, so that if
  the app breaks you still have Meet and if Meet breaks you still have the app.
- **Deployment.** Runs on localhost. Deliberately deferred until Phase 1 is proven.

### Test suites

```
cd packages/engine && npm test    # 47 — the state machine
cd packages/db     && npm test    # 21 — row-to-domain mapping
cd packages/server && npm test    # 42 — API, projections, sockets, concurrency
psql -d quizmaster -f packages/db/test/smoke.sql   # 31 — the schema enforces FORMAT_SPEC
```
