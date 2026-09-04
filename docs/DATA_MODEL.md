# Data Model

How `packages/engine/src/types.ts` maps onto the Postgres schema in
`packages/db/migrations/`. The engine's types are the reference: the schema
serves them, not the other way round.

`FORMAT_SPEC.md` remains normative for rules. This document is normative only for
the *mapping* — if a table and a type disagree, the type wins.

---

## 1. The split

**`001_content.sql` — authoring.** Everything the QM writes before the quiz:
rounds, questions, parts, media, teams, scoring configuration. This is all Phase 0
needs.

**`002_runtime.sql` — the quiz being played.** The score ledger, the QM action
log, submissions. Nothing in Phase 0 writes to it. It exists now because the
ledger is the one structure that cannot be retrofitted: converting a mutable
`score` integer into an append-only ledger after the fact means replaying quizzes
you no longer have the data for.

---

## 2. Type-to-table map

| `types.ts` | Table | Notes |
|---|---|---|
| `DirectScoring` | `quiz.direct_*` | Columns, not JSONB |
| `WrittenScoring` | `quiz.written_*` | Columns, not JSONB |
| `RuleOptions` | `quiz.rule_*` | The three `FORMAT_SPEC` §5 toggles |
| `ConnectStage[]` | `connect_stage` | Ordered rows — variable length |
| `Team` | `team` + `team_member` | `members: string[]` becomes rows |
| `Round` | `round` | |
| `Question` | `question` | |
| `QuestionPart` | `question_part` | |
| `Media` | `media_asset` + `question_media` | Asset vs. its use in a question |
| `Question.media` | `question_media role='PROMPT'` | |
| `Question.answerMedia` | `question_media role='ANSWER'` | |
| `Question.revealSequence` | `question_media role='REVEAL'` | `VISUAL_CONNECT` only |
| `ScoreEvent` | `score_event` | |
| `PounceSubmission` | `pounce_submission` | |
| `WrittenAnswer` | `written_answer` | |
| `Action` | `quiz_action` | The QM intent log |
| `QuizState` | `quiz_snapshot` | Periodic; the log is the truth |
| `DirectQuestionState` etc. | *not persisted directly* | Rebuilt by replay — see §5 |
| `Standing` | `team_standing` view | Mirrors `scoring.ts` |

### Naming

snake_case in SQL, camelCase in the engine. Mechanical except for one rename:

- `Question.text` → `question.body`. `question.text` in a query reads like a cast
  to the `text` type. `Question.answerText` → `question.answer_text` unchanged.

### Ordering

The engine indexes into arrays, and `rotation.ts` does arithmetic on those
indices. Postgres rows have no inherent order, so every array becomes a table
with an explicit **0-based** `position` column, unique per parent.

`team.position` is the one that matters most: it is the seating order around the
notional circle, and CW/ACW rotation, bounce order and next-direct advancement
are all defined on it. Reordering teams changes how the quiz plays. Format for
display at the edge; never renumber to 1-based in the database.

Position uniques are `DEFERRABLE INITIALLY DEFERRED` so the authoring UI can
reorder inside one transaction without shuffling rows through a temporary offset.
The cost: `ON CONFLICT` cannot target a deferrable unique constraint, so upserts
must key on the primary key or a non-deferrable unique.

---

## 3. Decisions worth knowing about

**Scoring config is columns, not a JSONB blob.** A blob accepts
`{pounceCorect: 10}` without complaint and you find out during a quiz. Columns
get `CHECK` constraints (penalties can't be positive, question value can't be
zero) and a shape change forces a migration, which is where you want to be
thinking about it.

**Composite foreign keys keep denormalised copies honest.** `question.round_type`
is a copy of `round.type`, and `question_media.kind` is a copy of
`media_asset.kind`. Each is bound by a two-column FK to a two-column unique key on
the source, so Postgres will not let the copy drift, and `ON UPDATE CASCADE`
propagates a change downward.

They pay for themselves twice:

- `CHECK (role <> 'REVEAL' OR round_type = 'VISUAL_CONNECT')` — staged reveals can
  only exist on a connect question. No trigger, no join, no application check.
- `CREATE UNIQUE INDEX ... ON question_media (question_id, role) WHERE kind = 'VIDEO'`
  — `FORMAT_SPEC` §4's one-video rule, enforced by the database.

Side effect worth expecting: changing a round's type while its questions still
have reveal images fails. That is the correct behaviour — it fails at the moment
you do it rather than at the moment you run the quiz.

**Row-spanning rules are a view, not constraints.** "2–12 teams", "a written round
has four questions", "every question has at least one part" are counts across
rows. As constraints they would need a trigger on every write, and they would
reject the perfectly normal half-finished state of a quiz at 11pm. They live in
the `quiz_authoring_issue` view instead, which the authoring UI queries to answer
*can this quiz be run?* — `ERROR` blocks, `WARN` doesn't.

**The ledger is append-only in the database, not by convention.** A trigger
rejects `DELETE` and `TRUNCATE`, and permits `UPDATE` only on `status` (along the
legal transitions `PENDING → APPLIED`, `PENDING|APPLIED → VOIDED`) and `note`.
Points, reason, team and question are immutable. To correct an award you void it
and append a new one, which is what `VOID_EVENT` already does.

There is no `team.score` column, and `team_score` / `team_standing` /
`team_breakdown` are views computing exactly what `scoring.ts` computes. If a view
and `scoring.ts` ever disagree, `scoring.ts` wins.

**A played quiz cannot be deleted.** `score_event` references teams, rounds and
questions with `ON DELETE RESTRICT`, so the cascade from `quiz` is blocked once
anything has been scored. Archive it (`quiz.status = 'ARCHIVED'`). Deleting an
unplayed draft cascades cleanly.

**Media URLs are not stored.** `media_asset.storage_key` is the truth; the engine's
required `Media.url` is minted as a signed URL when the server builds the
`Question`. A signed URL stored in a column gives you a quiz that works in
rehearsal and 403s on the night.

---

## 4. Discrepancies between the engine, ARCHITECTURE.md and the schema

These are referenced by number from comments in the SQL. Each needs a decision;
none blocks the authoring UI.

**1. Per-round scoring configuration.** `ARCHITECTURE` §2 gives `Round` a
`config { pounce_points, bounce_points, ... }`. The engine puts scoring on
`QuizState` instead. The schema follows the engine — quiz-level columns. If a
round ever needs its own values (a double-points final round), it becomes a
nullable override on `round` and a `COALESCE` in the mapper.

**2. `Round.starting_team_idx`.** `ARCHITECTURE` §2 has it; the engine does not —
`QuizState.nextDirectTeamIdx` is quiz-level and `START_ROUND` doesn't touch it.
So starting Round 2 with a specific team is currently unexpressible: rotation
carries over from wherever Round 1 ended. `round.starting_team_position` is in the
schema because quiz setup needs to record the intent, but **nothing reads it yet**.
Either `START_ROUND` should take it and set `nextDirectTeamIdx`, or the column
should go. This one is a real gap in Phase 1, not just a mapping wrinkle.

**3. `QuestionPart.accepted_variants`.** In `ARCHITECTURE` §2, absent from the
engine. Kept in the schema as authoring-only display data: the QM judges every
answer by eye by design, so nothing matches on it — it is there so the console can
show "also accept: …" during evaluation. If you'd rather it didn't exist, drop the
column; the engine won't notice.

**4. `MANUAL_ADJUST` with no active question.** The reducer writes
`questionId: ''` when there is no question in play. An empty string is not a
foreign key, so `score_event.question_id` is nullable and the mapper translates
`'' ↔ NULL`. Worth fixing in the engine instead — `questionId?: QuestionId` would
make the state unrepresentable rather than merely translated. Small change, and it
touches the ScoreEvent type, so it's your call whether it's worth the churn now.

**5. Reveal media are constrained to images.** `FORMAT_SPEC` §2.3 says a connect is
revealed "through a series of images", so `spec_2_3_reveals_are_images` enforces
that. If a connect should ever be able to reveal an audio clip, that CHECK is the
line to delete.

**6. "Maximum one video per question" is enforced per role.** §4 says one video
per question; it also says the answer is its own slide with "optionally an image
or video". Read strictly, a question with a video prompt could not have a video
answer. The schema permits one of each, since the constraint exists to bound
preload size (`ARCHITECTURE` §4) and the answer slide is a separate preload. Say
so if you meant it strictly — it's a one-word change to the index.

---

## 5. Why the runtime state is an action log

`DirectQuestionState`, `ConnectQuestionState` and `WrittenRoundState` are not
persisted as tables. `quiz_action` stores the QM's intents in order, and the state
is whatever `reduce()` produces from replaying them.

This works only because the reducer is pure — no clock, no randomness, no I/O —
which it is, deliberately. The payoff is that "the server restarted mid-round" is
survivable: reload the snapshot, replay the actions after it, and the room is
exactly where it was, including which teams have pounced and which parts are
credited. Persisting the state structs instead would mean a second
representation of the state machine, kept in sync by hand, wrong at the worst
possible moment.

`quiz_snapshot` is the fast path, not the truth. `quiz_action`'s primary key
`(quiz_id, seq)` doubles as a concurrency check: two servers cannot both claim
sequence N, so a split-brain room fails on insert instead of diverging quietly.

`pounce_submission` and `written_answer` are projections of `SUBMIT_POUNCE` and
`SUBMIT_WRITTEN` — rebuildable from the log at any time. They exist because "what
did Team 6 actually write?" gets asked after every quiz and answering it by
unpacking JSONB is miserable.
