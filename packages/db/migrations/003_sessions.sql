-- ============================================================================
-- 003_sessions.sql — join codes and sessions.
--
-- DECISIONS.md: auth is join codes, not accounts. No passwords, no email, no
-- OAuth. The QM gets a link; each team gets a short code; a team member enters
-- the code and a display name. This is a quiz for people the QM already knows,
-- and account infrastructure is pure cost.
--
-- Migrations 001 and 002 have been applied, so this is a new file rather than
-- an edit to them.
-- ============================================================================

BEGIN;

-- The QM's own link. Long and random: whoever holds it can drive the quiz.
ALTER TABLE quiz ADD COLUMN qm_token text;
-- gen_random_uuid() is core; gen_random_bytes() would need the pgcrypto
-- extension, which this schema deliberately does not require.
UPDATE quiz SET qm_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
 WHERE qm_token IS NULL;
ALTER TABLE quiz ALTER COLUMN qm_token SET NOT NULL;
ALTER TABLE quiz ADD CONSTRAINT quiz_qm_token_unique UNIQUE (qm_token);

-- A team's code is typed by a human, out loud or over a phone, under time
-- pressure. Short and case-insensitive; the server upper-cases on lookup.
-- Unique globally rather than per quiz so a code identifies a team on its own —
-- a member joining should not also have to say which quiz they mean.
ALTER TABLE team ADD COLUMN join_code text;
UPDATE team SET join_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
 WHERE join_code IS NULL;
ALTER TABLE team ALTER COLUMN join_code SET NOT NULL;
ALTER TABLE team ADD CONSTRAINT team_join_code_unique UNIQUE (join_code);
ALTER TABLE team ADD CONSTRAINT team_join_code_shape
  CHECK (join_code = upper(join_code) AND length(join_code) BETWEEN 4 AND 12);

/**
 * One row per person in the room.
 *
 * A team is one identity shared by up to three people in different places
 * (CLAUDE.md invariant 5), so several sessions point at the same team. The
 * display name is per person — that is what makes typing indicators and
 * last-write-wins attribution on the shared draft possible.
 *
 * team_id NULL means the quizmaster.
 */
CREATE TABLE session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The cookie value. Random, not derived from anything guessable.
  token        text NOT NULL,
  quiz_id      uuid NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  team_id      uuid REFERENCES team(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT session_token_unique UNIQUE (token)
);

CREATE INDEX session_quiz_idx ON session (quiz_id);
CREATE INDEX session_team_idx ON session (team_id);

-- A session's team must belong to the same quiz as the session. Same composite
-- FK trick the ledger uses: the pairing is unrepresentable rather than merely
-- discouraged. MATCH SIMPLE means a NULL team_id (the QM) satisfies it.
ALTER TABLE session
  ADD CONSTRAINT session_team_in_quiz
  FOREIGN KEY (team_id, quiz_id) REFERENCES team (id, quiz_id) ON DELETE CASCADE;

COMMIT;
