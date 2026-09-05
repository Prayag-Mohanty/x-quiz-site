/**
 * Typed wrapper over the authoring API.
 *
 * Row types come from @quizmaster/db as `import type`, so they are erased at
 * build time and the client carries no runtime dependency on the database
 * package. One definition of a row, three packages agreeing on it.
 */

import type {
  AuthoringIssueRow,
  ConnectStageRow,
  MediaAssetRow,
  QuestionMediaRow,
  QuestionPartRow,
  QuestionRow,
  QuizRow,
  RoundRow,
  TeamMemberRow,
  TeamRow,
} from '@quizmaster/db';

export type {
  AuthoringIssueRow,
  QuestionPartRow,
  QuestionRow,
  QuizRow,
  RoundRow,
  TeamRow,
};

/** Everything the editor needs for one quiz. */
export interface QuizDetail {
  quiz: QuizRow;
  teams: TeamRow[];
  teamMembers: TeamMemberRow[];
  rounds: RoundRow[];
  questions: QuestionRow[];
  parts: QuestionPartRow[];
  questionMedia: QuestionMediaRow[];
  assets: MediaAssetRow[];
  connectStages: ConnectStageRow[];
  issues: AuthoringIssueRow[];
}

/**
 * A rejected write is usually the schema enforcing FORMAT_SPEC, and the server
 * turns those into a sentence. Carry it through rather than throwing "500".
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The admin token, when the server is running somewhere other than this laptop.
 *
 * Unset is the normal case: a server on localhost lets the machine it runs on
 * edit without one. It only appears once ADMIN_TOKEN is set on the server,
 * which is what a quizmaster does before exposing it to a network — see
 * packages/server/src/access.ts.
 */
const ADMIN_TOKEN_KEY = 'quizmaster.adminToken';

export function adminToken(): string {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // A browser with storage blocked can still author for one session.
  }
}

function authHeaders(): Record<string, string> {
  const token = adminToken();
  return token ? { 'x-admin-token': token } : {};
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...authHeaders(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return parsed as T;
}

export const api = {
  listQuizzes: () => request<QuizRow[]>('GET', '/api/quizzes'),
  createQuiz: (title: string) => request<QuizRow>('POST', '/api/quizzes', { title }),
  getQuiz: (id: string) => request<QuizDetail>('GET', `/api/quizzes/${id}`),
  updateQuiz: (id: string, patch: Record<string, unknown>) =>
    request<QuizRow>('PATCH', `/api/quizzes/${id}`, patch),
  deleteQuiz: (id: string) => request<void>('DELETE', `/api/quizzes/${id}`),

  addTeam: (quizId: string, name: string) =>
    request<TeamRow>('POST', `/api/quizzes/${quizId}/teams`, { name }),
  updateTeam: (id: string, patch: Record<string, unknown>) =>
    request<TeamRow>('PATCH', `/api/teams/${id}`, patch),
  deleteTeam: (id: string) => request<void>('DELETE', `/api/teams/${id}`),
  reorderTeams: (quizId: string, order: string[]) =>
    request<TeamRow[]>('POST', `/api/quizzes/${quizId}/teams/reorder`, { order }),

  addRound: (quizId: string, body: { type: string; title: string; direction?: string | null }) =>
    request<RoundRow>('POST', `/api/quizzes/${quizId}/rounds`, body),
  updateRound: (id: string, patch: Record<string, unknown>) =>
    request<RoundRow>('PATCH', `/api/rounds/${id}`, patch),
  deleteRound: (id: string) => request<void>('DELETE', `/api/rounds/${id}`),

  addQuestion: (roundId: string, body: string) =>
    request<QuestionRow>('POST', `/api/rounds/${roundId}/questions`, { body }),
  updateQuestion: (id: string, patch: Record<string, unknown>) =>
    request<QuestionRow>('PATCH', `/api/questions/${id}`, patch),
  deleteQuestion: (id: string) => request<void>('DELETE', `/api/questions/${id}`),

  /**
   * Attach a file. Not `request()` because this is multipart, not JSON — the
   * browser must set its own boundary, so no content-type is sent here.
   */
  uploadMedia: async (questionId: string, role: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/questions/${questionId}/media?role=${role}`, {
      method: 'POST',
      // No content-type: the browser sets the multipart boundary itself.
      headers: authHeaders(),
      body: form,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(
        (body as { message?: string } | null)?.message ?? 'Upload failed.',
        res.status,
      );
    }
    return body;
  },
  deleteMedia: (linkId: string) => request<void>('DELETE', `/api/question-media/${linkId}`),

  addPart: (questionId: string, label: string) =>
    request<QuestionPartRow>('POST', `/api/questions/${questionId}/parts`, { label }),
  updatePart: (id: string, patch: Record<string, unknown>) =>
    request<QuestionPartRow>('PATCH', `/api/parts/${id}`, patch),
  deletePart: (id: string) => request<void>('DELETE', `/api/parts/${id}`),
};
