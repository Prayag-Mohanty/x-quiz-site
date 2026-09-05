/**
 * Inline formatting for questions and answers.
 *
 * A quizmaster needs to emphasise a word — the operative part of a question,
 * the bit the pun turns on — and that is the whole requirement. So this is a
 * three-mark inline syntax and nothing else:
 *
 *   **bold**   *italic*   _underline_
 *
 * ─── Why not markdown, and why not HTML ─────────────────────────────────────
 *
 * Markdown has no underline, so a markdown library would solve two thirds of
 * the problem and bring a dependency. HTML would mean storing markup and
 * rendering it with dangerouslySetInnerHTML, which turns every question body
 * into a script-injection surface for the sake of three tags.
 *
 * This parses to a token list. The renderer turns tokens into React elements,
 * so nothing ever becomes HTML and there is nothing to sanitise.
 *
 * Text with no markers passes through untouched, which matters: every question
 * already written is plain text and must keep rendering exactly as it does now.
 */

export type Mark = 'bold' | 'italic' | 'underline';

export interface TextToken {
  text: string;
  marks: Mark[];
}

/** The markers, longest first — `**` must be tried before `*`. */
const MARKERS: { marker: string; mark: Mark }[] = [
  { marker: '**', mark: 'bold' },
  { marker: '_', mark: 'underline' },
  { marker: '*', mark: 'italic' },
];

/**
 * Split text into runs with their marks.
 *
 * Marks nest, so `**bold and *also italic*** ` yields a run carrying both. An
 * unclosed marker is left as literal text rather than swallowing the rest of
 * the question — `2 * 3` and `snake_case` are things people type, and eating
 * everything after them would be worse than not formatting at all.
 */
export function parseRich(input: string): TextToken[] {
  const tokens: TextToken[] = [];
  const open: Mark[] = [];
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) {
      tokens.push({ text: buffer, marks: [...open] });
      buffer = '';
    }
  };

  while (i < input.length) {
    const found = MARKERS.find((m) => input.startsWith(m.marker, i));

    if (found) {
      const isOpen = open.includes(found.mark);
      // Closing is unconditional; opening requires a matching close later on,
      // or the marker is just a character someone typed.
      const closesLater =
        isOpen || input.indexOf(found.marker, i + found.marker.length) !== -1;

      if (closesLater) {
        flush();
        if (isOpen) open.splice(open.indexOf(found.mark), 1);
        else open.push(found.mark);
        i += found.marker.length;
        continue;
      }
    }

    buffer += input[i];
    i += 1;
  }

  flush();
  return tokens;
}

/** True when the text contains formatting the renderer would act on. */
export function hasMarkup(input: string): boolean {
  return parseRich(input).some((t) => t.marks.length > 0);
}

/**
 * Wrap a selection in a marker, or unwrap it if it is already wrapped.
 *
 * Returns the new text and where the selection should sit afterwards, so the
 * caret does not jump to the end every time somebody presses B.
 */
export function toggleMark(
  text: string,
  start: number,
  end: number,
  mark: Mark,
): { text: string; start: number; end: number } {
  const marker = MARKERS.find((m) => m.mark === mark)?.marker ?? '**';
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  // Already wrapped, just inside the selection: unwrap.
  if (selected.startsWith(marker) && selected.endsWith(marker) &&
      selected.length >= marker.length * 2) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }

  // Already wrapped, just outside the selection: unwrap that instead, so a
  // second press undoes the first even though the selection did not move.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    const trimmedBefore = before.slice(0, before.length - marker.length);
    const trimmedAfter = after.slice(marker.length);
    return {
      text: trimmedBefore + selected + trimmedAfter,
      start: start - marker.length,
      end: end - marker.length,
    };
  }

  return {
    text: `${before}${marker}${selected}${marker}${after}`,
    start: start + marker.length,
    end: end + marker.length,
  };
}
