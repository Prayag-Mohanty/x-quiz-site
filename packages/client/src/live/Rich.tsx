/**
 * Rendering the inline formatting.
 *
 * Tokens become React elements, never HTML — see `src/richtext.ts` for why
 * that is the point rather than an implementation detail. Whitespace and line
 * breaks are preserved by the caller's `whitespace-pre-wrap`, so this only
 * concerns itself with emphasis.
 */

import { parseRich, type Mark } from '../richtext.js';

const CLASS: Record<Mark, string> = {
  bold: 'font-semibold',
  italic: 'italic',
  underline: 'underline',
};

export function Rich({ text }: { text: string }) {
  const tokens = parseRich(text);
  return (
    <>
      {tokens.map((token, i) =>
        token.marks.length === 0 ? (
          <span key={i}>{token.text}</span>
        ) : (
          <span key={i} className={token.marks.map((m) => CLASS[m]).join(' ')}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
}
