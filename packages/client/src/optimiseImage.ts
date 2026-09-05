/**
 * Shrinking question images before they are uploaded.
 *
 * ─── Why, with numbers ──────────────────────────────────────────────────────
 *
 * Measured through a Cloudflare tunnel, which is how teams in other cities
 * reach the app:
 *
 *   374 KB image   ~0.8s to appear   (of which ~0.7s is the round trip)
 *   4.2 MB image   ~3.5s to appear
 *
 * A second of blank box while the quizmaster is still reading is nothing. Four
 * seconds on a visual connect, where a picture going up IS the question, is a
 * long time to look at nothing — and worse, it is a DIFFERENT length of time
 * for each team, which is a fairness problem rather than a comfort one when a
 * pounce window is open.
 *
 * Making the file small fixes most of that and costs nothing at quiz time. It
 * happens in the browser, on the authoring page, so there is no image library
 * on the server and nothing new to install: the browser already has a decoder
 * and a canvas.
 *
 * ─── What it will not do ────────────────────────────────────────────────────
 *
 * It leaves a file alone unless shrinking it actually helps, and it keeps the
 * original if the "optimised" version comes out larger — which happens with
 * flat graphics that were already well compressed. It never touches audio or
 * video, and it never upscales.
 */

/** Long edge beyond which a question image is bigger than any screen needs. */
export const MAX_EDGE = 1600;

/** Below this, the round trip dominates and re-encoding is pointless. */
export const LEAVE_ALONE_BYTES = 400 * 1024;

export interface Target {
  width: number;
  height: number;
}

/**
 * The size to redraw at, preserving aspect ratio. Never larger than the source
 * — upscaling a small image would add bytes and no detail.
 */
export function targetSize(width: number, height: number, maxEdge = MAX_EDGE): Target {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Whether a file is worth re-encoding at all.
 *
 * Only images, only ones big enough for it to matter. GIFs are excluded
 * because a canvas would silently flatten an animation to its first frame,
 * and a question that depends on the animation would be destroyed by an
 * optimisation nobody asked for.
 */
export function worthOptimising(file: { type: string; size: number }): boolean {
  if (!file.type.startsWith('image/')) return false;
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return false;
  return file.size > LEAVE_ALONE_BYTES;
}

/**
 * Redraw an image smaller, or hand back exactly what came in.
 *
 * Every failure path returns the original file: a browser without WebP, a
 * decode error, a canvas that comes back empty. An image that uploads at full
 * size is a slow question; an image that fails to upload is a broken one.
 */
export async function optimiseImage(file: File): Promise<File> {
  if (!worthOptimising(file)) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = targetSize(bitmap.width, bitmap.height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    // WebP first: it keeps transparency, which JPEG would fill with black, and
    // is materially smaller at the same quality. JPEG is the fallback for a
    // browser that will not produce it.
    const blob =
      (await toBlob(canvas, 'image/webp', 0.85)) ?? (await toBlob(canvas, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;

    const extension = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], `${baseName(file.name)}.${extension}`, { type: blob.type });
  } catch {
    return file;
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality);
  });
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
