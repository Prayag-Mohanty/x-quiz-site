/**
 * Rendering one piece of question media.
 *
 * Prefers bytes the client is already holding — see `preload.ts` — and falls
 * back to the plain URL whenever it does not have them, which is also what
 * happens for a client that joined late, a browser without WebCrypto, and any
 * asset uploaded before sealing existed.
 *
 * It starts from the plain URL rather than from nothing, so the very worst case
 * is the behaviour this app had before preloading: the image loads over the
 * network while you look at the question. There is no state in which a picture
 * fails to appear because decryption was involved.
 */

import { useEffect, useState } from 'react';
import type { ViewMedia } from '@quizmaster/shared';

import { openMedia, willOpenLocally } from './preload.js';

export function MediaView({ media, className }: { media: ViewMedia; className?: string }) {
  /**
   * Empty when the bytes are already here.
   *
   * Rendering the plain URL for the one frame it takes to decrypt would tell
   * the browser to fetch the file anyway, spending exactly the bandwidth the
   * preload existed to save. So: nothing for a tick, then the blob. When there
   * is no local copy this starts at the plain URL and behaves as it always did.
   */
  const [src, setSrc] = useState(() => (willOpenLocally(media) ? '' : media.url));

  useEffect(() => {
    let live = true;
    setSrc(willOpenLocally(media) ? '' : media.url);
    void openMedia(media).then((url) => {
      // If the component has moved on to another question, drop it on the floor.
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [media.id, media.url, media.key, media.preloadId]);

  // Nothing to show yet, and nothing to ask the network for either.
  if (!src) return null;

  if (media.kind === 'IMAGE') {
    return <img src={src} alt="" className={className} />;
  }
  if (media.kind === 'AUDIO') {
    return <audio src={src} controls className={className} />;
  }
  return <video src={src} controls className={className} />;
}
