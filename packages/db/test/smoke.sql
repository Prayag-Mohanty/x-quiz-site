-- ============================================================================
-- smoke.sql — does the schema actually enforce FORMAT_SPEC?
--
-- The engine's convention is that every rule in FORMAT_SPEC has a named test
-- referencing it. Same idea here: each test below is named after the rule it
-- checks, and the constraints in the migrations carry the same names.
--
-- Runs inside a transaction and ends with ROLLBACK, so it leaves nothing behind
-- and is safe against a database with real quizzes in it.
--
--   psql -d quizmaster -v ON_ERROR_STOP=1 -f test/smoke.sql
--
-- Silence plus "ALL TESTS PASSED" at the end means everything held. A failure
-- aborts at the first bad assertion and names the rule.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ─── Assertion helpers ──────────────────────────────────────────────────────

-- Asserts the database REJECTS a statement. Catches only the constraint-shaped
-- error classes, so an assert_failure raised below propagates rather than being
-- swallowed by its own handler.
CREATE OR REPLACE FUNCTION assert_rejects(stmt text, rule text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION
    WHEN check_violation OR unique_violation OR foreign_key_violation
      OR restrict_violation OR not_null_violation OR exclusion_violation THEN
      RAISE NOTICE 'PASS  rejects: %', rule;
      RETURN;
  END;
  RAISE EXCEPTION 'FAIL  % -- the database ACCEPTED what the spec forbids', rule
    USING ERRCODE = 'assert_failure';
END $fn$;

CREATE OR REPLACE FUNCTION assert_eq(actual bigint, expected bigint, rule text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  % -- expected %, got %', rule, expected, actual
      USING ERRCODE = 'assert_failure';
  END IF;
  RAISE NOTICE 'PASS  %', rule;
END $fn$;

-- ─── Fixture: a 4-team quiz with one DIRECT round ───────────────────────────

INSERT INTO quiz (id, title) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Smoke Test Quiz');

INSERT INTO connect_stage (quiz_id, position, correct, wrong) VALUES
  ('11111111-0000-0000-0000-000000000001', 0, 20, -15),
  ('11111111-0000-0000-0000-000000000001', 1, 15, -10),
  ('11111111-0000-0000-0000-000000000001', 2, 10,  -5),
  ('11111111-0000-0000-0000-000000000001', 3,  5,   0);

INSERT INTO team (id, quiz_id, position, name) VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 0, 'Team 1'),
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 1, 'Team 2'),
  ('22222222-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', 2, 'Team 3'),
  ('22222222-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001', 3, 'Team 4');

INSERT INTO round (id, quiz_id, position, type, title, direction) VALUES
  ('33333333-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 0, 'DIRECT', 'Round 1', 'CW'),
  ('33333333-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 1, 'VISUAL_CONNECT', 'Long Visual Connect', NULL);

-- A 2-part question worth 10 — the worked example from FORMAT_SPEC §2.1.
INSERT INTO question (id, round_id, round_type, position, body, answer_text) VALUES
  ('44444444-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', 'DIRECT', 0,
   'Two-part question', 'Part A and Part B');

INSERT INTO question_part (id, question_id, position, label, canonical_answer) VALUES
  ('55555555-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001', 0, 'A', 'answer a'),
  ('55555555-0000-0000-0000-000000000002', '44444444-0000-0000-0000-000000000001', 1, 'B', 'answer b');

INSERT INTO question (id, round_id, round_type, position, body) VALUES
  ('44444444-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000002', 'VISUAL_CONNECT', 0,
   'What connects these?');

INSERT INTO media_asset (id, quiz_id, kind, storage_key) VALUES
  ('66666666-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'VIDEO', 'v1.mp4'),
  ('66666666-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'VIDEO', 'v2.mp4'),
  ('66666666-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', 'IMAGE', 'i1.jpg');

-- ─── FORMAT_SPEC §2.1 — round direction ─────────────────────────────────────

SELECT assert_rejects($q$
  INSERT INTO round (quiz_id, position, type, title, direction)
  VALUES ('11111111-0000-0000-0000-000000000001', 9, 'DIRECT', 'No direction', NULL)
$q$, '§2.1 a DIRECT round must have a direction');

SELECT assert_rejects($q$
  INSERT INTO round (quiz_id, position, type, title, direction)
  VALUES ('11111111-0000-0000-0000-000000000001', 9, 'WRITTEN', 'Directional written round', 'CW')
$q$, '§2.1 a non-DIRECT round must not have a direction');

-- ─── FORMAT_SPEC §4 — media rules ───────────────────────────────────────────

INSERT INTO question_media (question_id, round_type, role, position, asset_id, kind)
VALUES ('44444444-0000-0000-0000-000000000001', 'DIRECT', 'PROMPT', 0,
        '66666666-0000-0000-0000-000000000001', 'VIDEO');

SELECT assert_rejects($q$
  INSERT INTO question_media (question_id, round_type, role, position, asset_id, kind)
  VALUES ('44444444-0000-0000-0000-000000000001', 'DIRECT', 'PROMPT', 1,
          '66666666-0000-0000-0000-000000000002', 'VIDEO')
$q$, '§4 at most one video per question prompt');

-- The answer is its own slide and preloads separately, so it may carry its own
-- video. See docs/DATA_MODEL.md discrepancy 6 — confirm this reading.
INSERT INTO question_media (question_id, round_type, role, position, asset_id, kind)
VALUES ('44444444-0000-0000-0000-000000000001', 'DIRECT', 'ANSWER', 0,
        '66666666-0000-0000-0000-000000000002', 'VIDEO');

-- The composite FK means a lie about an asset's kind is not storable.
SELECT assert_rejects($q$
  INSERT INTO question_media (question_id, round_type, role, position, asset_id, kind)
  VALUES ('44444444-0000-0000-0000-000000000001', 'DIRECT', 'PROMPT', 2,
          '66666666-0000-0000-0000-000000000003', 'VIDEO')
$q$, 'a question_media row cannot misreport its asset kind');

-- ─── FORMAT_SPEC §2.3 — staged reveals ──────────────────────────────────────

INSERT INTO question_media (question_id, round_type, role, position, asset_id, kind)
VALUES ('44444444-0000-0000-0000-000000000002', 'VISUAL_CONNECT', 'REVEAL', 0,
        '66666666-0000-0000-0000-000000000003', 'IMAGE');

SELECT assert_rejects($q$
  INSERT INTO question_media (question_id, round_type, role, position, asset_id, kind)
  VALUES ('44444444-0000-0000-0000-000000000001', 'DIRECT', 'REVEAL', 0,
          '66666666-0000-0000-0000-000000000003', 'IMAGE')
$q$, '§2.3 staged reveals only exist on a VISUAL_CONNECT question');

SELECT assert_rejects($q$
  INSERT INTO question_media (question_id, round_type, role, position, asset_id, kind)
  VALUES ('44444444-0000-0000-0000-000000000002', 'VISUAL_CONNECT', 'REVEAL', 1,
          '66666666-0000-0000-0000-000000000001', 'VIDEO')
$q$, '§2.3 a connect is revealed through images');

-- ─── Reordering under deferred uniques ──────────────────────────────────────
-- The authoring UI must be able to swap two positions in one statement without
-- shuffling a row through a temporary offset.

UPDATE team SET position = CASE position WHEN 0 THEN 1 ELSE 0 END
 WHERE quiz_id = '11111111-0000-0000-0000-000000000001' AND position IN (0, 1);

SELECT assert_eq((SELECT position FROM team WHERE id = '22222222-0000-0000-0000-000000000001'),
                 1, 'teams can be reordered in a single statement');

UPDATE team SET position = CASE position WHEN 0 THEN 1 ELSE 0 END
 WHERE quiz_id = '11111111-0000-0000-0000-000000000001' AND position IN (0, 1);

-- ─── The worked example — FORMAT_SPEC §2.1 partial credit ───────────────────
-- 2-part question worth 10, CW, direct Team 1:
--   pounces from Teams 2 and 4 are wrong      -> -5 each, applied
--   Team 1 gets part A on bounce              -> +5 PENDING, NOT on the scoreboard
--   Team 3 gets both parts                    -> +10 applied, question resolves
--   QM reveals                                -> Team 1's +5 is published
-- The question yields 15. That is correct and intended.

INSERT INTO score_event (id, quiz_id, team_id, round_id, question_id, points, reason, status) VALUES
  ('77777777-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001', -5, 'POUNCE_WRONG', 'APPLIED'),
  ('77777777-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001', -5, 'POUNCE_WRONG', 'APPLIED'),
  ('77777777-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001', 5, 'PARTIAL', 'PENDING'),
  ('77777777-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000001', 10, 'BOUNCE_CORRECT', 'APPLIED');

-- Before the reveal: the partial is banked but invisible. This is the rule the
-- whole PENDING status exists for — a visible +5 would tell Teams 2, 3 and 4
-- that part A had been confirmed.
SELECT assert_eq((SELECT public_score FROM team_score WHERE team_id = '22222222-0000-0000-0000-000000000001'),
                 0, '§2.1 a withheld partial does not appear on the public scoreboard');

SELECT assert_eq((SELECT provisional_score FROM team_score WHERE team_id = '22222222-0000-0000-0000-000000000001'),
                 5, '§2.1 the QM can see the banked partial');

-- The reveal publishes every pending award for the question.
UPDATE score_event SET status = 'APPLIED'
 WHERE question_id = '44444444-0000-0000-0000-000000000001' AND status = 'PENDING';

SELECT assert_eq((SELECT public_score FROM team_score WHERE team_id = '22222222-0000-0000-0000-000000000001'),
                 5, '§2.1 the partial is published at reveal');

SELECT assert_eq((SELECT applied_at IS NOT NULL FROM score_event WHERE id = '77777777-0000-0000-0000-000000000003')::int::bigint,
                 1, 'applied_at is stamped when an event is published');

-- Points are not conserved: this question yielded 15 across two teams.
SELECT assert_eq((SELECT sum(points) FROM score_event
                   WHERE question_id = '44444444-0000-0000-0000-000000000001'
                     AND status = 'APPLIED' AND points > 0),
                 15, '§1 points are not conserved per question');

-- ─── FORMAT_SPEC §2.1 / §2.3 — one pounce per team per question ─────────────

SELECT assert_rejects($q$
  INSERT INTO score_event (quiz_id, team_id, round_id, question_id, points, reason, status)
  VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002',
          '33333333-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001',
          10, 'POUNCE_CORRECT', 'APPLIED')
$q$, '§2.1 one pounce per team per question');

-- ─── The ledger is append-only ──────────────────────────────────────────────

SELECT assert_rejects($q$
  DELETE FROM score_event WHERE id = '77777777-0000-0000-0000-000000000001'
$q$, 'ledger rows cannot be deleted');

SELECT assert_rejects($q$
  UPDATE score_event SET points = 100 WHERE id = '77777777-0000-0000-0000-000000000001'
$q$, 'ledger points are immutable -- void and re-award instead');

SELECT assert_rejects($q$
  UPDATE score_event SET team_id = '22222222-0000-0000-0000-000000000003'
   WHERE id = '77777777-0000-0000-0000-000000000001'
$q$, 'an award cannot be moved to another team');

SELECT assert_rejects($q$
  UPDATE score_event SET status = 'PENDING' WHERE id = '77777777-0000-0000-0000-000000000004'
$q$, 'a published award cannot be un-published');

SELECT assert_rejects($q$ TRUNCATE score_event $q$, 'the ledger cannot be truncated');

-- Undo is legal, and voiding removes the points from both views.
UPDATE score_event SET status = 'VOIDED' WHERE id = '77777777-0000-0000-0000-000000000001';

SELECT assert_eq((SELECT public_score FROM team_score WHERE team_id = '22222222-0000-0000-0000-000000000002'),
                 0, 'voiding an event removes its points');

SELECT assert_eq((SELECT voided_at IS NOT NULL FROM score_event WHERE id = '77777777-0000-0000-0000-000000000001')::int::bigint,
                 1, 'voided_at is stamped on undo');

-- A voided pounce frees the slot, so the QM can re-award after an undo.
INSERT INTO score_event (quiz_id, team_id, round_id, question_id, points, reason, status)
VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002',
        '33333333-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001',
        10, 'POUNCE_CORRECT', 'APPLIED');

-- ─── Ledger integrity ───────────────────────────────────────────────────────

SELECT assert_rejects($q$
  INSERT INTO score_event (quiz_id, team_id, round_id, question_id, points, reason, status)
  VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000003',
          '33333333-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001',
          10, 'BOUNCE_CORRECT', 'PENDING')
$q$, '§2 a bounce award is never withheld - it is announced as it happens');

-- A pounce award IS withheld now: the bounce runs after the pounce window, so
-- a published pounce result would leak into it. Team 3 already has an APPLIED
-- +10 from the bounce, so this also proves the two are summed independently.
INSERT INTO score_event (quiz_id, team_id, round_id, question_id, points, reason, status)
VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000003',
        '33333333-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001',
        -5, 'POUNCE_WRONG', 'PENDING');

SELECT assert_eq((SELECT public_score FROM team_score WHERE team_id = '22222222-0000-0000-0000-000000000003'),
                 10, '§2.1 a withheld pounce stays off the public scoreboard');

SELECT assert_eq((SELECT provisional_score FROM team_score WHERE team_id = '22222222-0000-0000-0000-000000000003'),
                 5, '§2.1 the QM can see the withheld pounce');

SELECT assert_rejects($q$
  INSERT INTO score_event (quiz_id, team_id, round_id, points, reason, status)
  VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000003',
          '33333333-0000-0000-0000-000000000001', -10, 'MANUAL_ADJUST', 'APPLIED')
$q$, 'a manual adjustment must carry the QM''s justification');

-- A manual adjustment between questions has no question, which is why
-- score_event.question_id is nullable (docs/DATA_MODEL.md discrepancy 4).
INSERT INTO score_event (quiz_id, team_id, round_id, question_id, points, reason, status, note)
VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000003',
        '33333333-0000-0000-0000-000000000001', NULL, -10, 'MANUAL_ADJUST', 'APPLIED',
        'Talking over the bounce');

-- §2.2 — a missed written answer is worth 0 by default, so the reason is the
-- only record that it was judged at all. WRITTEN_WRONG has to be sayable, or the
-- reducer has to label it WRITTEN_CORRECT, which is what it used to do (007).
INSERT INTO score_event (quiz_id, team_id, round_id, question_id, points, reason, status)
VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000004',
        '33333333-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001',
        0, 'WRITTEN_WRONG', 'APPLIED');

SELECT assert_rejects($q$
  INSERT INTO score_event (quiz_id, team_id, round_id, points, reason, status)
  VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000004',
          '33333333-0000-0000-0000-000000000001', 0, 'WRITTEN_NEARLY', 'APPLIED')
$q$, 'the reason vocabulary is closed');

-- Cross-quiz contamination is unrepresentable: the composite FKs pin a team and
-- a round to the same quiz.
INSERT INTO quiz (id, title) VALUES ('11111111-0000-0000-0000-0000000000ff', 'Another Quiz');
SELECT assert_rejects($q$
  INSERT INTO score_event (quiz_id, team_id, round_id, points, reason, status)
  VALUES ('11111111-0000-0000-0000-0000000000ff', '22222222-0000-0000-0000-000000000001',
          '33333333-0000-0000-0000-000000000001', 10, 'TIEBREAK', 'APPLIED')
$q$, 'a score event cannot mix teams and rounds from different quizzes');

-- ─── Tiebreak signals — FORMAT_SPEC §3 ──────────────────────────────────────
-- Team 2: one voided wrong pounce (excluded) plus one correct pounce.

SELECT assert_eq((SELECT pounces_attempted FROM team_standing WHERE team_id = '22222222-0000-0000-0000-000000000002'),
                 1, '§3 voided events do not count toward pounce stats');

SELECT assert_eq((SELECT pounces_correct FROM team_standing WHERE team_id = '22222222-0000-0000-0000-000000000002'),
                 1, '§3 pounce stats are derived from the ledger');

-- ─── A played quiz cannot be deleted ────────────────────────────────────────

SELECT assert_rejects($q$
  DELETE FROM quiz WHERE id = '11111111-0000-0000-0000-000000000001'
$q$, 'a quiz with a ledger cannot be deleted -- archive it instead');

-- An unplayed draft deletes cleanly.
DELETE FROM quiz WHERE id = '11111111-0000-0000-0000-0000000000ff';

-- ─── Readiness view ─────────────────────────────────────────────────────────
-- Rules that span rows: the fixture has 4 teams (fine), a connect question with
-- 1 reveal image against 4 configured stages (fine), and an empty answer on the
-- connect question (a warning, not a blocker).

SELECT assert_eq((SELECT count(*) FROM quiz_authoring_issue
                   WHERE quiz_id = '11111111-0000-0000-0000-000000000001' AND severity = 'ERROR'),
                 0, 'the fixture quiz has no blocking authoring errors');

SELECT assert_eq((SELECT count(*) FROM quiz_authoring_issue
                   WHERE quiz_id = '11111111-0000-0000-0000-000000000001'
                     AND severity = 'WARN' AND issue = 'answer text is empty'),
                 1, 'an unanswered question is flagged as a warning');

-- A question with no parts cannot be scored: the engine divides by parts.length.
INSERT INTO question (id, round_id, round_type, position, body)
VALUES ('44444444-0000-0000-0000-00000000000f', '33333333-0000-0000-0000-000000000001', 'DIRECT', 1, 'Partless');

SELECT assert_eq((SELECT count(*) FROM quiz_authoring_issue
                   WHERE entity_id = '44444444-0000-0000-0000-00000000000f'
                     AND issue LIKE 'question has no parts%'),
                 1, 'a question with no parts is flagged as an error');

-- FORMAT_SPEC §1: 2-12 teams.
INSERT INTO quiz (id, title) VALUES ('11111111-0000-0000-0000-0000000000aa', 'Solo Quiz');
INSERT INTO team (quiz_id, position, name)
VALUES ('11111111-0000-0000-0000-0000000000aa', 0, 'Only Team');

SELECT assert_eq((SELECT count(*) FROM quiz_authoring_issue
                   WHERE quiz_id = '11111111-0000-0000-0000-0000000000aa'
                     AND issue LIKE 'quiz has 1 teams%'),
                 1, '§1 a quiz needs at least 2 teams');

-- Rotation walks indices, so a gap in team positions silently breaks the
-- bounce order. It has to be caught at authoring time.
INSERT INTO team (quiz_id, position, name)
VALUES ('11111111-0000-0000-0000-0000000000aa', 5, 'Gap Team');

SELECT assert_eq((SELECT count(*) FROM quiz_authoring_issue
                   WHERE quiz_id = '11111111-0000-0000-0000-0000000000aa'
                     AND issue = 'team positions are not contiguous from 0'),
                 1, '§2.1 team positions must be contiguous for rotation to work');

-- ─── Done ───────────────────────────────────────────────────────────────────

DO $fn$ BEGIN RAISE NOTICE '%', repeat('-', 60); RAISE NOTICE 'ALL TESTS PASSED'; END $fn$;

ROLLBACK;
