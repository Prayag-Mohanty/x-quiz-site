-- ============================================================================
-- 004_credential_defaults.sql — give the join credentials database defaults.
--
-- 003 added quiz.qm_token and team.join_code as NOT NULL with no default, which
-- means every INSERT anywhere has to invent one. That broke test/smoke.sql
-- immediately, and it would have pushed the same burden onto every caller.
--
-- A default is the right home for this: the value is random, nothing outside
-- the database has an opinion about it, and a row without one is useless. The
-- server may still supply a friendlier code (a nicer alphabet than hex); this
-- is the floor, not the policy.
--
-- Separate file rather than an edit to 003, because 003 has been applied —
-- DECISIONS.md and GLOSSARY.md both say never edit an applied migration.
-- ============================================================================

BEGIN;

ALTER TABLE quiz
  ALTER COLUMN qm_token
  SET DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

ALTER TABLE team
  ALTER COLUMN join_code
  SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

COMMIT;
