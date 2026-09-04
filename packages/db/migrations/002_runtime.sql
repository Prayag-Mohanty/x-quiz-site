-- ============================================================================
-- 002_runtime.sql — the score ledger, the action log, and submissions.
--
-- This is Phase 1's data, not Phase 0's. It is designed now because the ledger
-- is an architectural invariant (CLAUDE.md invariant 2) and ARCHITECTURE §2 is
-- explicit that pending points, undo and the post-quiz breakdown are the three
-- things you would otherwise have to retrofit. Retrofitting an append-only
-- ledger onto a mutable integer is a rewrite.
--
-- Nothing in Phase 0 writes to these tables. Apply the migration anyway; an
-- empty ledger costs nothing.
-- ============================================================================

BEGIN;

-- ─── score_event ────────────────────────────────────────────────────────────
-- Maps ScoreEvent. The engine's ScoreEvent has no quizId; it is denormalised
-- here for queries, and pinned to the truth by composite FKs — a score event
-- cannot reference a round from one quiz and a team from another.
--
-- The engine is pure and passes no timestamps, so the timestamps are the DB's
-- job. That division is correct and should stay: the reducer stays replayable,
-- the ledger stays auditable.

CREATE TABLE score_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Append order. The engine's ledger is an array and order is observable in
  -- the breakdown; an identity column preserves it independently of clock skew.
  seq         bigint GENERATED ALWAYS AS IDENTITY,

  quiz_id     uuid NOT NULL,
  team_id     uuid NOT NULL,
  round_id    uuid NOT NULL,
  -- Nullable. MANUAL_ADJUST can be made between questions, where the engine
  -- currently writes questionId: ''. Empty string is not a foreign key; NULL is
  -- the honest representation. See docs/DATA_MODEL.md, discrepancy 4.
  question_id uuid,

  points      integer NOT NULL,
  reason      text NOT NULL CHECK (reason IN (
                'POUNCE_CORRECT','POUNCE_WRONG','BOUNCE_CORRECT','PARTIAL',
                'WRITTEN_CORRECT','STAKE_CORRECT','STAKE_WRONG',
                'CONNECT_CORRECT','CONNECT_WRONG','TIEBREAK','MANUAL_ADJUST')),
  -- PENDING — recorded, withheld from the public scoreboard.
  -- APPLIED  — counts.
  -- VOIDED   — undone by the QM, retained for audit.
  status      text NOT NULL DEFAULT 'APPLIED'
                CHECK (status IN ('PENDING','APPLIED','VOIDED')),
  note        text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz,
  voided_at   timestamptz,
  created_by  text,

  FOREIGN KEY (team_id, quiz_id)  REFERENCES team  (id, quiz_id) ON DELETE RESTRICT,
  FOREIGN KEY (round_id, quiz_id) REFERENCES round (id, quiz_id) ON DELETE RESTRICT,
  -- MATCH SIMPLE: when question_id is NULL the constraint is satisfied, which
  -- is exactly the between-questions MANUAL_ADJUST case.
  FOREIGN KEY (question_id, round_id) REFERENCES question (id, round_id) ON DELETE RESTRICT,

  CONSTRAINT score_event_applied_at_present
    CHECK (status <> 'APPLIED' OR applied_at IS NOT NULL),
  CONSTRAINT score_event_pending_not_applied
    CHECK (status <> 'PENDING' OR applied_at IS NULL),
  CONSTRAINT score_event_voided_at_iff_voided
    CHECK ((status = 'VOIDED') = (voided_at IS NOT NULL)),
  -- FORMAT_SPEC §2.1: withholding exists for one reason — a confirmed part must
  -- not be inferable from a score change before the reveal. Nothing else is
  -- ever withheld. Drop this constraint if that stops being true.
  CONSTRAINT spec_2_1_only_partials_are_withheld
    CHECK (status <> 'PENDING' OR reason = 'PARTIAL'),
  -- The action carries a required note; the ledger's value as an audit trail
  -- depends on it. "Why is Team 4 on 63?" is asked after every quiz.
  CONSTRAINT score_event_manual_adjust_needs_note
    CHECK (reason <> 'MANUAL_ADJUST' OR (note IS NOT NULL AND btrim(note) <> ''))
);

CREATE INDEX score_event_quiz_status_idx ON score_event (quiz_id, status);
CREATE INDEX score_event_team_idx        ON score_event (team_id);
CREATE INDEX score_event_question_idx    ON score_event (question_id);
CREATE INDEX score_event_round_idx       ON score_event (round_id);
-- The reveal step flips every PENDING row for one question.
CREATE INDEX score_event_pending_idx     ON score_event (question_id) WHERE status = 'PENDING';

-- FORMAT_SPEC §2.1 (one pounce per team per question) and §2.3 (one pounce per
-- team per QUESTION, not per reveal — a team that has pounced is out for the
-- rest of that connect). The engine tracks this in state; this makes it true of
-- the stored data as well. Scoped to non-voided rows so that an undo followed
-- by a re-award is legal.
-- (Index and constraint names share one namespace per schema, hence the
-- table-qualified name; pounce_submission enforces the same rule below.)
CREATE UNIQUE INDEX score_event_one_pounce_per_team_question
  ON score_event (question_id, team_id)
  WHERE status <> 'VOIDED'
    AND reason IN ('POUNCE_CORRECT','POUNCE_WRONG','CONNECT_CORRECT','CONNECT_WRONG');

-- ─── The ledger is append-only, enforced ────────────────────────────────────
-- CLAUDE.md invariant 2 is the reason this project exists in its current shape.
-- Enforce it in the database, not by convention: a stray UPDATE on points during
-- a live quiz produces a scoreboard nobody can reconstruct afterwards.
--
-- Legal mutations: status PENDING -> APPLIED (reveal), PENDING/APPLIED -> VOIDED
-- (undo), and the QM's note. Everything else is immutable, and rows never die.

CREATE OR REPLACE FUNCTION score_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'score_event is append-only: void the event, do not delete it (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id         IS DISTINCT FROM OLD.id
  OR NEW.seq        IS DISTINCT FROM OLD.seq
  OR NEW.quiz_id    IS DISTINCT FROM OLD.quiz_id
  OR NEW.team_id    IS DISTINCT FROM OLD.team_id
  OR NEW.round_id   IS DISTINCT FROM OLD.round_id
  OR NEW.question_id IS DISTINCT FROM OLD.question_id
  OR NEW.points     IS DISTINCT FROM OLD.points
  OR NEW.reason     IS DISTINCT FROM OLD.reason
  OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'score_event is immutable except status and note (id=%): to correct an award, void it and append a new one', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('APPLIED','VOIDED'))
         OR (OLD.status = 'APPLIED' AND NEW.status = 'VOIDED')) THEN
      RAISE EXCEPTION 'illegal score_event status transition % -> % (id=%)', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Timestamps are the DB's job; the reducer has no clock.
  IF NEW.status = 'APPLIED' AND NEW.applied_at IS NULL THEN
    NEW.applied_at := now();
  END IF;
  IF NEW.status = 'VOIDED' AND NEW.voided_at IS NULL THEN
    NEW.voided_at := now();
  END IF;

  RETURN NEW;
END $fn$;

CREATE TRIGGER score_event_append_only
  BEFORE UPDATE OR DELETE ON score_event
  FOR EACH ROW EXECUTE FUNCTION score_event_append_only();

CREATE OR REPLACE FUNCTION score_event_set_applied_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status = 'APPLIED' AND NEW.applied_at IS NULL THEN
    NEW.applied_at := now();
  END IF;
  IF NEW.status = 'VOIDED' AND NEW.voided_at IS NULL THEN
    NEW.voided_at := now();
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER score_event_set_applied_at
  BEFORE INSERT ON score_event
  FOR EACH ROW EXECUTE FUNCTION score_event_set_applied_at();

-- Row-level triggers do not fire on TRUNCATE, which would otherwise be a way to
-- erase the audit trail by accident.
CREATE OR REPLACE FUNCTION score_event_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'score_event is append-only and cannot be truncated'
    USING ERRCODE = 'restrict_violation';
END $fn$;

CREATE TRIGGER score_event_no_truncate
  BEFORE TRUNCATE ON score_event
  FOR EACH STATEMENT EXECUTE FUNCTION score_event_no_truncate();

-- ─── quiz_action ────────────────────────────────────────────────────────────
-- The QM's intents, in order. The reducer is pure, so replaying this log from
-- the initial state reproduces the exact quiz state — which is what makes crash
-- recovery and "the server restarted mid-round" survivable rather than fatal.
-- ARCHITECTURE §8: room state lives in memory; this is the durability behind it.
--
-- seq is assigned by the server (the in-memory room owns the counter). The
-- primary key doubles as the concurrency check: two writers cannot both claim
-- seq N, so a split-brain room fails loudly on insert instead of silently
-- diverging.

CREATE TABLE quiz_action (
  quiz_id    uuid NOT NULL REFERENCES quiz(id) ON DELETE RESTRICT,
  seq        bigint NOT NULL CHECK (seq >= 0),
  action     jsonb NOT NULL,
  -- Denormalised from action->>'type' for querying the log without unpacking.
  type       text NOT NULL CHECK (length(type) > 0),
  actor      text,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (quiz_id, seq)
);

CREATE INDEX quiz_action_type_idx ON quiz_action (quiz_id, type);

-- Replay from seq 0 is correct but gets slower as the quiz runs. A snapshot is
-- the fast path: load the latest snapshot, replay only the actions after it.
CREATE TABLE quiz_snapshot (
  quiz_id    uuid NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  -- State after applying every action with seq <= this.
  seq        bigint NOT NULL CHECK (seq >= 0),
  state      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (quiz_id, seq)
);

-- ─── Submissions ────────────────────────────────────────────────────────────
-- Projections of SUBMIT_POUNCE / SUBMIT_WRITTEN from the action log, kept as
-- tables because "what did Team 6 actually write?" is a question asked after
-- every quiz and answering it by unpacking JSONB is miserable. They can be
-- rebuilt from quiz_action at any time; the log is the source of truth.

CREATE TABLE pounce_submission (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id  uuid NOT NULL REFERENCES question(id) ON DELETE RESTRICT,
  team_id      uuid NOT NULL REFERENCES team(id) ON DELETE RESTRICT,
  -- VISUAL_CONNECT: which reveal stage the pounce came in at. NULL for DIRECT.
  stage_idx    integer CHECK (stage_idx IS NULL OR stage_idx >= 0),
  body         text NOT NULL,
  verdict      text CHECK (verdict IN ('CORRECT','WRONG')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  evaluated_at timestamptz,

  -- FORMAT_SPEC §2.1 and §2.3: one pounce per team per question, in both round
  -- types. In a connect this is the rule that makes an early guess expensive.
  CONSTRAINT pounce_submission_one_per_team_question UNIQUE (question_id, team_id),
  CONSTRAINT pounce_evaluated_at_iff_verdict
    CHECK ((verdict IS NULL) = (evaluated_at IS NULL))
);

CREATE INDEX pounce_submission_team_idx ON pounce_submission (team_id);

CREATE TABLE written_answer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id  uuid NOT NULL REFERENCES question(id) ON DELETE RESTRICT,
  team_id      uuid NOT NULL REFERENCES team(id) ON DELETE RESTRICT,
  body         text NOT NULL DEFAULT '',
  -- FORMAT_SPEC §2.2: +15/-5. Declared at submission, locked when the round
  -- closes. locked_at is what "locked" means physically.
  staked       boolean NOT NULL DEFAULT false,
  verdict      text CHECK (verdict IN ('CORRECT','WRONG')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  evaluated_at timestamptz,

  CONSTRAINT written_answer_one_per_team_question UNIQUE (question_id, team_id),
  CONSTRAINT written_evaluated_at_iff_verdict
    CHECK ((verdict IS NULL) = (evaluated_at IS NULL))
);

CREATE INDEX written_answer_team_idx ON written_answer (team_id);

-- ─── Derived views ──────────────────────────────────────────────────────────
-- These mirror packages/engine/src/scoring.ts exactly. The engine computes them
-- live from its in-memory ledger; these are for the post-quiz breakdown and for
-- anything that reads the database directly. If one of them ever disagrees with
-- scoring.ts, scoring.ts wins and the view is the bug.

-- publicScore(): APPLIED only. PENDING partials are deliberately excluded —
-- that exclusion is the whole point of the PENDING status (FORMAT_SPEC §2.1).
CREATE VIEW team_score AS
  SELECT t.quiz_id,
         t.id AS team_id,
         t.name,
         t.position,
         coalesce(sum(e.points) FILTER (WHERE e.status = 'APPLIED'), 0)  AS public_score,
         coalesce(sum(e.points) FILTER (WHERE e.status <> 'VOIDED'), 0)  AS provisional_score,
         count(*) FILTER (WHERE e.status = 'PENDING')                    AS withheld_events
    FROM team t
    LEFT JOIN score_event e ON e.team_id = t.id
   GROUP BY t.quiz_id, t.id, t.name, t.position;

COMMENT ON VIEW team_score IS
  'public_score is what teams see; provisional_score is what the QM sees, including withheld partials. Never store either.';

-- standings(): score plus the tiebreak signals. FORMAT_SPEC §3 — the system
-- displays these; it does not resolve ties. No ORDER BY beyond score for that
-- reason: any further ordering would look like a ruling.
CREATE VIEW team_standing AS
  SELECT s.quiz_id,
         s.team_id,
         s.name,
         s.public_score AS score,
         count(e.id) FILTER (WHERE e.status <> 'VOIDED'
                               AND e.reason IN ('POUNCE_CORRECT','CONNECT_CORRECT')) AS pounces_correct,
         count(e.id) FILTER (WHERE e.status <> 'VOIDED'
                               AND e.reason IN ('POUNCE_WRONG','CONNECT_WRONG'))     AS pounces_wrong,
         count(e.id) FILTER (WHERE e.status <> 'VOIDED'
                               AND e.reason IN ('POUNCE_CORRECT','CONNECT_CORRECT',
                                                'POUNCE_WRONG','CONNECT_WRONG'))     AS pounces_attempted
    FROM team_score s
    LEFT JOIN score_event e ON e.team_id = s.team_id
   GROUP BY s.quiz_id, s.team_id, s.name, s.public_score;

-- breakdown(): where a team's points came from. Teams always ask.
CREATE VIEW team_breakdown AS
  SELECT e.quiz_id, e.team_id, e.seq, e.round_id, e.question_id,
         r.position AS round_position, q.position AS question_position,
         e.points, e.reason, e.status, e.note, e.created_at
    FROM score_event e
    JOIN round r ON r.id = e.round_id
    LEFT JOIN question q ON q.id = e.question_id
   WHERE e.status <> 'VOIDED'
   ORDER BY e.quiz_id, e.team_id, e.seq;

COMMIT;
