-- ============================================================================
-- 001_content.sql — authoring-time content and quiz setup.
--
-- Maps the content half of packages/engine/src/types.ts:
--   quiz config (DirectScoring, WrittenScoring, RuleOptions, ConnectStage[]),
--   Team, Round, Question, QuestionPart, Media.
--
-- Everything in this file is what Phase 0 needs. The runtime half — the score
-- ledger, the action log, submissions — is 002_runtime.sql.
--
-- Targets PostgreSQL 14+. gen_random_uuid() is core from PG13; no extension.
--
-- Conventions
--   * snake_case here, camelCase in the engine. The mapping is 1:1 except for
--     two renames documented in docs/DATA_MODEL.md.
--   * `position` columns are load-bearing. The engine indexes into arrays
--     (teams[], rounds[], questions[], parts[]) and all rotation math is
--     defined on those indices. Postgres has no inherent row order, so position
--     IS the order. It is 0-based to match the engine exactly — do not make it
--     1-based for display; format at the edge.
--   * Position uniques are DEFERRABLE INITIALLY DEFERRED so the authoring UI can
--     reorder within one transaction without renumbering through a temp offset.
--   * Constraints are named after the FORMAT_SPEC rule they enforce, the same
--     way engine tests are.
-- ============================================================================

BEGIN;

-- ─── Shared: updated_at ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

-- ─── quiz ───────────────────────────────────────────────────────────────────
-- Scoring config and rule toggles live at quiz level because that is where the
-- engine puts them (QuizState.directScoring / .writtenScoring / .rules).
-- ARCHITECTURE §2 sketches a per-round `config` blob; the engine has no such
-- thing. Following the engine — see docs/DATA_MODEL.md, discrepancy 1.
--
-- These are columns rather than a JSONB blob so the DB can range-check them and
-- so a shape change forces a migration. A config blob that silently accepts
-- {pounceCorect: 10} is something you discover mid-quiz.

CREATE TABLE quiz (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (length(btrim(title)) > 0),
  status      text NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','READY','LIVE','COMPLETE','ARCHIVED')),

  -- DirectScoring (FORMAT_SPEC §2.1)
  direct_pounce_correct  integer NOT NULL DEFAULT 10,
  direct_pounce_wrong    integer NOT NULL DEFAULT -5,
  direct_bounce_correct  integer NOT NULL DEFAULT 10,
  direct_bounce_wrong    integer NOT NULL DEFAULT 0,
  direct_question_value  integer NOT NULL DEFAULT 10
                           CHECK (direct_question_value > 0),

  -- WrittenScoring (FORMAT_SPEC §2.2)
  written_correct        integer NOT NULL DEFAULT 10,
  written_wrong          integer NOT NULL DEFAULT 0,
  written_stake_correct  integer NOT NULL DEFAULT 15,
  written_stake_wrong    integer NOT NULL DEFAULT -5,

  -- RuleOptions (FORMAT_SPEC §5 — the genuinely open questions)
  rule_wrong_pouncer_may_bounce            boolean NOT NULL DEFAULT true,
  rule_multiple_stakes_allowed             boolean NOT NULL DEFAULT true,
  rule_connect_bounces_after_final_reveal  boolean NOT NULL DEFAULT false,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Wrong answers must not pay, correct answers must not cost. Beyond that the
  -- numbers are the QM's business.
  CONSTRAINT spec_2_penalties_are_not_rewards
    CHECK (direct_pounce_wrong <= 0 AND direct_bounce_wrong <= 0
           AND written_wrong <= 0 AND written_stake_wrong <= 0),
  CONSTRAINT spec_2_rewards_are_not_penalties
    CHECK (direct_pounce_correct >= 0 AND direct_bounce_correct >= 0
           AND written_correct >= 0 AND written_stake_correct >= 0)
);

CREATE TRIGGER quiz_updated_at BEFORE UPDATE ON quiz
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── connect_stage ──────────────────────────────────────────────────────────
-- ConnectStage[] — variable length and ordered, so rows, not columns.
-- The defaults (20/-15, 15/-10, 10/-5, 5/0) are seeded by the app at quiz
-- creation rather than by a column DEFAULT here, so that a quiz with a
-- deliberately different decay curve is not silently indistinguishable from one
-- where somebody forgot to configure it.

CREATE TABLE connect_stage (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id   uuid NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  position  integer NOT NULL CHECK (position >= 0),
  correct   integer NOT NULL CHECK (correct >= 0),
  wrong     integer NOT NULL CHECK (wrong <= 0),

  CONSTRAINT connect_stage_position_unique
    UNIQUE (quiz_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX connect_stage_quiz_idx ON connect_stage (quiz_id);

-- ─── team ───────────────────────────────────────────────────────────────────
-- position is the seat order around the notional circle. Rotation — CW/ACW,
-- bounce order, next-direct advancement — is defined entirely on these indices.
-- Reordering teams changes the quiz. It is not a display preference.

CREATE TABLE team (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id    uuid NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  position   integer NOT NULL CHECK (position >= 0),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT team_position_unique
    UNIQUE (quiz_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT team_name_unique UNIQUE (quiz_id, name),
  -- Target of the composite FK that pins a score event's team to its quiz.
  CONSTRAINT team_id_quiz_unique UNIQUE (id, quiz_id)
);

CREATE TRIGGER team_updated_at BEFORE UPDATE ON team
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- NOTE: there is deliberately no team.score column. Score is
-- SUM(points) WHERE status = 'APPLIED' over score_event. See CLAUDE.md
-- invariant 2 and the team_score view in 002_runtime.sql.

-- Team.members: string[] in the engine. Rows rather than a text[] column
-- because Phase 1 needs per-member identity — typing indicators and
-- last-write-wins author attribution on the shared team draft (ARCHITECTURE §5).
-- A text[] would have to be rebuilt into this the moment that lands.

CREATE TABLE team_member (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  position     integer NOT NULL CHECK (position >= 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),

  CONSTRAINT team_member_position_unique
    UNIQUE (team_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX team_member_team_idx ON team_member (team_id);

-- ─── round ──────────────────────────────────────────────────────────────────

CREATE TABLE round (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id  uuid NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  type     text NOT NULL CHECK (type IN ('DIRECT','WRITTEN','VISUAL_CONNECT')),
  title    text NOT NULL CHECK (length(btrim(title)) > 0),

  -- Direction is per-round configuration (FORMAT_SPEC §2.1). R1 = CW and
  -- R2 = ACW is convention, not rule, so it is not a default here.
  direction text CHECK (direction IN ('CW','ACW')),

  -- Who gets Q1 direct. ARCHITECTURE §2 puts this on Round; the engine carries
  -- only a quiz-level nextDirectTeamIdx and START_ROUND does not reset it.
  -- Recorded here because quiz setup needs it — docs/DATA_MODEL.md,
  -- discrepancy 2. NULL means "carry on from wherever the rotation is".
  starting_team_position integer CHECK (starting_team_position >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT round_position_unique
    UNIQUE (quiz_id, position) DEFERRABLE INITIALLY DEFERRED,
  -- Both halves matter: a DIRECT round without a direction has no bounce order,
  -- and a direction on a WRITTEN round is a lie about how it will be run.
  CONSTRAINT spec_2_1_direction_iff_direct
    CHECK ((type = 'DIRECT') = (direction IS NOT NULL)),
  CONSTRAINT spec_2_1_starting_team_only_direct
    CHECK (type = 'DIRECT' OR starting_team_position IS NULL),
  -- Targets of composite FKs. See the note on question.round_type.
  CONSTRAINT round_id_type_unique UNIQUE (id, type),
  CONSTRAINT round_id_quiz_unique UNIQUE (id, quiz_id)
);

CREATE TRIGGER round_updated_at BEFORE UPDATE ON round
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── media_asset ────────────────────────────────────────────────────────────
-- The uploaded file, distinct from its use in a question, so one asset can
-- appear in several questions without being uploaded (or preloaded) twice.
--
-- The engine's Media.url is a plain required string. Here `url` is nullable and
-- storage_key is the truth: R2 URLs are signed and expire, so the server mints
-- one when it builds the engine's Question. A signed URL stored in the DB gives
-- you a quiz that works in rehearsal and 403s on the night.

CREATE TABLE media_asset (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id           uuid NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('IMAGE','AUDIO','VIDEO')),
  storage_key       text NOT NULL,
  url               text,
  size_bytes        bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  duration_ms       integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  original_filename text,
  content_type      text,
  -- ARCHITECTURE §2 calls this preload_hash: clients use it to decide whether a
  -- cached copy is still current (Phase 2).
  checksum_sha256   text,
  -- Phase 2: uploads are transcoded to one web rendition before being served.
  transcode_status  text NOT NULL DEFAULT 'PENDING'
                      CHECK (transcode_status IN ('PENDING','READY','FAILED','NOT_REQUIRED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT media_asset_storage_key_unique UNIQUE (storage_key),
  -- Lets question_media carry a `kind` the DB knows is truthful. See below.
  CONSTRAINT media_asset_id_kind_unique UNIQUE (id, kind),
  CONSTRAINT media_asset_duration_only_timed
    CHECK (duration_ms IS NULL OR kind IN ('AUDIO','VIDEO'))
);

CREATE TRIGGER media_asset_updated_at BEFORE UPDATE ON media_asset
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX media_asset_quiz_idx ON media_asset (quiz_id);

-- ─── question ───────────────────────────────────────────────────────────────
-- round_type is a denormalised copy of round.type, kept honest by the composite
-- FK (round_id, round_type) -> round (id, type). Postgres will not let the copy
-- disagree with the original, and ON UPDATE CASCADE propagates a round type
-- change downward. It buys structural enforcement of rules that are otherwise
-- cross-table — e.g. staged reveal images can only hang off a VISUAL_CONNECT
-- question, checked below without a trigger or a join.

CREATE TABLE question (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id    uuid NOT NULL,
  round_type  text NOT NULL,
  position    integer NOT NULL CHECK (position >= 0),

  -- Maps to Question.text. FORMAT_SPEC §4: the plain text body is ALWAYS
  -- required. Named `body` because `question.text` in a query reads like a cast.
  body        text NOT NULL DEFAULT '',
  answer_text text NOT NULL DEFAULT '',
  -- QM-only prompt notes. Not in the engine; the console shows it beside the
  -- answer during evaluation.
  qm_notes    text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (round_id, round_type) REFERENCES round (id, type)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT question_position_unique
    UNIQUE (round_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT question_id_round_type_unique UNIQUE (id, round_type),
  CONSTRAINT question_id_round_unique UNIQUE (id, round_id)
);

CREATE TRIGGER question_updated_at BEFORE UPDATE ON question
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- body and answer_text default to '' so a question can be created and filled in
-- across several saves. "Non-empty before the quiz goes live" is a readiness
-- check, not a column constraint — see the quiz_authoring_issue view.

-- ─── question_part ──────────────────────────────────────────────────────────
-- One row for a simple question, 2+ for multi-part (FORMAT_SPEC §2.1).

CREATE TABLE question_part (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id      uuid NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  position         integer NOT NULL CHECK (position >= 0),
  label            text NOT NULL DEFAULT '',
  canonical_answer text NOT NULL DEFAULT '',

  -- NULL means "use the default", which the engine computes as
  -- questionValue / parts.length. Set it when parts are not equally weighted.
  partial_value    integer CHECK (partial_value IS NULL OR partial_value >= 0),

  -- Authoring aid only: alternative phrasings the QM is prepared to accept.
  -- The engine has no such field and nothing matches on it — the QM judges
  -- every answer by eye, by design. This exists so the console can show the
  -- variants during evaluation. ARCHITECTURE §2 lists accepted_variants on
  -- QuestionPart; the engine does not. docs/DATA_MODEL.md, discrepancy 3.
  accepted_variants text[] NOT NULL DEFAULT '{}',

  CONSTRAINT question_part_position_unique
    UNIQUE (question_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX question_part_question_idx ON question_part (question_id);

-- ─── question_media ─────────────────────────────────────────────────────────
-- One table for all three of the engine's media arrays, distinguished by role:
--   PROMPT -> Question.media
--   ANSWER -> Question.answerMedia
--   REVEAL -> Question.revealSequence   (VISUAL_CONNECT only)
--
-- `kind` is again a copy kept truthful by a composite FK. It exists so the
-- one-video rule can be a unique index rather than a code review.

CREATE TABLE question_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL,
  round_type  text NOT NULL,
  role        text NOT NULL CHECK (role IN ('PROMPT','ANSWER','REVEAL')),
  position    integer NOT NULL CHECK (position >= 0),
  asset_id    uuid NOT NULL,
  kind        text NOT NULL,

  FOREIGN KEY (question_id, round_type) REFERENCES question (id, round_type)
    ON UPDATE CASCADE ON DELETE CASCADE,
  -- RESTRICT: deleting an asset a question still uses should fail loudly.
  FOREIGN KEY (asset_id, kind) REFERENCES media_asset (id, kind)
    ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT question_media_position_unique
    UNIQUE (question_id, role, position) DEFERRABLE INITIALLY DEFERRED,
  -- FORMAT_SPEC §2.3: a connect is "a single connection revealed through a
  -- series of images". Staged reveals belong only to VISUAL_CONNECT questions.
  CONSTRAINT spec_2_3_reveal_only_in_connect
    CHECK (role <> 'REVEAL' OR round_type = 'VISUAL_CONNECT'),
  CONSTRAINT spec_2_3_reveals_are_images
    CHECK (role <> 'REVEAL' OR kind = 'IMAGE')
);

CREATE INDEX question_media_question_idx ON question_media (question_id);
CREATE INDEX question_media_asset_idx ON question_media (asset_id);

-- FORMAT_SPEC §4: maximum one video per question. Scoped per role, because the
-- answer is its own slide and may carry its own video ("text plus optionally an
-- image or video"). This constraint is also what bounds preload size
-- (ARCHITECTURE §4), which is the reason the rule exists at all.
CREATE UNIQUE INDEX spec_4_one_video_per_question_role
  ON question_media (question_id, role) WHERE kind = 'VIDEO';

-- ─── Readiness ──────────────────────────────────────────────────────────────
-- Rules that are counts across rows, not properties of a row, cannot be CHECK
-- constraints without a trigger on every write. They are also not errors during
-- authoring — a half-written quiz is a normal state at 11pm. So they are a
-- query the authoring UI runs to answer "is this quiz ready to run?".

CREATE VIEW quiz_authoring_issue AS
  -- FORMAT_SPEC §1: 2–12 teams.
  SELECT q.id AS quiz_id, 'ERROR' AS severity, 'quiz' AS entity, q.id AS entity_id,
         format('quiz has %s teams; the format supports 2 to 12', count(t.id)) AS issue
    FROM quiz q LEFT JOIN team t ON t.quiz_id = q.id
   GROUP BY q.id HAVING count(t.id) < 2 OR count(t.id) > 12

  UNION ALL
  -- FORMAT_SPEC §1: teams seat 0..n-1 with no gaps, because rotation walks
  -- indices. A gap silently breaks the bounce order.
  SELECT t.quiz_id, 'ERROR', 'quiz', t.quiz_id,
         'team positions are not contiguous from 0'
    FROM team t GROUP BY t.quiz_id
   HAVING max(t.position) <> count(*) - 1 OR min(t.position) <> 0

  UNION ALL
  -- FORMAT_SPEC: a team is up to 3 people.
  SELECT t.quiz_id, 'ERROR', 'team', t.id,
         format('team "%s" has %s members; maximum is 3', t.name, count(m.id))
    FROM team t JOIN team_member m ON m.team_id = t.id
   GROUP BY t.quiz_id, t.id, t.name HAVING count(m.id) > 3

  UNION ALL
  -- FORMAT_SPEC §4: the text body is always required.
  SELECT r.quiz_id, 'ERROR', 'question', qn.id, 'question body is empty'
    FROM question qn JOIN round r ON r.id = qn.round_id
   WHERE btrim(qn.body) = ''

  UNION ALL
  SELECT r.quiz_id, 'WARN', 'question', qn.id, 'answer text is empty'
    FROM question qn JOIN round r ON r.id = qn.round_id
   WHERE btrim(qn.answer_text) = ''

  UNION ALL
  -- DIRECT only. Parts exist to drive bounce partial credit, and the engine
  -- touches question.parts nowhere else — a connect is scored by reveal stage
  -- and a written answer by a single verdict, so neither needs one. Without a
  -- part, BOUNCE_PARTIAL has nothing to credit and the question cannot yield
  -- partial marks.
  SELECT r.quiz_id, 'ERROR', 'question', qn.id, 'question has no parts (a simple question needs exactly one)'
    FROM question qn JOIN round r ON r.id = qn.round_id
   WHERE r.type = 'DIRECT'
     AND NOT EXISTS (SELECT 1 FROM question_part p WHERE p.question_id = qn.id)

  UNION ALL
  -- FORMAT_SPEC §2.2: four questions, displayed one at a time.
  SELECT r.quiz_id, 'ERROR', 'round', r.id,
         format('written round "%s" has %s questions; the format specifies 4', r.title, count(qn.id))
    FROM round r LEFT JOIN question qn ON qn.round_id = r.id
   WHERE r.type = 'WRITTEN'
   GROUP BY r.quiz_id, r.id, r.title HAVING count(qn.id) <> 4

  UNION ALL
  -- FORMAT_SPEC §2.3: a connect needs staged images to reveal, and no more of
  -- them than the quiz has scoring stages configured.
  SELECT r.quiz_id, 'ERROR', 'question', qn.id,
         format('connect question has %s reveal images but the quiz defines %s scoring stages',
                (SELECT count(*) FROM question_media m WHERE m.question_id = qn.id AND m.role = 'REVEAL'),
                (SELECT count(*) FROM connect_stage cs WHERE cs.quiz_id = r.quiz_id))
    FROM question qn JOIN round r ON r.id = qn.round_id
   WHERE r.type = 'VISUAL_CONNECT'
     AND (SELECT count(*) FROM question_media m WHERE m.question_id = qn.id AND m.role = 'REVEAL')
         NOT BETWEEN 1 AND (SELECT count(*) FROM connect_stage cs WHERE cs.quiz_id = r.quiz_id)

  UNION ALL
  -- FORMAT_SPEC §2.1: the starting team must actually be a seat at the table.
  SELECT r.quiz_id, 'ERROR', 'round', r.id,
         format('round "%s" starts at team position %s, which does not exist', r.title, r.starting_team_position)
    FROM round r
   WHERE r.starting_team_position IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM team t
                      WHERE t.quiz_id = r.quiz_id AND t.position = r.starting_team_position)

  UNION ALL
  -- ARCHITECTURE §4: clients preload local copies. An untranscoded asset is a
  -- question that will not play.
  SELECT a.quiz_id, 'WARN', 'media_asset', a.id,
         format('media asset "%s" is %s', coalesce(a.original_filename, a.storage_key), a.transcode_status)
    FROM media_asset a
   WHERE a.transcode_status IN ('PENDING','FAILED')
     AND EXISTS (SELECT 1 FROM question_media m WHERE m.asset_id = a.id);

COMMENT ON VIEW quiz_authoring_issue IS
  'Readiness checks that span rows and so cannot be CHECK constraints. The authoring UI queries this to answer "can this quiz be run?". ERROR blocks; WARN does not.';

COMMIT;
