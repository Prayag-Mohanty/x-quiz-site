-- ============================================================================
-- 006_withhold_pounce_awards.sql
--
-- Pounce awards are now withheld until the reveal, like partials.
--
-- 002 asserted that a PENDING row could only ever be a PARTIAL, with a note
-- saying to drop the constraint if that stopped being true. It has: now that
-- the bounce runs after the pounce window, a published pounce result leaks
-- into it. A team watching the scoreboard sees +10 appear and knows the
-- question is already answered, or sees -5 and knows that answer was wrong.
--
-- That is the same leak the partial rule exists to prevent, so it gets the same
-- mechanism rather than a second one.
--
-- The constraint is replaced rather than simply dropped: withholding is still
-- meant to be rare and deliberate, and a PENDING row with any other reason
-- would be a bug worth catching at the database.
-- ============================================================================

BEGIN;

ALTER TABLE score_event DROP CONSTRAINT spec_2_1_only_partials_are_withheld;

ALTER TABLE score_event ADD CONSTRAINT spec_2_only_judged_answers_are_withheld
  CHECK (
    status <> 'PENDING'
    OR reason IN ('PARTIAL', 'POUNCE_CORRECT', 'POUNCE_WRONG',
                  'CONNECT_CORRECT', 'CONNECT_WRONG')
  );

COMMENT ON CONSTRAINT spec_2_only_judged_answers_are_withheld ON score_event IS
  'Withholding exists so that a score change cannot tell the room something about an answer before the reveal. Partial credit and pounce results are the awards that can leak that way; nothing else should be PENDING.';

COMMIT;
