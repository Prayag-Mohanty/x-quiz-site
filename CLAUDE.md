# Quizmaster — Project Context

Online quiz platform for **finals-format quizzing**. Replaces the current mess of
Meet + slides + Google Forms + WhatsApp + Google Sheets with one application.

**Read `docs/FORMAT_SPEC.md` before touching scoring, rounds, or state transitions.**
It is the normative spec. Code that disagrees with it is a bug.

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
docs/ARCHITECTURE.md     Full design: data model, media pipeline, console layout, build order.
docs/BUILD_ORDER.md      Phased plan with what "done" means per phase.
packages/engine/         Pure state machine + scoring. No I/O. Start here.
```

---

## Current state

Phase 0. The engine package (`packages/engine`) contains the reducer and its test suite.
Nothing else is built yet. See `docs/BUILD_ORDER.md` for what comes next.

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
- He wants honest, direct assessment over reassurance. If an approach is wrong, say so.
- He wants to understand his own system, not just receive generated code. Prefer explaining
  the design decision alongside the implementation.
- Open questions in `FORMAT_SPEC.md` §5 are genuinely open. Ask rather than assume, and
  update the spec when they're answered.
