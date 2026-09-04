# Glossary

For the author, not for Claude Code. These are the terms that will come up while building
this, explained assuming you know computer architecture but not web development.

Analogies to architecture are marked ⟶. They are honest but approximate — don't push them
too far.

---

## Project plumbing

**Package manager** (`npm`, `pnpm`, `yarn`) — downloads and version-locks the libraries your
project depends on. ⟶ a package manager for a Linux distro, but scoped to one project
directory. We use `pnpm`.

**`package.json`** — the manifest: project name, dependencies, and named scripts
(`pnpm test` runs whatever `"test"` maps to).

**Lockfile** (`pnpm-lock.yaml`) — records the exact resolved version of every transitive
dependency, so your machine and any other machine build identically. Commit it. Never edit
it by hand.

**Monorepo** — several related packages in one git repository, able to import each other
without publishing. Ours has `engine`, `server`, `client`, `shared`.

**Workspace** — one package inside a monorepo.

**Transpile / build** — TypeScript can't run directly; it is compiled to JavaScript first.
⟶ compilation, but with no optimisation and no machine code; it's a source-to-source
translation that mainly erases the type annotations.

**Bundler** (Vite) — takes hundreds of source files and produces the handful of files a
browser actually loads. Also runs the dev server with hot reload.

**Hot reload / HMR** — you save a file, the browser updates in under a second without
losing page state. This is why frontend iteration is fast.

---

## TypeScript

**Type** — a compile-time constraint. Erased entirely at runtime; it buys you correctness
checking and editor autocomplete, and costs nothing in the running program.

**`strict: true`** — turns on all the compiler's safety checks. Notably it forbids implicit
`any` and forces you to handle `null`. We use it everywhere. ⟶ compiling with
`-Wall -Werror`.

**`any`** — the escape hatch type that disables checking. Banned in the engine.

**Discriminated union** — a type that is "one of these shapes, distinguished by a tag
field". `QuestionState` is one: `kind: 'DIRECT' | 'VISUAL_CONNECT' | 'WRITTEN'`. The
compiler then forces you to handle every case in a `switch`. ⟶ a tagged union in C, but
the compiler actually checks exhaustiveness.

**Generic** — a type parameterised by another type. `Array<Team>` is an array specialised
to hold `Team`s. ⟶ C++ templates, minus the code generation.

---

## The state machine (already built)

**Reducer** — a pure function `(state, action) → newState`. It never mutates its input; it
returns a fresh state. Ours is `reduce()` in `packages/engine/src/reducer.ts`.
⟶ the next-state logic of a synchronous FSM. Same idea, written as a function.

**Pure function** — same inputs always produce the same output, and it touches nothing
outside itself: no I/O, no clock, no randomness, no globals. This is why event IDs are
passed *into* the reducer rather than generated inside it. Purity is what makes it
exhaustively testable.

**Immutability** — instead of `state.score += 10`, you build a new state object. Sounds
wasteful; isn't, at this scale. It makes undo, time-travel debugging, and "what changed?"
comparisons trivial.

**Action** — a plain object describing an intent: `{ type: 'BOUNCE_CORRECT', eventId: 'e7' }`.
Every state change in the system is one of these. ⟶ an instruction in an ISA: a small fixed
vocabulary of operations, each fully specifying its operands.

**Append-only ledger** — we never overwrite a team's score; we append events and compute the
total by summing them. ⟶ a write-ahead log, or a journal filesystem. You keep the history
and derive the current value, rather than storing the current value and losing the history.

---

## Server and network

**Client / server** — the client is code running in someone's browser; the server is code
running on a machine you control. The client is untrusted: anyone can open dev tools and
modify it. This is why the server computes all scores.

**Server-authoritative** — the server holds the real state; clients only display it and send
requests. ⟶ exactly the reason a cache can't be the source of truth. Same discipline.

**HTTP request/response** — the browser asks, the server answers, the connection closes.
Fine for loading a page; useless for "tell every team the pounce window just closed."

**WebSocket** — a connection that stays open, over which either side can send messages at
any time. This is how live quiz state reaches ten browsers at once. ⟶ closer to an
interrupt line than to polling a status register.

**Fastify** — the library that handles incoming HTTP and WebSocket connections and routes
them to your code.

**Snapshot and delta** — on connect, a client gets the entire current state (snapshot);
afterwards it gets only what changed (deltas). Keeps bandwidth low while making
reconnection correct. ⟶ a full checkpoint plus an incremental log.

**Reconnection** — a laptop's wifi drops for four seconds mid-pounce. The client must come
back and be *exactly* in sync. This is the hardest correctness problem in Phase 1, and the
one most likely to break during a real quiz.

**SFU** (Selective Forwarding Unit) — the server that routes video/audio between
participants. Without one, ten people each send nine streams (~90 streams); with one,
everyone sends one stream to the SFU and receives what they need. LiveKit is an SFU.

**WebRTC** — the browser standard for peer-to-peer audio and video. Notoriously fiddly.
We use LiveKit so we don't touch it directly.

---

## Database

**Postgres** — the relational database. Stores the ledger, quizzes, questions, teams.

**Schema** — the table and column definitions. ⟶ struct definitions, but for tables.

**Migration** — a versioned, checked-in script that changes the schema (`add column
'staked' to written_answers`). You accumulate them in order so any machine can rebuild the
database from scratch. **Never edit a migration that has already been applied** — write a
new one that corrects it.

**ORM** (Object-Relational Mapper) — a library that lets you query the database in
TypeScript instead of writing SQL strings, and type-checks the results. We use Drizzle.

**Seed data** — fake but realistic data for development, so you're not creating a quiz by
hand every time you restart. Ask for this early; it saves hours.

**Transaction** — a group of writes that either all land or none do. ⟶ atomicity, same
meaning as everywhere else.

---

## Frontend

**React** — the library for building UI. You write functions that return a description of
what the screen should look like given the current state; React works out the minimal set
of DOM changes to get there. ⟶ declaring the desired output and letting a tool derive the
transitions, rather than hand-writing every update.

**Component** — one reusable piece of UI (`<Scoreboard />`, `<PouncePanel />`). A function.

**Props** — the arguments passed into a component. Read-only.

**State (client-side)** — data a component holds that can change and triggers a re-render
when it does. Careful: distinct from *quiz* state, which lives on the server.

**Hook** (`useState`, `useEffect`) — React's mechanism for state and side effects inside a
function component. `useEffect` runs code after render — e.g. opening a WebSocket.

**Zustand** — a small library for state shared across many components, so you're not
threading props through ten layers.

**Tailwind** — styling written as class names in the markup (`class="flex gap-4 text-sm"`)
instead of a separate CSS file. Fast to iterate on; looks cluttered at first.

**DOM** — the browser's live tree of page elements. React manipulates it for you.

---

## Environment and tooling

**Docker** — runs software in an isolated container so you don't install it on your machine.
We use it for Postgres. `docker compose up` starts it; `docker compose down` stops it.

**Environment variable** — configuration passed in from outside the code (database URL, API
keys). Stored in a `.env` file locally. **`.env` is gitignored and must never be committed** —
that's how people leak credentials.

**`localhost`** — your own machine, addressed over the network. `localhost:5173` is the dev
server. Only you can reach it.

**Port** — the number after the colon. Different services, different ports.

**CORS** — a browser rule about which origins may call which servers. It will bite you once
when the client on port 5173 first calls the server on port 3000. It's a config line, not a
real problem.

---

## Git

**Commit** — a snapshot of the repo with a message. Commit often; small commits are easier
to undo.

**Branch** — a parallel line of work. Solo, you can mostly stay on `main`. Branch when
attempting something you might abandon.

**PR** (Pull Request) — a proposed merge of one branch into another, with a place to review
it. Solo, useful mainly for getting automated review before merging.

**`.gitignore`** — files git should never track: `node_modules/`, build output, `.env`.

**Remote / push** — GitHub is the remote copy; pushing uploads your commits. Also your backup.
