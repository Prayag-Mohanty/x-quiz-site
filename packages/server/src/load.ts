/**
 * Loading one quiz out of Postgres.
 *
 * Extracted so the authoring routes and the room loader read the quiz the same
 * way. Assembly into the engine's nested types is @quizmaster/db's job; this
 * only fetches the rows.
 */

import type {
  ConnectStageRow,
  MediaAssetRow,
  QuestionMediaRow,
  QuestionPartRow,
  QuestionRow,
  QuizLoad,
  QuizRow,
  RoundRow,
  ScoreEventRow,
  TeamMemberRow,
  TeamRow,
} from '@quizmaster/db';

import { maybeOne, query } from './db.js';

export class QuizNotFound extends Error {
  constructor(quizId: string) {
    super(`No quiz ${quizId}`);
    this.name = 'QuizNotFound';
  }
}

export async function loadQuiz(quizId: string): Promise<QuizLoad> {
  const quiz = await maybeOne<QuizRow>('SELECT * FROM quiz WHERE id = $1', [quizId]);
  if (!quiz) throw new QuizNotFound(quizId);

  const [teams, teamMembers, rounds, questions, parts, questionMedia, assets, connectStages, ledger] =
    await Promise.all([
      query<TeamRow>('SELECT * FROM team WHERE quiz_id = $1', [quizId]),
      query<TeamMemberRow>(
        'SELECT m.* FROM team_member m JOIN team t ON t.id = m.team_id WHERE t.quiz_id = $1',
        [quizId],
      ),
      query<RoundRow>('SELECT * FROM round WHERE quiz_id = $1', [quizId]),
      query<QuestionRow>(
        'SELECT q.* FROM question q JOIN round r ON r.id = q.round_id WHERE r.quiz_id = $1',
        [quizId],
      ),
      query<QuestionPartRow>(
        `SELECT p.* FROM question_part p
           JOIN question q ON q.id = p.question_id
           JOIN round r ON r.id = q.round_id WHERE r.quiz_id = $1`,
        [quizId],
      ),
      query<QuestionMediaRow>(
        `SELECT m.* FROM question_media m
           JOIN question q ON q.id = m.question_id
           JOIN round r ON r.id = q.round_id WHERE r.quiz_id = $1`,
        [quizId],
      ),
      query<MediaAssetRow>('SELECT * FROM media_asset WHERE quiz_id = $1', [quizId]),
      query<ConnectStageRow>('SELECT * FROM connect_stage WHERE quiz_id = $1', [quizId]),
      // Ordered by seq: the ledger is a sequence and the breakdown reads in order.
      query<ScoreEventRow>('SELECT * FROM score_event WHERE quiz_id = $1 ORDER BY seq', [quizId]),
    ]);

  return {
    quiz,
    teams,
    teamMembers,
    rounds,
    questions,
    parts,
    questionMedia,
    assets,
    connectStages,
    ledger,
  };
}
