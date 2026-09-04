/**
 * The live connection.
 *
 * Shared by the team client, the QM console and the scoreboard — they differ
 * only in which view the server sends them, so they can share every line of
 * this.
 *
 * ─── Reconnection ───────────────────────────────────────────────────────────
 *
 * A laptop's wifi drops for four seconds mid-pounce. This reconnects on a
 * backoff and the server replies with the whole current view, so the screen is
 * simply correct again — there is nothing to replay and no gap to detect,
 * because the server never sends deltas. That is the entire reason it doesn't.
 *
 * The store holds `view` and nothing derived from it. The server is the source
 * of truth; this is a render cache, and every message replaces it wholesale.
 */

import { create } from 'zustand';
import type { ClientMessage, ServerMessage, View } from '@quizmaster/shared';

export type Status = 'connecting' | 'live' | 'reconnecting' | 'rejected';

interface LiveState {
  view: View | null;
  status: Status;
  /** A rejected action, in the server's words. Cleared on the next state. */
  error: string | null;
  send: (message: ClientMessage) => void;
  connect: (url: string) => void;
  disconnect: () => void;
  clearError: () => void;
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let wanted: string | null = null;

export const useLive = create<LiveState>((set, get) => ({
  view: null,
  status: 'connecting',
  error: null,

  clearError: () => set({ error: null }),

  send: (message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  },

  connect: (url) => {
    // Already connected, or connecting, to this exact URL: do nothing. React's
    // StrictMode runs effects twice in development, so connect/disconnect/connect
    // is the NORMAL case, not an edge one. Without this the second call opens a
    // second socket and the module-level handle ends up pointing at whichever
    // one raced last — which is how a send silently goes nowhere.
    if (wanted === url && socket && socket.readyState <= WebSocket.OPEN) return;

    wanted = url;
    if (reconnectTimer) clearTimeout(reconnectTimer);

    const open = () => {
      if (wanted !== url) return;
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        if (socket !== ws) return;
        attempts = 0;
        set({ status: 'live' });
      };

      ws.onmessage = (event) => {
        // A superseded socket must not write into the store, or a stale view
        // can arrive after a fresh one and overwrite it.
        if (socket !== ws) return;
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === 'STATE') {
          // Wholesale replacement of the VIEW only. Deliberately not of `error`:
          // the server sends a corrective state immediately after refusing an
          // action, so clearing it here made every rejection invisible — the
          // screen just silently ignored you. Errors are cleared by the person
          // who read them.
          set({ view: message.view, status: 'live' });
        } else if (message.type === 'ERROR') {
          set({ error: message.message });
        }
      };

      ws.onclose = () => {
        // Superseded, or deliberately torn down: not a dropped connection.
        if (socket !== ws || wanted !== url) return;
        // A session the server rejected will keep being rejected, so stop
        // hammering it and say so instead of looking like a network problem.
        if (get().error?.includes('not valid')) {
          set({ status: 'rejected' });
          return;
        }
        set({ status: 'reconnecting' });
        attempts += 1;
        // Fast at first — most drops are brief — then back off so a server that
        // is genuinely down is not hammered by ten clients at once.
        const delay = Math.min(500 * 2 ** Math.min(attempts, 5), 10_000);
        reconnectTimer = setTimeout(open, delay);
      };

      ws.onerror = () => {
        // onclose always follows; the retry lives there so there is one path.
      };
    };

    open();
  },

  disconnect: () => {
    wanted = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
    set({ view: null, status: 'connecting' });
  },
}));

/**
 * Where the session token lives between refreshes.
 *
 * DECISIONS.md says cookie-backed so a refresh does not eject you. This uses
 * localStorage instead: same outcome, and the token already travels as a query
 * parameter on the socket rather than as a cookie header. Worth revisiting if
 * the server ever needs to read the session during the HTTP handshake.
 */
const STORAGE_KEY = 'quizmaster.session';

export interface StoredSession {
  token: string;
  role: 'TEAM' | 'QM';
  quizId: string;
  teamName?: string;
  displayName?: string;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // A locked-down browser just means joining again after a refresh.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

/** The socket URL for a session token, on whatever host served the page. */
export function socketUrl(params: Record<string, string>): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams(params).toString();
  return `${protocol}//${location.host}/ws?${query}`;
}

// Handy in the browser console during development; harmless in production.
if (typeof window !== 'undefined') {
  const w = window as unknown as { __live?: unknown; __sockInfo?: unknown };
  w.__live = useLive;
  w.__sockInfo = () => ({
    hasSocket: Boolean(socket),
    readyState: socket?.readyState ?? null,
    wanted,
    url: socket?.url ?? null,
  });
}
