-- 008 — sealed preload
--
-- ARCHITECTURE §2 wants question media on every client BEFORE the quizmaster
-- cues it, so that a picture appears at the same instant for everyone. On a
-- visual connect that is not a comfort question: teams see the reveal at
-- slightly different moments while a pounce window is open, and the difference
-- measured through a tunnel is about a second.
--
-- Plain preloading cannot do it. Anything a browser has fetched is one click
-- away in its network tab, so handing a team the images of a question that has
-- not been asked is handing them the question — and on a connect, the round.
--
-- So the bytes travel early and the key travels late. Each asset gets:
--
--   preload_id   a second, unrelated identifier. The sealed bytes are served
--                under this, so knowing it tells you nothing about the plain
--                URL, which stays unguessable.
--   preload_key  AES-256-GCM, base64. Sent to a client only at the moment the
--                plaintext URL would already have been sent — that is, when
--                the question is presented. The key is never earlier than the
--                thing it unlocks.
--
-- The key lives beside the ciphertext, which is not secrecy against anyone with
-- the database: it is not meant to be. The threat is a player with dev tools
-- and a browser, and the only claim here is that the bytes on their machine are
-- unreadable until the quizmaster says so.

BEGIN;

ALTER TABLE media_asset
  ADD COLUMN preload_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN preload_key text;

-- Served under this, so it must be unique and it must not be the storage key.
ALTER TABLE media_asset
  ADD CONSTRAINT media_asset_preload_id_unique UNIQUE (preload_id);

COMMENT ON COLUMN media_asset.preload_id IS
  'Public identifier for the SEALED copy. Unrelated to storage_key on purpose: a client may hold this long before it may see the media.';
COMMENT ON COLUMN media_asset.preload_key IS
  'Base64 AES-256-GCM key. NULL until the asset has been sealed. Released to clients only when the question is presented.';

COMMIT;
