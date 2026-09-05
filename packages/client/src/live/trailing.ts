/**
 * How much blank space to leave under a question on the slide.
 *
 * Two lines' worth normally, one when the last line is short — a short line
 * already leaves white space to its right, so the full two below it reads as a
 * hole rather than as breathing room.
 *
 * "Last line" here is the last AUTHORED line: the text after the final line
 * break, not the last line the browser happens to wrap to. That keeps this a
 * pure function of the question rather than of the window width, so a question
 * looks the same on a phone, a laptop and a projector — and keeps it testable
 * without a DOM.
 */
export function trailingLines(text: string): number {
  const lines = text.trimEnd().split(/\r?\n/);
  const last = lines[lines.length - 1] ?? '';
  const words = last.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 5 ? 1 : 2;
}
