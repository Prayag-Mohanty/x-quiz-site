# @quizmaster/db

Postgres schema for the quiz platform. Plain SQL migrations, applied in numeric
order. No migration framework yet — there is no server package to hang one off,
and two files do not need tooling. When Phase 1 lands a server, wire these into
whatever it uses; the files are ordinary SQL and will not need rewriting.

`docs/DATA_MODEL.md` explains how these tables map onto
`packages/engine/src/types.ts` and records the discrepancies worth resolving.

## Files

| File | Contents |
|---|---|
| `migrations/001_content.sql` | Quizzes, teams, rounds, questions, parts, media, scoring config, the readiness view |
| `migrations/002_runtime.sql` | Score ledger, QM action log, snapshots, submissions, score views |
| `migrations/003_sessions.sql` | Join codes and sessions |
| `migrations/004_credential_defaults.sql` | Database defaults for those credentials |
| `migrations/005_pouncers_may_bounce.sql` | Renames the rule flag once §5 question 1 was answered |
| `migrations/006_withhold_pounce_awards.sql` | Lets a pounce award be withheld until the reveal |
| `migrations/007_written_wrong_reason.sql` | Adds `WRITTEN_WRONG`, so a missed written answer is not logged as a correct one |
| `migrations/008_sealed_preload.sql` | A second id and an AES key per asset, so media can be preloaded as ciphertext |
| `src/rows.ts` | One interface per table, mirroring the SQL |
| `src/map.ts` | Row-to-domain mapping — the only place snake_case becomes camelCase |

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

Apply them all. An empty ledger costs nothing, and the ledger is the one
structure that cannot be retrofitted later.

## Applying

Requires PostgreSQL 14 or later (`gen_random_uuid()` is core from 13; the syntax
used here is 14-safe).

Apply them in numeric order; each is wrapped in `BEGIN`/`COMMIT`, so a failure
leaves nothing behind.

```bash
createdb quizmaster
for f in migrations/*.sql; do psql -d quizmaster -v ON_ERROR_STOP=1 -f "$f"; done
```

### A cluster of your own

If you don't have the superuser password for an installed Postgres service — a
`winget install` sets one unattended and never tells you — you don't need it. The
same binaries will run a second cluster you own, with no password and no admin
rights, on another port:

```
initdb -D C:\Users\you\Quizmaster\pgdata -U postgres --auth-local=trust --auth-host=trust
pg_ctl -D C:\Users\you\Quizmaster\pgdata -o "-p 55432" -l server.log start
createdb -h 127.0.0.1 -p 55432 -U postgres quizmaster
```

Point `psql` at `-p 55432`. Two things worth knowing.

**The data directory is the database.** That folder holds every byte Postgres
has — tables, indexes, the write-ahead log. Do not put it in `%TEMP%`: Windows
clears that on its own schedule, so a quiz stored there is a quiz waiting to be
deleted. This project's dev cluster started life there, for a ten-minute schema
check, and had to be moved once it held real content.

**Postgres does not start itself** — unless you make it a Windows service. A
cluster started by hand with `pg_ctl` stays down after a reboot. Registering it
starts it with the machine:

```
pg_ctl register -N "QuizmasterPostgres" -U "NT AUTHORITY\NetworkService" -D C:\Quizmaster\pgdata -S auto -o "-p 55432"
```

That needs an administrator shell, and two things have to be true first. The
data directory must live **outside your user profile** — a service account
cannot traverse into `C:\Users\<you>` without rights you should not grant it —
and the account needs access to the folder:

```
icacls C:\Quizmaster\pgdata /grant "NT AUTHORITY\NetworkService:(OI)(CI)F" /T
```

Postgres also refuses to run as an administrative account, so `NetworkService`
rather than `SYSTEM`. On this machine the dev database is registered exactly
that way and lives at `C:\Quizmaster\pgdata`.

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

Verified on PostgreSQL 17.11 and Node 24: the migrations apply to an empty
database, all 33 assertions in `test/smoke.sql` pass, and all 21 mapping tests
pass.

The schema has since carried an authored quiz through real rounds — questions,
teams, pounces, a bounce and a written round — so it is no longer only tested,
it has been used.
