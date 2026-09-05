/**
 * The post-quiz breakdown.
 *
 * The screen you open after everyone has gone, when three questions arrive in
 * the group chat: how did we get 45, what did we actually write, and who came
 * second. It is a document, not a live view — one fetch, no socket.
 *
 * It does NOT rank the teams. FORMAT_SPEC §3 is explicit that the system shows
 * the tiebreak signals and the quizmaster decides, so this lists teams in seat
 * order with their pounce record beside the score and stops there. Sorting by
 * score and numbering the rows would be the app making a ruling.
 *
 * The report carries canonical answers and every team's private text, so it is
 * behind the quizmaster's token. If the console is open in this browser its
 * session works too, which is the usual case.
 */

import { useEffect, useState } from 'react';
import type {
  BreakdownEvent,
  BreakdownReport,
  BreakdownSubmission,
} from '@quizmaster/shared';

import { loadSession } from './socket.js';

export function BreakdownApp() {
  const quizId = new URLSearchParams(location.search).get('quiz') ?? '';
  const stored = loadSession();
  // The console's own session opens this, so a QM who has just finished a quiz
  // does not have to go and find the long token again.
  const sessionToken = stored?.role === 'QM' && stored.quizId === quizId ? stored.token : '';

  const [token, setToken] = useState(sessionToken);
  const [typed, setTyped] = useState('');
  const [report, setReport] = useState<BreakdownReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!quizId || !token) return;
    let live = true;
    setBusy(true);
    fetch(`/api/quizzes/${quizId}/breakdown`, { headers: { 'x-qm-token': token } })
      .then(async (res) => {
        const body = await res.json();
        if (!live) return;
        if (!res.ok) {
          setError(body.message ?? 'Could not load the breakdown.');
          setReport(null);
          return;
        }
        setError(null);
        setReport(body as BreakdownReport);
      })
      .catch(() => live && setError('Could not reach the server.'))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [quizId, token]);

  if (!quizId) {
    return (
      <Centre>
        <h1 className="mb-2 text-xl font-semibold">No quiz</h1>
        <p className="text-sm text-neutral-600">
          Open this as <code>/breakdown?quiz=&lt;quiz id&gt;</code>, or use the
          link in the quizmaster console.
        </p>
      </Centre>
    );
  }

  if (!report) {
    return (
      <Centre>
        <p className="mb-1 text-xs font-semibold tracking-widest text-neutral-400 uppercase">
          Quizmaster
        </p>
        <h1 className="mb-2 text-xl font-semibold">Post-quiz breakdown</h1>
        <p className="mb-4 text-sm text-neutral-600">
          This report has the answers and every team's written text in it, so it
          needs your quizmaster token — the long one from the console link.
        </p>
        {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
        {busy && <p className="mb-3 text-sm text-neutral-500">Loading…</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setToken(typed.trim());
          }}
        >
          <input
            className="w-full rounded border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Quizmaster token"
          />
          <button
            type="submit"
            disabled={!typed.trim()}
            className="mt-3 w-full rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40"
          >
            Open
          </button>
        </form>
      </Centre>
    );
  }

  return <Report report={report} />;
}

function Report({ report }: { report: BreakdownReport }) {
  const withheld = report.standings.filter((s) => s.withheldPoints !== 0);

  return (
    <div className="mx-auto min-h-screen max-w-5xl bg-neutral-50 p-4 pb-24">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{report.quiz.title}</h1>
          <p className="text-sm text-neutral-500">
            Post-quiz breakdown · {new Date(report.generatedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => downloadCsv(`${slug(report.quiz.title)}-scores.csv`, scoresCsv(report))}
            className="rounded border border-neutral-400 px-3 py-1.5 text-sm"
          >
            Scores CSV
          </button>
          <button
            onClick={() => downloadCsv(`${slug(report.quiz.title)}-answers.csv`, answersCsv(report))}
            disabled={report.submissions.length === 0}
            className="rounded border border-neutral-400 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Answers CSV
          </button>
        </div>
      </header>

      {/* A stranded PENDING is a question that was scored and never revealed.
          Nobody notices during the quiz; this is where it surfaces. */}
      {withheld.length > 0 && (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>Points were recorded but never published.</strong>{' '}
          {withheld.map((s) => `${s.name} ${signed(s.withheldPoints)}`).join(', ')}. That
          happens when a question was scored and the answer never revealed — the
          scores below do not include them.
        </div>
      )}

      <Section title="Final scores" note="Seat order. Ties are yours to break — §3.">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase text-neutral-500">
              <th className="py-1">Seat</th>
              <th>Team</th>
              <th className="text-right">Score</th>
              <th className="text-right">Pounces</th>
              <th className="text-right">Right</th>
              <th className="text-right">Wrong</th>
            </tr>
          </thead>
          <tbody>
            {report.standings.map((s) => (
              <tr key={s.teamId} className="border-b border-neutral-100">
                <td className="py-1 font-mono text-xs text-neutral-400">{s.seat + 1}</td>
                <td className="font-medium">{s.name}</td>
                <td className="text-right font-mono text-base tabular-nums">{s.score}</td>
                <td className="text-right font-mono tabular-nums">{s.pouncesAttempted}</td>
                <td className="text-right font-mono tabular-nums text-green-700">
                  {s.pouncesCorrect}
                </td>
                <td className="text-right font-mono tabular-nums text-red-700">
                  {s.pouncesWrong}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Where the points came from"
        note={`${report.events.length} awards, oldest first. Undone ones are not listed.`}
      >
        {report.events.length === 0 ? (
          <Empty>Nothing was scored.</Empty>
        ) : (
          <ul className="space-y-1">
            {report.events.map((e, i) => (
              <EventRow key={i} event={e} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="What the teams wrote"
        note="Pounce text and written sheets, as submitted."
      >
        {report.submissions.length === 0 ? (
          <Empty>
            Nothing recorded. Pounce text and written sheets are kept from the
            moment a quiz is run — a quiz played before that has its answers only
            in the action log.
          </Empty>
        ) : (
          <SubmissionList submissions={report.submissions} />
        )}
      </Section>
    </div>
  );
}

function EventRow({ event }: { event: BreakdownEvent }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 border-b border-neutral-100 py-1 text-sm">
      <span className="w-28 shrink-0 font-medium">{event.teamName}</span>
      <span className="w-40 shrink-0 text-xs text-neutral-500">
        {event.roundTitle}
        {event.questionIndex !== null && ` · Q${event.questionIndex + 1}`}
      </span>
      <span
        className={`w-12 shrink-0 text-right font-mono tabular-nums ${
          event.points > 0 ? 'text-green-700' : event.points < 0 ? 'text-red-700' : ''
        }`}
      >
        {signed(event.points)}
      </span>
      <span className="text-xs text-neutral-500">{event.reason.replace(/_/g, ' ').toLowerCase()}</span>
      {event.status === 'PENDING' && (
        <span className="rounded bg-amber-100 px-1 text-xs text-amber-800">never published</span>
      )}
      {event.note && <span className="text-xs text-neutral-600">— {event.note}</span>}
    </li>
  );
}

/** Grouped by question, because that is how you read a set of answers. */
function SubmissionList({ submissions }: { submissions: BreakdownSubmission[] }) {
  const groups = new Map<string, BreakdownSubmission[]>();
  for (const s of submissions) {
    const key = `${s.roundIndex}|${s.questionIndex}`;
    const existing = groups.get(key);
    if (existing) existing.push(s);
    else groups.set(key, [s]);
  }

  return (
    <div className="space-y-4">
      {[...groups.values()].map((group) => {
        const first = group[0]!;
        return (
          <div key={`${first.roundIndex}|${first.questionIndex}`}>
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              {first.roundTitle} · Q{first.questionIndex + 1}
            </p>
            <p className="text-sm">{first.questionText}</p>
            <p className="mb-1 text-sm text-amber-800">
              Answer: {first.answerText || <em>not written</em>}
            </p>
            <ul className="space-y-1">
              {group.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="w-28 shrink-0 py-0.5">{s.teamName}</span>
                  <span className="flex-1 rounded bg-neutral-50 px-2 py-0.5 font-mono text-xs whitespace-pre-wrap">
                    {s.body || <em className="text-neutral-400">blank</em>}
                  </span>
                  <span className="flex shrink-0 gap-1 text-xs">
                    {s.stageIdx !== null && (
                      <span className="text-neutral-500">reveal {s.stageIdx + 1}</span>
                    )}
                    {s.staked && (
                      <span className="rounded bg-amber-100 px-1 text-amber-800">staked</span>
                    )}
                    {s.verdict && (
                      <span className={s.verdict === 'CORRECT' ? 'text-green-700' : 'text-red-700'}>
                        {s.verdict === 'CORRECT' ? '✓' : '✗'}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/**
 * One CSV cell.
 *
 * Two separate hazards. Commas, quotes and newlines break the format, and are
 * handled by quoting. A cell that STARTS with =, +, - or @ is read as a formula
 * by Excel and Sheets, and these cells contain text people typed — so a leading
 * apostrophe goes in front. Numbers are written by the caller, not through here.
 */
function cell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const line = (values: (string | number | null)[]) =>
    values
      .map((v) => (typeof v === 'number' ? String(v) : cell(v ?? '')))
      .join(',');
  // The first character is a BOM (U+FEFF), invisible here on purpose. Excel on
  // Windows reads a UTF-8 CSV as the local codepage without one and turns every
  // non-ASCII answer into mojibake. Verified by reading the generated bytes:
  // the file starts EF BB BF. Blob.text() strips it, so check arrayBuffer().
  return `﻿${[line(header), ...rows.map(line)].join('\r\n')}\r\n`;
}

function scoresCsv(report: BreakdownReport): string {
  const standing = new Map(report.standings.map((s) => [s.teamId, s]));
  return toCsv(
    ['team', 'seat', 'final_score', 'pounces_attempted', 'pounces_correct', 'pounces_wrong',
     'round', 'question', 'points', 'reason', 'status', 'note'],
    report.events.map((e) => {
      const s = standing.get(e.teamId);
      return [
        e.teamName,
        (s?.seat ?? 0) + 1,
        s?.score ?? 0,
        s?.pouncesAttempted ?? 0,
        s?.pouncesCorrect ?? 0,
        s?.pouncesWrong ?? 0,
        e.roundTitle,
        e.questionIndex === null ? '' : e.questionIndex + 1,
        e.points,
        e.reason,
        e.status,
        e.note ?? '',
      ];
    }),
  );
}

function answersCsv(report: BreakdownReport): string {
  return toCsv(
    ['round', 'question', 'question_text', 'canonical_answer', 'team', 'kind',
     'reveal', 'staked', 'answer', 'verdict'],
    report.submissions.map((s) => [
      s.roundTitle,
      s.questionIndex + 1,
      s.questionText,
      s.answerText,
      s.teamName,
      s.kind,
      s.stageIdx === null ? '' : s.stageIdx + 1,
      s.staked ? 'yes' : 'no',
      s.body,
      s.verdict ?? '',
    ]),
  );
}

function downloadCsv(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// ─── Small pieces ───────────────────────────────────────────────────────────

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'quiz';

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded border border-neutral-200 bg-white">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-200 px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-neutral-600 uppercase">
          {title}
        </h2>
        {note && <span className="text-xs text-neutral-500">{note}</span>}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-neutral-500">{children}</p>;
}

function Centre({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-md rounded border border-neutral-200 bg-white p-6">
        {children}
      </div>
    </div>
  );
}
