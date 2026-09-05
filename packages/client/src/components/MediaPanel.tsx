/**
 * Attaching files to a question.
 *
 * Three roles, and they are genuinely different things rather than a tidy
 * abstraction:
 *
 *   PROMPT  what teams see alongside the question
 *   ANSWER  the answer slide, shown at the reveal
 *   REVEAL  the staged images of a long visual connect, in order
 *
 * The format rules here are enforced by the database, not by this component:
 * at most one video per role, reveals only on a connect question, reveals must
 * be images. So the UI offers the upload and shows the server's sentence when
 * it is refused, rather than keeping a second copy of the rules that can drift.
 */

import { useRef, useState } from 'react';
import { api, type QuestionRow } from '../api.js';
import { optimiseImage } from '../optimiseImage.js';
import { useStore } from '../store.js';
import { Button } from './ui.js';

type Role = 'PROMPT' | 'ANSWER' | 'REVEAL';

export function MediaPanel({ question }: { question: QuestionRow }) {
  const detail = useStore((s) => s.detail);
  const isConnect = question.round_type === 'VISUAL_CONNECT';

  if (!detail) return null;

  return (
    <div className="space-y-3">
      <MediaRole
        question={question}
        role="PROMPT"
        label="Question media"
        hint="Images, audio or one video, shown with the question. Teams preload these."
      />
      <MediaRole
        question={question}
        role="ANSWER"
        label="Answer media"
        hint="Shown at the reveal, alongside the answer."
      />
      {isConnect && (
        <MediaRole
          question={question}
          role="REVEAL"
          label="Staged reveals"
          hint="Images only, revealed one at a time. The order here is the order shown."
        />
      )}
    </div>
  );
}

function MediaRole({
  question,
  role,
  label,
  hint,
}: {
  question: QuestionRow;
  role: Role;
  label: string;
  hint: string;
}) {
  const detail = useStore((s) => s.detail);
  const mutate = useStore((s) => s.mutate);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const links = (detail?.questionMedia ?? [])
    .filter((m) => m.question_id === question.id && m.role === role)
    .sort((a, b) => a.position - b.position);
  const assetsById = new Map((detail?.assets ?? []).map((a) => [a.id, a]));

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    // One at a time, in the order chosen: positions come from the server, so
    // uploading in parallel would give an order nobody asked for.
    for (const file of Array.from(files)) {
      // Shrunk here rather than on the server: the browser already has a
      // decoder, and a 4MB question image takes about three and a half seconds
      // to reach a team through a tunnel — differently for each team, which
      // matters while a pounce window is open. See src/optimiseImage.ts.
      const upload = await optimiseImage(file);
      await mutate(() => api.uploadMedia(question.id, role, upload));
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  };

  return (
    <div>
      <label className="mb-1 block text-xs font-semibold tracking-wide text-neutral-600 uppercase">
        {label}
      </label>
      <p className="mb-1 text-xs text-neutral-500">{hint}</p>

      {links.length > 0 && (
        <ul className="mb-2 space-y-1">
          {links.map((link) => {
            const asset = assetsById.get(link.asset_id);
            if (!asset) return null;
            const url = `/media/${asset.storage_key}`;
            return (
              <li key={link.id} className="flex items-center gap-2 text-sm">
                {asset.kind === 'IMAGE' ? (
                  <img src={url} alt="" className="h-10 w-10 rounded object-cover" />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded bg-neutral-100 text-xs">
                    {asset.kind === 'VIDEO' ? '▶' : '♪'}
                  </span>
                )}
                <span className="flex-1 truncate" title={asset.original_filename ?? ''}>
                  {asset.original_filename ?? asset.storage_key}
                </span>
                <a href={url} target="_blank" rel="noreferrer" className="text-xs underline">
                  open
                </a>
                <Button danger onClick={() => void mutate(() => api.deleteMedia(link.id))}>
                  ✕
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <input
        ref={input}
        type="file"
        multiple={role !== 'ANSWER'}
        accept={role === 'REVEAL' ? 'image/*' : 'image/*,audio/*,video/*'}
        disabled={busy}
        onChange={(e) => void onPick(e.target.files)}
        className="block w-full text-xs text-neutral-600 file:mr-2 file:rounded file:border file:border-neutral-400 file:bg-white file:px-2 file:py-1 file:text-xs"
      />
      {busy && <p className="mt-1 text-xs text-neutral-500">Uploading…</p>}
    </div>
  );
}
