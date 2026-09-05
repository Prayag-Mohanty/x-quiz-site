/**
 * Client state.
 *
 * The server is the source of truth; this is a render cache. Every mutation
 * calls the API and then refetches the quiz rather than patching local state
 * optimistically — the database renumbers positions on delete and rejects
 * writes the format forbids, so guessing what the new state looks like means
 * guessing wrong. Phase 0 does not need the latency.
 */

import { create } from 'zustand';
import { api, ApiError, setAdminToken, type QuizDetail, type QuizRow } from './api.js';

interface State {
  quizzes: QuizRow[];
  detail: QuizDetail | null;
  selectedQuestionId: string | null;
  loading: boolean;
  error: string | null;
  /**
   * The server refused to let this browser author.
   *
   * Either it is not running on this machine and ADMIN_TOKEN is set, or it is
   * not running on this machine and ADMIN_TOKEN is NOT set — in which case
   * nothing will help but going back to the machine it runs on. Either way the
   * shell shows a token prompt rather than an error the user cannot act on.
   */
  needsAdminToken: boolean;

  loadQuizzes: () => Promise<void>;
  selectQuiz: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  selectQuestion: (id: string | null) => void;
  clearError: () => void;
  /** Store a token and retry. Empty clears it. */
  useAdminToken: (token: string) => Promise<void>;
  /** Run a mutation, surface any rejection, then resync from the server. */
  mutate: (fn: () => Promise<unknown>) => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  quizzes: [],
  detail: null,
  selectedQuestionId: null,
  loading: false,
  error: null,
  needsAdminToken: false,

  clearError: () => set({ error: null }),
  useAdminToken: async (token) => {
    setAdminToken(token.trim());
    set({ needsAdminToken: false, error: null });
    await get().loadQuizzes();
  },
  selectQuestion: (id) => set({ selectedQuestionId: id }),

  loadQuizzes: async () => {
    set({ loading: true });
    try {
      set({ quizzes: await api.listQuizzes(), error: null });
    } catch (err) {
      set({ error: describe(err), needsAdminToken: isUnauthorised(err) });
    } finally {
      set({ loading: false });
    }
  },

  selectQuiz: async (id) => {
    set({ loading: true, selectedQuestionId: null });
    try {
      set({ detail: await api.getQuiz(id), error: null });
    } catch (err) {
      set({ error: describe(err), needsAdminToken: isUnauthorised(err) });
    } finally {
      set({ loading: false });
    }
  },

  refresh: async () => {
    const id = get().detail?.quiz.id;
    if (!id) return;
    try {
      set({ detail: await api.getQuiz(id), error: null });
    } catch (err) {
      set({ error: describe(err), needsAdminToken: isUnauthorised(err) });
    }
  },

  mutate: async (fn) => {
    try {
      await fn();
      set({ error: null });
    } catch (err) {
      // A 422 here is the format saying no. Show it and still resync, so the
      // screen never drifts from what was actually stored.
      set({ error: describe(err), needsAdminToken: isUnauthorised(err) });
    }
    await get().refresh();
    await get().loadQuizzes();
  },
}));

/** A 401 is the access hook in access.ts, not a bad request. */
function isUnauthorised(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
