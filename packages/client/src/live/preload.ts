/**
 * Holding sealed media, and opening it on the cue.
 *
 * The server sends every asset in the round as ciphertext, addressed by an id
 * that says nothing about the plaintext URL. This fetches those bytes and keeps
 * them. When a question is presented its media arrives carrying a key, and the
 * bytes are already here — so the picture appears at the same instant for every
 * team instead of a second apart, which is what matters while a pounce window
 * is open.
 *
 * ─── Everything here fails soft ─────────────────────────────────────────────
 *
 * A browser without WebCrypto, a fetch that did not finish, a decrypt that
 * throws: every path returns the plain URL, which is exactly what the app did
 * before any of this existed. A slow question is a nuisance. A question that
 * does not appear because the decryption failed would be a disaster, and no
 * amount of instant rendering is worth that risk.
 */

import type { SealedMedia, ViewMedia } from '@quizmaster/shared';

/** Ciphertext we hold, by preload id. */
const sealed = new Map<string, ArrayBuffer>();
/** In-flight fetches, so a re-render does not start a second one. */
const fetching = new Map<string, Promise<void>>();
/** Object URLs already made, so decrypting happens once per asset. */
const opened = new Map<string, string>();

/** The 12-byte GCM nonce the server puts at the front of every sealed file. */
const IV_BYTES = 12;

/**
 * Fetch anything in the list we do not already hold.
 *
 * Sequential rather than parallel: this runs during a round the quizmaster is
 * already talking through, and saturating a team's connection to preload
 * question four is a poor trade against the question they are on now.
 */
export async function preload(list: SealedMedia[]): Promise<void> {
  for (const item of list) {
    if (sealed.has(item.id) || fetching.has(item.id)) continue;
    const task = fetch(item.url)
      .then(async (res) => {
        if (!res.ok) return;
        sealed.set(item.id, await res.arrayBuffer());
      })
      .catch(() => undefined)
      .finally(() => fetching.delete(item.id));
    fetching.set(item.id, task);
    await task;
  }
}

/**
 * The best URL for this media right now.
 *
 * An object URL built from bytes already held, when we have both the ciphertext
 * and the key. Otherwise the plain URL, which the server has been sending all
 * along and which is only ever sent for media the client may already see.
 */
export async function openMedia(media: ViewMedia): Promise<string> {
  const id = media.preloadId;
  if (!id || !media.key) return media.url;

  const already = opened.get(id);
  if (already) return already;

  const bytes = sealed.get(id);
  if (!bytes || !globalThis.crypto?.subtle) return media.url;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(media.key),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) },
      key,
      bytes.slice(IV_BYTES),
    );
    const url = URL.createObjectURL(new Blob([plain], { type: mimeFor(media.kind) }));
    opened.set(id, url);
    return url;
  } catch {
    // Tampered bytes, a truncated fetch, a browser that will not do AES-GCM.
    // The plain URL still works; it is just a fetch away.
    return media.url;
  }
}

/**
 * Forget everything.
 *
 * Called when the round changes: the object URLs are revoked so the blobs can
 * be collected, and the ciphertext for a round that is over is dead weight in
 * a tab that may be open for hours.
 */
export function clearPreloaded(): void {
  for (const url of opened.values()) URL.revokeObjectURL(url);
  opened.clear();
  sealed.clear();
}

/**
 * Whether `openMedia` will resolve to a blob rather than the network.
 *
 * Synchronous on purpose. A component that renders the plain URL for one frame
 * while waiting to find out has already told the browser to fetch it, which
 * spends the bandwidth the preload existed to save. Knowing up front lets it
 * render nothing for a tick instead.
 */
export function willOpenLocally(media: ViewMedia): boolean {
  return Boolean(media.preloadId && media.key && sealed.has(media.preloadId));
}

/** How many of a list are held, for anything that wants to show readiness. */
export function preloadedCount(list: SealedMedia[]): number {
  return list.filter((item) => sealed.has(item.id)).length;
}

function mimeFor(kind: ViewMedia['kind']): string {
  // Deliberately generic: the server does not say what a sealed file will turn
  // out to be, and the browser sniffs images and media by content anyway.
  if (kind === 'IMAGE') return 'image/*';
  if (kind === 'AUDIO') return 'audio/*';
  return 'video/*';
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}
