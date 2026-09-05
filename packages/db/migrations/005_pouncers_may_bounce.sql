-- ============================================================================
-- 005_pouncers_may_bounce.sql
--
-- FORMAT_SPEC §5 open question 1 is answered, and the answer is the opposite of
-- the assumption it shipped with.
--
-- The assumption was that a team which pounced WRONG could still answer on the
-- bounce. The real rule is that pouncing spends your turn on that question: you
-- are out of the bounce whether you were right or wrong. That is the trade the
-- negative marking pays for.
--
-- So the column is renamed as well as re-defaulted, because "wrong pouncer" no
-- longer describes what it controls — it now covers every pouncer.
--
-- Existing rows are flipped to the correct rule. Any quiz already authored was
-- authored under an assumption nobody had confirmed, so there is no setting here
-- worth preserving.
-- ============================================================================

BEGIN;

ALTER TABLE quiz RENAME COLUMN rule_wrong_pouncer_may_bounce TO rule_pouncers_may_bounce;

ALTER TABLE quiz ALTER COLUMN rule_pouncers_may_bounce SET DEFAULT false;

UPDATE quiz SET rule_pouncers_may_bounce = false;

COMMENT ON COLUMN quiz.rule_pouncers_may_bounce IS
  'FORMAT_SPEC 2.1: false means a team that pounced is out of the bounce for that question, right or wrong. Answered 2026-09-05.';

COMMIT;
