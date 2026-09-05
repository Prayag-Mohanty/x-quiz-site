/**
 * The links you need to actually run the quiz.
 *
 * Everything here already existed; it just had no home, so getting a team code
 * meant querying the API by hand. Before a quiz you need one link for yourself,
 * one screen for the projector, and one short code per team — read out loud or
 * pasted into a group chat.
 *
 * The quizmaster link is the credential: whoever holds it can drive the quiz.
 * It is hidden until asked for, so it is not sitting on screen while you are
 * sharing your window.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { Button, Panel } from './ui.js';

interface Credentials {
  qmToken: string;
  teams: { id: string; name: string; join_code: string; position: number }[];
}

export function RunPanel() {
  const quizId = useStore((s) => s.detail?.quiz.id);
  // Refetch when the teams change, not only when the quiz does. A team added
  // after this panel loaded had no code shown against it, which looked like the
  // code was missing rather than merely stale.
  const teamSignature = useStore((s) =>
    (s.detail?.teams ?? []).map((t) => `${t.id}:${t.name}`).join('|'),
  );
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setCreds(null);
    setShowToken(false);
    if (!quizId) return;
    let cancelled = false;
    void fetch(`/api/quizzes/${quizId}/credentials`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled) setCreds(body as Credentials | null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [quizId, teamSignature]);

  if (!quizId || !creds) return null;

  const origin = window.location.origin;
  const qmUrl = `${origin}/qm?token=${creds.qmToken}`;
  const scoreboardUrl = `${origin}/scoreboard?quiz=${quizId}`;
  const teamUrl = `${origin}/play`;

  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1500);
      },
      () => undefined,
    );
  };

  return (
    <Panel title="Run this quiz">
      <div className="space-y-3 text-sm">
        <div>
          <p className="font-medium">Your console</p>
          <p className="mb-1 text-xs text-neutral-500">
            Keep this one to yourself — anyone with the link can drive the quiz.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={showToken ? qmUrl : '••••••••••••••••••••••••••••'}
              className="flex-1 rounded border border-neutral-300 bg-neutral-50 px-2 py-1 font-mono text-xs text-neutral-900"
            />
            <Button onClick={() => setShowToken((v) => !v)}>{showToken ? 'Hide' : 'Show'}</Button>
            <Button onClick={() => copy('qm', qmUrl)}>
              {copied === 'qm' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>

        <div>
          <p className="font-medium">Scoreboard</p>
          <p className="mb-1 text-xs text-neutral-500">
            Read-only, safe to share or project. Shows published scores only.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={scoreboardUrl}
              className="flex-1 rounded border border-neutral-300 bg-neutral-50 px-2 py-1 font-mono text-xs text-neutral-900"
            />
            <Button onClick={() => copy('sb', scoreboardUrl)}>
              {copied === 'sb' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>

        <div>
          <p className="font-medium">Team codes</p>
          <p className="mb-1 text-xs text-neutral-500">
            Everyone goes to <span className="font-mono">{teamUrl}</span> and enters
            their team's code. One code per team, however many people are on it.
          </p>
          <ul className="space-y-1">
            {creds.teams.map((team) => (
              <li key={team.id} className="flex items-center gap-2">
                <span className="flex-1">{team.name}</span>
                <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono tracking-widest">
                  {team.join_code}
                </span>
                <Button onClick={() => copy(team.id, `${teamUrl}  code: ${team.join_code}`)}>
                  {copied === team.id ? 'Copied' : 'Copy'}
                </Button>
              </li>
            ))}
          </ul>
          {creds.teams.length === 0 && (
            <p className="text-neutral-500">Add teams first and they will get codes.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}
