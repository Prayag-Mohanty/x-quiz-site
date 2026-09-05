-- 007 — a wrong written answer says so
--
-- The ledger's reason vocabulary had STAKE_CORRECT and STAKE_WRONG but only
-- WRITTEN_CORRECT, so the reducer labelled an unstaked WRONG answer
-- WRITTEN_CORRECT. The points were right — an unstaked miss is 0 by default —
-- so nothing visibly broke, but the audit trail said the opposite of what
-- happened, and the post-quiz breakdown reads these reasons out loud.
--
-- Nothing needs rewriting. Existing WRITTEN_CORRECT rows worth 0 points are the
-- affected ones, and they are not corrected here: a ledger row is a record of
-- what the quizmaster did, and rewriting history to look tidier is exactly what
-- the append-only trigger exists to prevent. Void and re-award if it matters.

BEGIN;

ALTER TABLE score_event DROP CONSTRAINT score_event_reason_check;

ALTER TABLE score_event ADD CONSTRAINT score_event_reason_check CHECK (reason IN (
  'POUNCE_CORRECT','POUNCE_WRONG','BOUNCE_CORRECT','PARTIAL',
  'WRITTEN_CORRECT','WRITTEN_WRONG','STAKE_CORRECT','STAKE_WRONG',
  'CONNECT_CORRECT','CONNECT_WRONG','TIEBREAK','MANUAL_ADJUST'));

COMMIT;
