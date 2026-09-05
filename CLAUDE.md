# Quizmaster — Project Context

Online quiz platform for **finals-format quizzing**. Replaces the current mess of
Meet + slides + Google Forms + WhatsApp + Google Sheets with one application.

**Read `docs/FORMAT_SPEC.md` before touching scoring, rounds, or state transitions.**
It is the normative spec. Code that disagrees with it is a bug.

**Read `docs/DECISIONS.md` before asking the author to choose anything.** Stack, libraries
and architecture are already decided there. Only the items marked **AUTHOR** are open, and
those should be raised one at a time, in plain language, with a recommendation.

---

## The one rule that shapes everything

> **The QM drives the state machine. Timers never mutate state.**

Every transition is caused by an explicit quizmaster action. Timers render countdowns and
may fire visual nudges, but a timer callback must **never** dispatch an action that changes
quiz state. This is enforced structurally, not by convention. If you find yourself writing
`setTimeout(() => dispatch(...))` against quiz state, stop — it is wrong.

Why: the format has human judgment embedded in it (partial credit, when to reveal, how long
to leave a pounce window open, whether an answer is close enough). Automating these produces
a worse quiz than a spreadsheet.

---

## Architecture invariants

These are decided. Do not relitigate them without discussion.

1. **Server-authoritative.** All state transitions go through the server. Clients render
   state and send intents. A client never computes a score.

2. **Scores are an append-only ledger, never a mutable integer.**
   `score = SUM(points) WHERE status = 'APPLIED'`.
   This exists because partial credit must be *recorded but unpublished* until reveal
   (`PENDING` → `APPLIED`). It also gives undo (`VOIDED`), the post-quiz breakdown, and
   tiebreak stats for free. Never add a `team.score` column.

3. **The state machine is a pure reducer.** No I/O, no dates, no randomness. Fully unit
   tested. It is the part where bugs are visible to ten people at once and unfixable in
   the moment — over-engineer it deliberately.

4. **Question media is preloaded to clients and played locally on a QM cue.** Never
   streamed over the video call — screensharing video through WebRTC degrades badly and
   the audio is worse.

5. **A team is one identity shared by up to 3 people in different locations.** Answer
   drafting is collaborative with typing indicators; any member may submit.

---

## Repo layout

```
docs/FORMAT_SPEC.md      Normative quiz rules. Source of truth.
docs/DECISIONS.md        Stack and architecture decisions, already made. Read before asking.
docs/ARCHITECTURE.md     Full design: data model, media pipeline, console layout, build order.
docs/BUILD_ORDER.md      Phased plan with what "done" means per phase.
docs/DATA_MODEL.md       How the engine's types map onto the Postgres schema.
docs/GLOSSARY.md         Web terms explained for the author. You don't need it; he does.
packages/engine/         Pure state machine + scoring. No I/O. Start here.
packages/db/             Postgres schema, row types, row↔domain mapping. No queries.
packages/shared/         Wire protocol between server and client. Types only.
packages/server/         Fastify + ws. Authoring API, live rooms, role projections.
packages/client/         Vite + React. Authoring, QM console, team client, scoreboard.
```

---

## Current state

**Phase 1 is built and tested, but has not yet run a real quiz** — which is the phase's own
definition of done. Authoring, the QM console, the team client and the scoreboard all work
end to end against a real database and real sockets.

Tests, all passing: engine 54, db mapping 21, server 59, schema 33 SQL assertions.

Two things to know before changing anything:

- `packages/db` is **raw SQL, not Drizzle**, by explicit decision. It predates
  `docs/DECISIONS.md` and porting it was judged not worth the churn, so the server's query
  layer matches it. This is the one place the code knowingly diverges from that document.
- The server sends each client a **role projection**, never the `QuizState`. See
  `packages/server/src/views.ts` — the comment there is the rule, and the tests assert
  against the serialised bytes rather than object properties.

All three round types now have a console and a team screen: DIRECT (§2.1), WRITTEN
(§2.2) and VISUAL_CONNECT (§2.3). Media upload is done.

Not built: native video (Phase 3), and everything in Phase 5. See
`docs/BUILD_ORDER.md`.

---

## Conventions

- TypeScript throughout, `strict: true`. No `any` in the engine.
- The engine has **zero dependencies**. Keep it that way — it should be trivially testable
  and portable.
- Tests use `node:test` and `node:assert`. No test framework dependency.
- Every rule in `FORMAT_SPEC.md` should have a named test that references it.
- Exhaustive `switch` on discriminated unions with a `never` check in the default branch.

---

## Working with the author

- Prayag is the quizmaster whose format this implements. He is a hardware/architecture
  person (M.Tech, IIT Bombay) — comfortable with systems reasoning, less deep in web stacks.
  Explain web-specific choices; don't explain state machines or concurrency.
- **Do not ask him to pick between libraries or tools.** Those calls are made in
  `docs/DECISIONS.md`. If something genuinely isn't covered there, pick the boring option,
  state what you picked in one sentence, and continue. Decide first, mention it after —
  a question that stops the work is more expensive than a choice he'd have made differently.
- When a term is unavoidable, define it inline in half a sentence. `docs/GLOSSARY.md` has
  the fuller version; add to it when you introduce a genuinely new concept.
- He wants honest, direct assessment over reassurance. If an approach is wrong, say so.
- He wants to understand his own system, not just receive generated code. Prefer explaining
  the design decision alongside the implementation.
- Open questions in `FORMAT_SPEC.md` §5 are genuinely open. Ask rather than assume, and
  update the spec when they're answered.
