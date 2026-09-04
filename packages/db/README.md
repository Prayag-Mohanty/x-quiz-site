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
| `src/rows.ts` | One interface per table, mirroring the SQL | Phase 0 |
| `src/map.ts` | Row-to-domain mapping — the only place snake_case becomes camelCase | Phase 0 |

**This package has no `pg` and runs no queries.** It ships the schema, the row
types and the translation; the connection pool belongs to the Phase 1 server.
That keeps the mappers pure and testable with literals, the same discipline the
engine follows.

The mappers exist to protect two things SQL will not protect for you. **Order** —
rows arrive however the planner likes, and the engine indexes into arrays that
`rotation.ts` does arithmetic on, so everything is sorted by `position` on the way
through. And **team seating** — a team's index *is* its seat, so `toQuizState`
throws on a gap or a duplicate rather than letting a silently shifted rotation
reach a live quiz.

Apply both now. An empty ledger costs nothing, and the ledger is the one
structure that cannot be retrofitted later.

## Applying

Requires PostgreSQL 14 or later (`gen_random_uuid()` is core from 13; the syntax
used here is 14-safe).

```bash
createdb quizmaster && psql -d quizmaster -v ON_ERROR_STOP=1 -f migrations/001_content.sql -f migrations/002_runtime.sql
```

Each file is wrapped in `BEGIN`/`COMMIT`, so a failure leaves nothing behind.

### A disposable cluster

If you don't have the superuser password for an installed Postgres service — a
`winget install` sets one unattended and never tells you — you don't need it. The
same binaries will run a second cluster you own, with no password and no admin
rights, on another port:

```bash
initdb -D /tmp/qm-pgdata -U postgres --auth-local=trust --auth-host=trust
pg_ctl -D /tmp/qm-pgdata -o "-p 55432" -l /tmp/qm-pgdata/server.log start
createdb -h 127.0.0.1 -p 55432 -U postgres quizmaster
```

Point `psql` at `-p 55432`, and `pg_ctl ... stop` plus deleting the directory
removes every trace. This is how the schema was verified. Note that the server is
a child of whatever shell starts it — killing that shell takes the database down
with it.

## Testing

Two suites, because there are two things to get wrong.

`test/map.test.ts` covers the translation — ordering, the seat-contiguity guard,
and optionality (a NULL `partial_value` must leave the key *absent*, since the
engine's `value / parts.length` fallback keys off a missing property, not an
undefined one). No database needed.

```bash
npm install && npm test        # requires ../engine to be built first
```

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

Verified on PostgreSQL 17.11 and Node 24: both migrations apply to an empty database, all
31 assertions in `test/smoke.sql` pass, and all 21 mapping tests pass.

14 tables, 4 views, 46 check constraints, 18 foreign keys and 7 triggers. Nothing
here has run against a database holding a real quiz yet.
