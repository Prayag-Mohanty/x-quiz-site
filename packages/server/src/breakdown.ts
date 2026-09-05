/**
 * The post-quiz breakdown.
 *
 * One GET, read straight out of Postgres. Deliberately not the live socket: by
 * the time anyone wants this the quiz is over, the room has been evicted, and
 * rebuilding a room to answer "what did Team 6 write?" would be absurd.
 *
 * It reads the views in 002_runtime.sql rather than recomputing anything —
 * those mirror scoring.ts, and if one ever disagrees, scoring.ts wins and the
 * view is the bug. Nothing here does arithmetic the engine has already done.
 *
 * ─── Why this one endpoint has auth when the authoring API does not ─────────
 *
 * The report carries canonical answers and every team's pounce text. The quiz
 * id is not a secret — it is in the public scoreboard URL — so an unguarded
 * endpoint here would hand the answers to anyone who opened the scoreboard and
 * changed the path. The quizmaster's token is the thing not everybody has.
 */

import type { FastifyInstance } from 'fastify';
import type {
  BreakdownEvent,
  BreakdownReport,
  BreakdownStanding,
  BreakdownSubmission,
} from '@quizmaster/shared';

import { maybeOne, query } from './db.js';

interface StandingRow {
  team_id: string;
  name: string;
  position: number;
  score: string;
  pounces_correct: string;
  pounces_wrong: string;
  pounces_attempted: string;
  withheld_points: string;
}

interface EventRow {
  team_id: string;
  team_name: string;
  round_position: number;
  round_title: string;
  question_position: number | null;
  question_body: string | null;
  points: number;
  reason: string;
  status: 'PENDING' | 'APPLIED' | 'VOIDED';
  note: string | null;
}

interface SubmissionRow {
  team_id: string;
  team_name: string;
  round_position: number;
  round_title: string;
  question_position: number;
  question_body: string;
  answer_text: string | null;
  kind: 'POUNCE' | 'WRITTEN';
  stage_idx: number | null;
  staked: boolean;
  body: string;
  verdict: 'CORRECT' | 'WRONG' | null;
}

/**
 * Whether this request may read the report.
 *
 * Two keys open it: the quiz's own quizmaster token — the long one in the
 * console link — or a live QM session token, so a quizmaster who still has the
 * console open does not have to go and find the other one. A team session has
 * a team_id and is refused; a team reading the canonical answers is the exact
 * thing this check exists to prevent.
 */
async function authorised(quizId: string, token: string): Promise<boolean> {
  if (!token) return false;
  const byQuizToken = await maybeOne<{ id: string }>(
    'SELECT id FROM quiz WHERE id = $1 AND qm_token = $2',
    [quizId, token],
  );
  if (byQuizToken) return true;
  const bySession = await maybeOne<{ id: string }>(
    'SELECT id FROM session WHERE token = $1 AND quiz_id = $2 AND team_id IS NULL',
    [token, quizId],
  );
  return Boolean(bySession);
}

export async function buildBreakdown(quizId: string): Promise<BreakdownReport | null> {
  const quiz = await maybeOne<{ id: string; title: string; status: string }>(
    'SELECT id, title, status FROM quiz WHERE id = $1',
    [quizId],
  );
  if (!quiz) return null;

  // team_standing already carries the tiebreak signals (§3). withheld_points is
  // the one thing it does not: points recorded and never revealed, which is a
  // mistake in the running of the quiz rather than a property of the scoring.
  const standingRows = await query<StandingRow>(
    `SELECT s.team_id, s.name, t.position, s.score,
            s.pounces_correct, s.pounces_wrong, s.pounces_attempted,
            coalesce((SELECT sum(e.points) FROM score_event e
                       WHERE e.team_id = s.team_id AND e.status = 'PENDING'), 0)
              AS withheld_points
       FROM team_standing s
       JOIN team t ON t.id = s.team_id
      WHERE s.quiz_id = $1
      ORDER BY t.position`,
    [quizId],
  );

  const roundRows = await query<{ id: string; title: string; type: string; position: number }>(
    'SELECT id, title, type, position FROM round WHERE quiz_id = $1 ORDER BY position',
    [quizId],
  );

  const eventRows = await query<EventRow>(
    `SELECT b.team_id, t.name AS team_name,
            b.round_position, r.title AS round_title,
            b.question_position, q.body AS question_body,
            b.points, b.reason, b.status, b.note
       FROM team_breakdown b
       JOIN team t  ON t.id = b.team_id
       JOIN round r ON r.id = b.round_id
       LEFT JOIN question q ON q.id = b.question_id
      WHERE b.quiz_id = $1
      ORDER BY b.seq`,
    [quizId],
  );

  // Two projections, one shape. UNION rather than two round trips because the
  // report reads as one list — a team's connect pounce and its written sheet
  // are the same question asked of the same team.
  const submissionRows = await query<SubmissionRow>(
    `SELECT p.team_id, t.name AS team_name,
            r.position AS round_position, r.title AS round_title,
            q.position AS question_position, q.body AS question_body,
            q.answer_text,
            'POUNCE'::text AS kind,
            p.stage_idx,
            false AS staked,
            p.body,
            p.verdict
       FROM pounce_submission p
       JOIN team t     ON t.id = p.team_id
       JOIN question q ON q.id = p.question_id
       JOIN round r    ON r.id = q.round_id
      WHERE t.quiz_id = $1
      UNION ALL
     SELECT w.team_id, t.name,
            r.position, r.title,
            q.position, q.body,
            q.answer_text,
            'WRITTEN'::text,
            NULL::integer,
            w.staked,
            w.body,
            w.verdict
       FROM written_answer w
       JOIN team t     ON t.id = w.team_id
       JOIN question q ON q.id = w.question_id
       JOIN round r    ON r.id = q.round_id
      WHERE t.quiz_id = $1
      ORDER BY round_position, question_position, team_name`,
    [quizId],
  );

  const standings: BreakdownStanding[] = standingRows.map((r) => ({
    teamId: r.team_id,
    name: r.name,
    seat: r.position,
    score: Number(r.score),
    pouncesAttempted: Number(r.pounces_attempted),
    pouncesCorrect: Number(r.pounces_correct),
    pouncesWrong: Number(r.pounces_wrong),
    withheldPoints: Number(r.withheld_points),
  }));

  const events: BreakdownEvent[] = eventRows.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    roundIndex: r.round_position,
    roundTitle: r.round_title,
    questionIndex: r.question_position,
    questionText: r.question_body,
    points: r.points,
    reason: r.reason,
    status: r.status,
    note: r.note,
  }));

  const submissions: BreakdownSubmission[] = submissionRows.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    roundIndex: r.round_position,
    roundTitle: r.round_title,
    questionIndex: r.question_position,
    questionText: r.question_body,
    answerText: r.answer_text ?? '',
    kind: r.kind,
    stageIdx: r.stage_idx,
    staked: r.staked,
    body: r.body,
    verdict: r.verdict,
  }));

  return {
    quiz,
    generatedAt: new Date().toISOString(),
    standings,
    rounds: roundRows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      index: r.position,
    })),
    events,
    submissions,
  };
}

export async function registerBreakdownRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Headers: { 'x-qm-token'?: string } }>(
    '/api/quizzes/:id/breakdown',
    async (req, reply) => {
      // Header rather than a query parameter: the report is the answers, and a
      // token in a URL ends up in history, in logs and in a shared screenshot.
      const token = (req.headers['x-qm-token'] ?? '').toString().trim();
      if (!(await authorised(req.params.id, token))) {
        // Same message whether the quiz is missing or the token is wrong. A
        // different 404 would confirm which quiz ids exist.
        return reply
          .code(403)
          .send({ message: 'That is not the quizmaster token for this quiz.' });
      }

      const report = await buildBreakdown(req.params.id);
      if (!report) {
        return reply
          .code(403)
          .send({ message: 'That is not the quizmaster token for this quiz.' });
      }
      return report;
    },
  );
}
