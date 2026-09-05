/**
 * Authoring API — Phase 0.
 *
 * Deliberately plain. This is the tool that stops you hand-editing JSON at 2am
 * before a quiz; it is not the live quiz surface. No auth yet (join codes land
 * in Phase 1), no websockets, no engine.
 *
 * Two things it takes seriously, because the schema does:
 *
 *   POSITIONS ARE CONTIGUOUS. Appending takes max(position)+1, and deleting
 *   renumbers what remains. For teams this is load-bearing — a team's index is
 *   its seat, and rotation walks those indices, so a gap silently breaks the
 *   bounce order. The renumber runs inside a transaction because the position
 *   uniques are DEFERRABLE and only checked at COMMIT.
 *
 *   CONSTRAINT VIOLATIONS ARE UI MESSAGES. The database enforces most of
 *   FORMAT_SPEC, so a rejected write usually means the QM tried something the
 *   format forbids. describeDbError turns those into a sentence rather than a
 *   500.
 */

import type { FastifyInstance } from 'fastify';
import { toQuizState } from '@quizmaster/db';
import type {
  AuthoringIssueRow,
  ConnectStageRow,
  MediaAssetRow,
  QuestionMediaRow,
  QuestionPartRow,
  QuestionRow,
  QuizRow,
  RoundRow,
  ScoreEventRow,
  TeamMemberRow,
  TeamRow,
} from '@quizmaster/db';

import { maybeOne, one, query, transaction } from './db.js';

/** FORMAT_SPEC §2.3 — the decay curve, seeded on quiz creation. */
const DEFAULT_CONNECT_STAGES = [
  { correct: 20, wrong: -15 },
  { correct: 15, wrong: -10 },
  { correct: 10, wrong: -5 },
  { correct: 5, wrong: 0 },
];

async function nextPosition(
  table: 'team' | 'round',
  parentColumn: 'quiz_id',
  parentId: string,
): Promise<number> {
  const row = await one<{ next: number }>(
    `SELECT coalesce(max(position) + 1, 0)::int AS next FROM ${table} WHERE ${parentColumn} = $1`,
    [parentId],
  );
  return row.next;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ─── Quizzes ──────────────────────────────────────────────────────────────

  app.get('/api/quizzes', async () =>
    query<QuizRow>('SELECT * FROM quiz ORDER BY created_at DESC'),
  );

  app.post<{ Body: { title?: string } }>('/api/quizzes', async (req, reply) => {
    const title = (req.body?.title ?? '').trim();
    if (!title) return reply.code(422).send({ message: 'A quiz needs a title.' });

    // Respond only AFTER the transaction commits. Sending from inside the
    // callback returns 201 while the COMMIT is still in flight, and the caller's
    // next request — on a different pooled connection — cannot see the row yet.
    const quiz = await transaction(async (client) => {
      const { rows } = await client.query<QuizRow>(
        'INSERT INTO quiz (title) VALUES ($1) RETURNING *',
        [title],
      );
      const created = rows[0];
      if (!created) throw new Error('INSERT returned no row');
      // Seeded here rather than as column defaults so a quiz with a different
      // decay curve is distinguishable from one nobody configured.
      for (const [i, stage] of DEFAULT_CONNECT_STAGES.entries()) {
        await client.query(
          'INSERT INTO connect_stage (quiz_id, position, correct, wrong) VALUES ($1, $2, $3, $4)',
          [created.id, i, stage.correct, stage.wrong],
        );
      }
      return created;
    });
    return reply.code(201).send(quiz);
  });

  /** Everything the authoring UI needs for one quiz, as rows it can edit. */
  app.get<{ Params: { id: string } }>('/api/quizzes/:id', async (req, reply) => {
    const { id } = req.params;
    const quiz = await maybeOne<QuizRow>('SELECT * FROM quiz WHERE id = $1', [id]);
    if (!quiz) return reply.code(404).send({ message: 'No such quiz.' });

    const [teams, teamMembers, rounds, questions, parts, questionMedia, assets, connectStages, issues] =
      await Promise.all([
        query<TeamRow>('SELECT * FROM team WHERE quiz_id = $1 ORDER BY position', [id]),
        query<TeamMemberRow>(
          'SELECT m.* FROM team_member m JOIN team t ON t.id = m.team_id WHERE t.quiz_id = $1 ORDER BY m.position',
          [id],
        ),
        query<RoundRow>('SELECT * FROM round WHERE quiz_id = $1 ORDER BY position', [id]),
        query<QuestionRow>(
          'SELECT q.* FROM question q JOIN round r ON r.id = q.round_id WHERE r.quiz_id = $1 ORDER BY q.position',
          [id],
        ),
        query<QuestionPartRow>(
          `SELECT p.* FROM question_part p
             JOIN question q ON q.id = p.question_id
             JOIN round r ON r.id = q.round_id
            WHERE r.quiz_id = $1 ORDER BY p.position`,
          [id],
        ),
        query<QuestionMediaRow>(
          `SELECT m.* FROM question_media m
             JOIN question q ON q.id = m.question_id
             JOIN round r ON r.id = q.round_id
            WHERE r.quiz_id = $1 ORDER BY m.position`,
          [id],
        ),
        query<MediaAssetRow>('SELECT * FROM media_asset WHERE quiz_id = $1', [id]),
        query<ConnectStageRow>(
          'SELECT * FROM connect_stage WHERE quiz_id = $1 ORDER BY position',
          [id],
        ),
        query<AuthoringIssueRow>('SELECT * FROM quiz_authoring_issue WHERE quiz_id = $1', [id]),
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
      issues,
    };
  });

  /**
   * The quiz as the engine would see it.
   *
   * Not used by the authoring UI — it exists so the mapping is exercised against
   * real rows rather than only against test literals, and so "does this quiz
   * actually load?" has an answer before a quiz night rather than during one.
   */
  app.get<{ Params: { id: string } }>('/api/quizzes/:id/state', async (req, reply) => {
    const { id } = req.params;
    const quiz = await maybeOne<QuizRow>('SELECT * FROM quiz WHERE id = $1', [id]);
    if (!quiz) return reply.code(404).send({ message: 'No such quiz.' });

    const [teams, teamMembers, rounds, questions, parts, questionMedia, assets, connectStages, ledger] =
      await Promise.all([
        query<TeamRow>('SELECT * FROM team WHERE quiz_id = $1', [id]),
        query<TeamMemberRow>(
          'SELECT m.* FROM team_member m JOIN team t ON t.id = m.team_id WHERE t.quiz_id = $1',
          [id],
        ),
        query<RoundRow>('SELECT * FROM round WHERE quiz_id = $1', [id]),
        query<QuestionRow>(
          'SELECT q.* FROM question q JOIN round r ON r.id = q.round_id WHERE r.quiz_id = $1',
          [id],
        ),
        query<QuestionPartRow>(
          `SELECT p.* FROM question_part p
             JOIN question q ON q.id = p.question_id
             JOIN round r ON r.id = q.round_id WHERE r.quiz_id = $1`,
          [id],
        ),
        query<QuestionMediaRow>(
          `SELECT m.* FROM question_media m
             JOIN question q ON q.id = m.question_id
             JOIN round r ON r.id = q.round_id WHERE r.quiz_id = $1`,
          [id],
        ),
        query<MediaAssetRow>('SELECT * FROM media_asset WHERE quiz_id = $1', [id]),
        query<ConnectStageRow>('SELECT * FROM connect_stage WHERE quiz_id = $1', [id]),
        query<ScoreEventRow>('SELECT * FROM score_event WHERE quiz_id = $1 ORDER BY seq', [id]),
      ]);

    // Phase 2 swaps this for a signed R2 URL. Phase 0 stores files locally.
    const resolveUrl = (a: MediaAssetRow) => a.url ?? `/media/${a.storage_key}`;

    return toQuizState(
      { quiz, teams, teamMembers, rounds, questions, parts, questionMedia, assets, connectStages, ledger },
      resolveUrl,
    );
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/quizzes/:id',
    async (req, reply) => {
      const allowed = [
        'title', 'status',
        'direct_pounce_correct', 'direct_pounce_wrong', 'direct_bounce_correct',
        'direct_bounce_wrong', 'direct_question_value',
        'written_correct', 'written_wrong', 'written_stake_correct', 'written_stake_wrong',
        'rule_pouncers_may_bounce', 'rule_multiple_stakes_allowed',
        'rule_connect_bounces_after_final_reveal',
      ];
      const updated = await updateRow('quiz', req.params.id, req.body, allowed);
      if (!updated) return reply.code(404).send({ message: 'No such quiz.' });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/quizzes/:id', async (req, reply) => {
    // Blocked by ON DELETE RESTRICT once anything has been scored — archive instead.
    const row = await maybeOne<QuizRow>('DELETE FROM quiz WHERE id = $1 RETURNING *', [
      req.params.id,
    ]);
    if (!row) return reply.code(404).send({ message: 'No such quiz.' });
    return reply.code(204).send();
  });

  // ─── Teams ────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/quizzes/:id/teams',
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim();
      if (!name) return reply.code(422).send({ message: 'A team needs a name.' });
      const position = await nextPosition('team', 'quiz_id', req.params.id);
      const row = await one<TeamRow>(
        'INSERT INTO team (quiz_id, position, name) VALUES ($1, $2, $3) RETURNING *',
        [req.params.id, position, name],
      );
      return reply.code(201).send(row);
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/teams/:id',
    async (req, reply) => {
      const updated = await updateRow('team', req.params.id, req.body, ['name']);
      if (!updated) return reply.code(404).send({ message: 'No such team.' });
      return updated;
    },
  );

  /**
   * Deleting a team renumbers the rest.
   *
   * A gap in team positions silently breaks rotation — the readiness view flags
   * it and the mapper refuses to load it, but neither should ever see one.
   */
  app.delete<{ Params: { id: string } }>('/api/teams/:id', async (req, reply) => {
    const removed = await transaction(async (client) => {
      const { rows } = await client.query<TeamRow>(
        'DELETE FROM team WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      const team = rows[0];
      if (!team) return null;
      await client.query(
        'UPDATE team SET position = position - 1 WHERE quiz_id = $1 AND position > $2',
        [team.quiz_id, team.position],
      );
      return team;
    });
    if (!removed) return reply.code(404).send({ message: 'No such team.' });
    return reply.code(204).send();
  });

  /** Reseat the whole table at once. Body is team ids in their new order. */
  app.post<{ Params: { id: string }; Body: { order?: string[] } }>(
    '/api/quizzes/:id/teams/reorder',
    async (req, reply) => {
      const order = req.body?.order ?? [];
      const existing = await query<TeamRow>('SELECT id FROM team WHERE quiz_id = $1', [
        req.params.id,
      ]);
      if (order.length !== existing.length) {
        return reply.code(422).send({
          message: 'Reordering must list every team exactly once — seats have to stay contiguous.',
        });
      }
      await transaction(async (client) => {
        // Legal in one transaction only because the position unique is DEFERRABLE.
        for (const [i, teamId] of order.entries()) {
          await client.query('UPDATE team SET position = $1 WHERE id = $2 AND quiz_id = $3', [
            i,
            teamId,
            req.params.id,
          ]);
        }
      });
      return query<TeamRow>('SELECT * FROM team WHERE quiz_id = $1 ORDER BY position', [
        req.params.id,
      ]);
    },
  );

  // ─── Rounds ───────────────────────────────────────────────────────────────

  app.post<{
    Params: { id: string };
    Body: { type?: string; title?: string; direction?: string | null };
  }>('/api/quizzes/:id/rounds', async (req, reply) => {
    const type = req.body?.type ?? 'DIRECT';
    const title = (req.body?.title ?? '').trim();
    if (!title) return reply.code(422).send({ message: 'A round needs a title.' });

    // FORMAT_SPEC 2.1: direction is a DIRECT-round concept. Reject it elsewhere
    // rather than silently dropping it -- a caller sending one has misunderstood
    // something, and quietly discarding the field hides that until the round
    // bounces in an order nobody expected.
    if (type !== 'DIRECT' && req.body?.direction) {
      return reply
        .code(422)
        .send({ message: 'Only a DIRECT round has a direction — pounce and bounce order.' });
    }
    const direction = type === 'DIRECT' ? (req.body?.direction ?? 'CW') : null;
    const position = await nextPosition('round', 'quiz_id', req.params.id);
    const row = await one<RoundRow>(
      'INSERT INTO round (quiz_id, position, type, title, direction) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.params.id, position, type, title, direction],
    );
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/rounds/:id',
    async (req, reply) => {
      const updated = await updateRow('round', req.params.id, req.body, [
        'title',
        'direction',
        'starting_team_position',
      ]);
      if (!updated) return reply.code(404).send({ message: 'No such round.' });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/rounds/:id', async (req, reply) => {
    const removed = await transaction(async (client) => {
      const { rows } = await client.query<RoundRow>(
        'DELETE FROM round WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      const round = rows[0];
      if (!round) return null;
      await client.query(
        'UPDATE round SET position = position - 1 WHERE quiz_id = $1 AND position > $2',
        [round.quiz_id, round.position],
      );
      return round;
    });
    if (!removed) return reply.code(404).send({ message: 'No such round.' });
    return reply.code(204).send();
  });

  // ─── Questions ────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { body?: string } }>(
    '/api/rounds/:id/questions',
    async (req, reply) => {
      const round = await maybeOne<RoundRow>('SELECT * FROM round WHERE id = $1', [req.params.id]);
      if (!round) return reply.code(404).send({ message: 'No such round.' });

      const question = await transaction(async (client) => {
        const { rows: posRows } = await client.query<{ next: number }>(
          'SELECT coalesce(max(position) + 1, 0)::int AS next FROM question WHERE round_id = $1',
          [round.id],
        );
        const position = posRows[0]?.next ?? 0;
        const { rows } = await client.query<QuestionRow>(
          `INSERT INTO question (round_id, round_type, position, body)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [round.id, round.type, position, req.body?.body ?? ''],
        );
        const created = rows[0];
        if (!created) throw new Error('INSERT returned no row');
        // A DIRECT question needs at least one part to be scorable, so give it
        // one up front rather than making the QM discover the rule later.
        if (round.type === 'DIRECT') {
          await client.query(
            `INSERT INTO question_part (question_id, position, label) VALUES ($1, 0, $2)`,
            [created.id, 'Answer'],
          );
        }
        return created;
      });
      return reply.code(201).send(question);
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/questions/:id',
    async (req, reply) => {
      const updated = await updateRow('question', req.params.id, req.body, [
        'body',
        'answer_text',
        'qm_notes',
      ]);
      if (!updated) return reply.code(404).send({ message: 'No such question.' });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/questions/:id', async (req, reply) => {
    const removed = await transaction(async (client) => {
      const { rows } = await client.query<QuestionRow>(
        'DELETE FROM question WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      const question = rows[0];
      if (!question) return null;
      await client.query(
        'UPDATE question SET position = position - 1 WHERE round_id = $1 AND position > $2',
        [question.round_id, question.position],
      );
      return question;
    });
    if (!removed) return reply.code(404).send({ message: 'No such question.' });
    return reply.code(204).send();
  });

  // ─── Parts ────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { label?: string } }>(
    '/api/questions/:id/parts',
    async (req, reply) => {
      const part = await transaction(async (client) => {
        const { rows: posRows } = await client.query<{ next: number }>(
          'SELECT coalesce(max(position) + 1, 0)::int AS next FROM question_part WHERE question_id = $1',
          [req.params.id],
        );
        const position = posRows[0]?.next ?? 0;
        const { rows } = await client.query<QuestionPartRow>(
          'INSERT INTO question_part (question_id, position, label) VALUES ($1, $2, $3) RETURNING *',
          [req.params.id, position, req.body?.label ?? `Part ${position + 1}`],
        );
        return rows[0];
      });
      return reply.code(201).send(part);
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/parts/:id',
    async (req, reply) => {
      const updated = await updateRow('question_part', req.params.id, req.body, [
        'label',
        'canonical_answer',
        'partial_value',
        'accepted_variants',
      ]);
      if (!updated) return reply.code(404).send({ message: 'No such part.' });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/parts/:id', async (req, reply) => {
    const removed = await transaction(async (client) => {
      const { rows } = await client.query<QuestionPartRow>(
        'DELETE FROM question_part WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      const part = rows[0];
      if (!part) return null;
      await client.query(
        'UPDATE question_part SET position = position - 1 WHERE question_id = $1 AND position > $2',
        [part.question_id, part.position],
      );
      return part;
    });
    if (!removed) return reply.code(404).send({ message: 'No such part.' });
    return reply.code(204).send();
  });

  // ─── Readiness ────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/api/quizzes/:id/issues', async (req) =>
    query<AuthoringIssueRow>('SELECT * FROM quiz_authoring_issue WHERE quiz_id = $1', [
      req.params.id,
    ]),
  );
}

/**
 * Generic PATCH against an allow-list.
 *
 * The allow-list is what keeps a request body from writing to `id` or `position`
 * — never interpolate a caller-supplied column name into SQL.
 */
async function updateRow<T>(
  table: string,
  id: string,
  body: Record<string, unknown>,
  allowed: readonly string[],
): Promise<T | null> {
  const fields = Object.keys(body).filter((k) => allowed.includes(k));
  if (fields.length === 0) return maybeOne<T>(`SELECT * FROM ${table} WHERE id = $1`, [id]);

  const assignments = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map((f) => body[f]);
  return maybeOne<T>(
    `UPDATE ${table} SET ${assignments} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
}
