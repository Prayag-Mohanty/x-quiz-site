/**
 * Reading a PDF in the browser.
 *
 * pdf.js, loaded on demand. The import panel is on the authoring screen and
 * nowhere else, so a dynamic import keeps ~350KB of PDF machinery out of the
 * bundle every team downloads to answer questions on a phone.
 *
 * The file is never uploaded to read it. Parsing happens here, the quizmaster
 * reviews what was found, and only the questions they accept are sent anywhere.
 *
 * ─── Page pictures ──────────────────────────────────────────────────────────
 *
 * A slide deck's question IS its picture — "who invented this equipment?" is
 * nothing without the equipment. Rather than dig embedded images out of the
 * PDF, which is fiddly and loses the layout, the page is rendered as it looks
 * and attached whole. That is what the room would have been shown.
 */

import { parsePdfPages } from './pdf.js';
import { looksLabelled } from './pdf.js';
import type { ImportedQuiz } from './model.js';

/** A rendered question page, ready to be attached to the question it belongs to. */
export interface RenderedPage {
  /** The question's `label`, so the importer can match them up. */
  label: string;
  file: File;
}

export interface PdfImport {
  quiz: ImportedQuiz;
  /** Empty for a question paper: its questions are text and need no picture. */
  pages: RenderedPage[];
}

type PdfJs = typeof import('pdfjs-dist');

async function loadPdfJs(): Promise<PdfJs> {
  const pdfjs = await import('pdfjs-dist');
  // The worker has to be told where it is when bundled. `import.meta.url` makes
  // Vite emit it as an asset beside the bundle rather than reaching for a CDN,
  // which would put a question set behind someone else's uptime.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  return pdfjs;
}

/**
 * How long to wait for one page to draw before giving up on its picture.
 *
 * Rendering needs the browser to paint, and a browser does not paint a tab
 * nobody is looking at — `requestAnimationFrame` simply never fires, and
 * pdf.js waits on it forever. So a quizmaster who drops a deck and switches
 * tabs would sit on "Reading…" until they came back, with nothing to say why.
 *
 * A page that has not drawn in this long loses its picture and nothing else:
 * the questions still import, and the import says which pages it could not
 * draw so they can be added by hand.
 */
const RENDER_TIMEOUT_MS = 15_000;

/** Render one page to a JPEG, sized so it is readable on a projector and not huge. */
async function renderPage(
  page: Awaited<ReturnType<Awaited<ReturnType<PdfJs['getDocument']>['promise']>['getPage']>>,
  index: number,
): Promise<File | null> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, Math.max(1, 1600 / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) return null;

  // Slides are drawn on transparent backgrounds often enough that skipping this
  // gives black text on black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  const task = page.render({ canvas, canvasContext: context, viewport });
  try {
    await Promise.race([
      task.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), RENDER_TIMEOUT_MS),
      ),
    ]);
  } catch {
    // Cancel so the worker is not left drawing into a canvas nobody wants.
    task.cancel();
    return null;
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.85),
  );
  return blob ? new File([blob], `page-${index + 1}.jpg`, { type: 'image/jpeg' }) : null;
}

/**
 * Text out of every page, then a parse, then pictures if it was a deck.
 *
 * Text extraction joins items with spaces and breaks a line when the vertical
 * position moves, which is what turns pdf.js's positioned glyph runs back into
 * the lines the parser looks for.
 */
export async function readPdf(file: File): Promise<PdfImport> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    let lastY: number | null = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform[5] as number;
      if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
      text += item.str;
      if (item.hasEOL) text += '\n';
      lastY = y;
    }
    pages.push(text);
  }

  const quiz = parsePdfPages(pages, file.name);

  // Only a deck needs its pages as pictures. A question paper is prose, and
  // attaching a page of prose to every question would put the answer on screen.
  if (looksLabelled(pages)) return { quiz, pages: [] };

  const rendered: RenderedPage[] = [];
  let undrawn = 0;
  /**
   * One timeout means all of them.
   *
   * The reason a page does not draw is almost never that page — it is that the
   * browser is not painting this tab at all. Trying the other fifteen would
   * cost fifteen more timeouts and tell us nothing new, so the first failure
   * stops the rendering and the rest import as text.
   */
  let giveUp = false;

  for (const round of quiz.rounds) {
    for (const question of round.questions) {
      // The label carries the page it came from: "Slide 4 · Q2".
      const match = /^Slide (\d+)/.exec(question.label);
      if (!match) continue;
      if (giveUp) {
        undrawn += 1;
        continue;
      }
      const pageNumber = Number(match[1]);
      const image = await renderPage(await doc.getPage(pageNumber), pageNumber - 1);
      if (image) {
        rendered.push({ label: question.label, file: image });
      } else {
        undrawn += 1;
        giveUp = true;
      }
    }
  }

  if (undrawn > 0) {
    quiz.warnings.push(
      `${undrawn} page${undrawn === 1 ? '' : 's'} could not be drawn, so ${undrawn === 1 ? 'that question imports' : 'those questions import'} as text with no picture. A browser does not draw a tab nobody is looking at — keep this tab in front while a deck is read, and try again if the pictures matter.`,
    );
  }

  return { quiz, pages: rendered };
}
