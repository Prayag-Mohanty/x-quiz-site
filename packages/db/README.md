# @quizmaster/db

Postgres schema for the quiz platform. Plain SQL migrations, applied in numeric
order. No migration framework yet — there is no server package to hang one off,
and two files do not need tooling. When Phase 1 lands a server, wire these into
whatever it uses; the files are ordinary SQL and will not need rewriting.

`docs/DATA_MODEL.md` explains how these tables map onto
`packages/engine/src/types.ts` and records the discrepancies worth resolving.

## Files

| File | Contents | Needed by |
|---|---|---|
| `migrations/001_content.sql` | Quizzes, teams, rounds, questions, parts, media, scoring config, the readiness view | Phase 0 |
| `migrations/002_runtime.sql` | Score ledger, QM action log, snapshots, submissions, score views | Phase 1 |

Apply both now. An empty ledger costs nothing, and the ledger is the one
structure that cannot be retrofitted later.

## Applying

Requires PostgreSQL 14 or later (`gen_random_uuid()` is core from 13; the syntax
used here is 14-safe).

```bash
createdb quizmaster && psql -d quizmaster -v ON_ERROR_STOP=1 -f migrations/001_content.sql -f migrations/002_runtime.sql
```

Each file is wrapped in `BEGIN`/`COMMIT`, so a failure leaves nothing behind.

## Testing

`test/smoke.sql` checks that the schema actually enforces `FORMAT_SPEC` — one
named assertion per rule, the same convention the engine's tests follow. It
includes the worked example from §2.1 end to end: a withheld partial stays off
the public scoreboard, appears at reveal, and the question yields 15 points.

```bash
psql -d quizmaster -v ON_ERROR_STOP=1 -f test/smoke.sql
```

It runs in a transaction and ends with `ROLLBACK`, so it is safe to run against a
database with real quizzes in it. Success ends with `ALL TESTS PASSED`; a failure
aborts at the first bad assertion and names the rule that broke.

## Things that will bite you

- **`position` is 0-based and load-bearing.** It matches the engine's array
  indices, and `rotation.ts` does arithmetic on them. Format for display at the
  edge; never renumber to 1-based in the database.
- **Position uniques are deferrable.** That makes reordering in one transaction
  easy, but `ON CONFLICT` cannot target a deferrable constraint — upsert on the
  primary key instead.
- **`score_event` is append-only, enforced by trigger.** `DELETE` and `TRUNCATE`
  are rejected. `UPDATE` is allowed only on `status` (along legal transitions) and
  `note`. To correct an award, void it and append a new one.
- **A quiz that has been scored cannot be deleted.** `ON DELETE RESTRICT` from the
  ledger blocks the cascade. Set `quiz.status = 'ARCHIVED'` instead. Unplayed
  drafts delete cleanly.
- **`quiz_authoring_issue`** is where the rules that span rows live — team counts,
  question counts, empty bodies. Query it to decide whether a quiz can be run.
  `ERROR` blocks; `WARN` does not.

## Status

**Not yet executed against a live Postgres.** No server is installed on the
machine this was written on, and Docker Desktop fails to start there, so the SQL
and its tests have been reviewed but never run. Apply the migrations to a scratch
database and run `test/smoke.sql` before writing any code against this.
