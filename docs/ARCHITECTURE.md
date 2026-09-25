# Online Quiz Platform — Architecture & Build Plan

**Scope:** Finals format, 8–10 teams of up to 3, distributed. QM-driven, not timer-driven.
**Author's format is the spec.** Generalisation comes later, deliberately.

---

## 1. The core design principle

> The QM drives a state machine. Timers are advisory displays that suggest; they never act.

Every state transition in the system is caused by an explicit QM action. Timers render a
countdown and may fire a visual/audio nudge, but they do not close a pounce window, do not
advance a question, and do not award points. This is the single most important architectural
commitment and it should be enforced structurally: **no timer callback is permitted to mutate
quiz state.** Timers emit UI events only.

Rationale: the format has judgment calls embedded in it (partial credit, when to reveal, how
long to leave a pounce window open, whether an answer is "close enough"). A system that
automates these produces a worse quiz than a spreadsheet.

---

## 2. Domain model

### Entities

```
Quiz
  id, title, teams[], rounds[], current_round_idx, status

Team
  id, name, members[], score, pounce_stats { attempted, correct, wrong }

Round
  id, type: DIRECT | WRITTEN | VISUAL_CONNECT
  direction: CW | ACW            (DIRECT only)
  questions[]
  starting_team_idx               (who gets Q1 direct)
  config { pounce_points, bounce_points, ... }

Question
  id, media[], answer_media[], answer_text
  parts[]                         (1 for simple, 2+ for multi-part)
  reveal_order[]                  (VISUAL_CONNECT: staged media)

QuestionPart
  id, label, canonical_answer, accepted_variants[]

Media
  id, kind: IMAGE | AUDIO | VIDEO | TEXT
  url, preload_hash, duration
```

### The scoring ledger

Do **not** store `team.score` as the source of truth. Store an append-only ledger:

```
ScoreEvent
  id, quiz_id, team_id, question_id, round_id
  points: int
  reason: POUNCE_CORRECT | POUNCE_WRONG | BOUNCE_CORRECT
        | PARTIAL | STAKE_CORRECT | STAKE_WRONG | TIEBREAK | MANUAL_ADJUST
  status: PENDING | APPLIED | VOIDED
  created_at, applied_at, created_by
  note                            (QM's free-text justification)
```

Scores are `SUM(points) WHERE status = APPLIED`. This gives you three things you will
need and would otherwise have to retrofit:

1. **Pending points.** Your partial-credit rule requires awarding +5 to a team but not
   publishing it until after the full answer is revealed. A `PENDING` event does exactly
   this: recorded, auditable, invisible on the public scoreboard, flipped to `APPLIED`
   when the QM reveals.
2. **Undo.** Live quizzes have mistakes. Voiding an event is safe; decrementing an integer
   is not.
3. **The post-quiz breakdown.** Teams always want to know where their points came from.
   You get it free.

---

## 3. Question lifecycle — the state machine

### DIRECT round (pounce + infinite bounce)

```
IDLE
  │ QM: present question
  ▼
PRESENTED ──────────────────────────────┐
  │ QM: open pounce                     │ (QM may skip pounce entirely)
  ▼                                     │
POUNCE_OPEN                             │
  │  teams submit blind; QM sees only    │
  │  WHO has pounced, not WHAT           │
  │ QM: final call (optional sub-state)  │
  │ QM: close pounce                     │
  ▼                                     │
POUNCE_CLOSED                           │
  │  QM now sees all pounce texts        │
  │ QM: evaluate each → correct/wrong    │
  ▼                                     │
POUNCE_EVALUATED ◄──────────────────────┘
  │ QM: open bounce (starts at direct team)
  ▼
BOUNCE_ON_TEAM(i)
  │ QM: mark correct / partial / wrong / pass
  │   correct  → RESOLVED
  │   partial  → award PENDING, stay in bounce, advance to next team
  │   wrong    → advance to next team (wrapping, per direction)
  │   all teams exhausted → DEAD
  ▼
RESOLVED | DEAD
  │ QM: reveal answer
  ▼
REVEALED     (all PENDING events for this question → APPLIED)
  │ QM: next question
  ▼
IDLE (next question; direct team advances per rule below)
```

**Direct-team advancement rule.** After a question resolves, the next direct question goes
to the team *after the one that answered correctly*, in round direction. If the question died
unanswered, it goes to the team after the previous direct team. Wrap-around is circular.

This is worth stating explicitly in code as a pure function, because it is easy to get wrong
under bounce wrap-around:

```
next_direct_team(round, resolving_team_idx | None, prev_direct_idx) -> idx
```

**Pounce evaluation and bounce interact.** If a team pounced correctly, the question is
resolved and bounce never opens. If all pounces are wrong, those teams have taken −5 each and
bounce proceeds normally — including to teams that pounced wrong (they can still answer on
bounce). Confirm this against your practice; some hosts exclude wrong-pouncers from bounce.

### Partial credit — the exact rule

Multi-part question, worth 10.

- A team answering *some but not all* parts on bounce earns a `PARTIAL` event (typically +5
  for one of two parts) with status `PENDING`. **The answer is not revealed.** Bounce continues.
- A team answering *all* parts earns `BOUNCE_CORRECT` +10, `APPLIED` immediately. Question
  resolves. On reveal, all `PENDING` partials flip to `APPLIED`.
- Points are **not conserved**: a question can yield 15 or more across teams. This is
  intentional and the UI should never warn about it.
- If the question dies unanswered, pending partials still flip to `APPLIED` at reveal.

The QM sets the partial value per award (default = points/num_parts, editable) because parts
are not always equally weighted.

### WRITTEN round

```
IDLE → Q1_SHOWN → Q2_SHOWN → Q3_SHOWN → Q4_SHOWN
     → COLLECTING (one answer sheet live for teams — a single box they number
       their answers on, submitted against every question so the QM can still
       grade question by question)
     → SUBMITTED (QM closes; answers locked)
     → EVALUATING (QM grades question-by-question, all teams at once)
     → REVEALED
```

- +10/0 per question by default.
- **Staking:** a team may stake a given answer for +15/−5. The stake toggle lives next to
  each answer box on the team's side and must be locked at submission.
- Design decision needed: can a team stake more than one of the four? Assume yes unless you
  say otherwise; it's a config flag either way.
- Evaluation UI should be a grid — questions down, teams across — with keyboard grading, not
  a modal per answer.

### VISUAL_CONNECT round

Pounce-only, staged reveals, decaying value.

```
Reveal 1: +20/−15
Reveal 2: +15/−10
Reveal 3: +10/−5
Reveal 4: +5/0
```

- One pounce per team **per question**, not per reveal. Once a team has pounced, they are out
  for the rest of that connect regardless of outcome.
- All teams may pounce at any given reveal stage; each gets that stage's value.
- A correct pounce reveals the answer and ends the question — which means the QM must
  evaluate pounces at each stage *before* advancing to the next reveal.

State machine per reveal stage:

```
REVEAL_N_SHOWN → POUNCE_OPEN → POUNCE_CLOSED → EVALUATED
   │ any correct → RESOLVED → REVEALED
   │ none correct → REVEAL_(N+1)_SHOWN
```

Track `has_pounced[team_id]` for the question, not the stage.

### Tie-breaks

- Primary: total score.
- The system should *display* the tiebreak signals rather than resolve automatically:
  pounces attempted, pounces correct, pounces wrong, per team. These come free from the ledger.
- Tiebreak questions are extra questions appended to the quiz, scored via `TIEBREAK` events.
  The QM decides when to invoke them.

---

## 4. Media pipeline

This is the highest-risk part of the build and it is not the quiz logic.

**Never stream question media over the video call.** Screensharing a video through WebRTC
degrades badly and the audio is worse. Instead:

1. **Preload before the round.** When the QM loads a round, every connected client downloads
   that round's media into a local cache (Cache API / IndexedDB) and reports readiness.
2. **QM sees a readiness grid.** Team-by-team, "media loaded ✓". The QM does not start a
   media question until everyone is green — or explicitly overrides.
3. **Play on cue.** The QM's "play" is a signalling message with a target timestamp; each
   client plays its *local* copy. Sync is then a matter of clock offset (~100ms with a simple
   NTP-style handshake), not bandwidth.
4. **Audio questions** are the same path. Video calls must duck or mute during media playback
   to prevent echo — mute all participant mics by default when media plays, restore after.

Constraint accepted: **one video per question, max.** Multiple images per question are fine
(they're small). This bounds preload size sensibly.

**Storage:** object storage (S3/R2) with signed URLs. Transcode uploaded video to a single
web-friendly rendition (H.264/AAC MP4, capped at 1080p) on upload — do not serve whatever the
QM uploaded.

### What was actually built, and where it diverges

The plan above was written before any of it existed. Three things are not as it describes,
and this section is the record, because the plan is not the code:

**Preloading is sealed, and the divergence is the point.** Step 1 above says clients cache
the round's media and report readiness. They do — but a cache a browser has filled is one
click away in its network tab, so handing a team the images of an unasked question hands
them the question, and on a visual connect it hands them the round. So each asset is
encrypted with AES-256-GCM when it is uploaded and served as ciphertext under a second
identifier unrelated to its plaintext URL (`packages/server/src/sealed.ts`). Clients fetch
the whole round's sealed media on joining and can read none of it. The key rides in the
same view update that presents the question — the moment the plaintext URL would have been
sent anyway — so the key is never earlier than the thing it unlocks. Measured on a real
tunnel: a holding client renders with no network request at all, against roughly a second
without it, and that second is a different second for each team while a pounce window is
open. Every path falls back to the plain URL: no WebCrypto, an unfinished fetch, a decrypt
that throws, an asset uploaded before sealing existed. A slow question is a nuisance; a
question that fails to appear because encryption was involved would be a disaster.

**Steps 2 and 3 are not built.** There is no readiness grid and no clock-offset handshake.
The cue is the ordinary state broadcast, which for images is indistinguishable from a
synchronised play, because the bytes are already local. Both matter for video and neither
is needed before it. Step 4's mic ducking belongs to Phase 3 and the video call it ducks.

**Fetching media by URL is a server fetching a URL somebody else chose.** The importer
(§10) carries links rather than files, and a browser cannot read a cross-origin image as
bytes, so the download happens server-side — which is the shape of every SSRF there has
ever been. `packages/server/src/fetchMedia.ts` is mostly refusal: http and https only, the
hostname is *resolved* and every address checked against loopback, the private blocks and
the link-local range that carries cloud metadata, and redirects are followed by hand with
every hop re-checked, because a check at the front door means nothing if the second hop is
the one that goes somewhere internal. Size is counted while streaming, since content-length
is a claim rather than a fact.

---

## 5. Real-time architecture

### Transport

- **State sync:** WebSocket, server-authoritative. All state transitions go through the
  server; clients render state and send intents. Never let a client compute the score.
- **Reconnection is mandatory, not a nice-to-have.** A team losing their socket mid-pounce
  must reconnect into the exact current state. Implement: server holds full room state,
  client on connect receives a full snapshot, then deltas. Test this by killing wifi
  mid-quiz — it is the single most likely live failure.
- **Video/audio:** SFU (LiveKit or 100ms self-hosted; Daily if you'd rather not run
  infrastructure). At 10–30 participants an SFU is the right call.

### Rooms and roles

```
Room
  QM              (1)   — full control surface
  Team clients    (n)   — up to 3 humans per team, sharing one team identity
  Scoreboard view (0..n) — read-only, for streaming/observers
```

**Multiple humans per team is a real design problem, not a detail.** Three people on one team
identity means: who types the answer? What happens if two type simultaneously? The answer is a
**shared team draft** — a collaboratively-edited text field, last-write-wins with author
attribution, plus an explicit "submit" that any team member can press. Show the other members
who is typing. This replaces the WhatsApp coordination entirely and is one of the strongest
reasons to build this at all.

Team-private audio: with an SFU this is a second room per team. Teams talk freely in their
private channel; the main room is QM-broadcast plus whoever the QM unmutes. This is a genuine
improvement over Meet, where team coordination has to happen out-of-band.

---

## 6. The QM console

Single screen, no tab switching. That is the entire product thesis, so the layout matters.

```
┌─────────────────────────────────────────────┬──────────────────┐
│  QUESTION (what teams see, mirrored)        │  TEAM VIDEO GRID │
│  + QM-only notes / answer / part breakdown  │  (8–10 tiles)    │
├─────────────────────────────────────────────┤                  │
│  STATE BAR: [Present][Open Pounce][Final    │                  │
│  Call][Close][Reveal][Next]  ⏱ 0:14        │                  │
├─────────────────────────────────────────────┼──────────────────┤
│  POUNCE PANEL                               │  LIVE SCOREBOARD │
│  Team 3  "________"       [✓][~][✗]         │  1. T5    85     │
│  Team 7  "________"       [✓][~][✗]         │  2. T2    70     │
│  (blind until closed)                       │  ...             │
├─────────────────────────────────────────────┤                  │
│  BOUNCE: ▶ Team 4  [✓ +10] [~ partial] [✗]  │                  │
│  order: 4 → 5 → 6 → 7 → 8 → 1 → 2 → 3       │                  │
└─────────────────────────────────────────────┴──────────────────┘
```

Non-negotiables for this screen:

- **Keyboard-first.** During a live quiz the QM is talking and reading; hunting for buttons
  breaks flow. Space = advance state, 1–9 = select team, Y/N = correct/wrong, P = partial.
- **The bounce order is always visible** with the current team highlighted. Under wrap-around
  and direction changes, QMs lose track — the screen should never let that happen.
- **Undo is one keystroke** and always available.
- **Nothing auto-advances.** Ever.

---

## 7. Build order

Each phase should end with something you can actually run a quiz on.

### Phase 0 — Content tooling (do this first, it's the sneaky prerequisite)
Question authoring: create rounds, questions, parts, upload media, set answers. Without this
you have nowhere to put the quiz, and you'll otherwise end up hand-editing JSON at 2am before
a quiz. Build it plain and ugly. **~1 week.**

### Phase 1 — Quiz engine, video stubbed
Full state machine, ledger, QM console, team client, scoreboard. Video is an embedded Meet
link beside the app. Run a real quiz on this. **~3–4 weeks.**

The fallback property matters: if the engine breaks you still have Meet, and if Meet breaks
you still have the engine.

### Phase 2 — Media pipeline
Preload, readiness grid, synced play, mic ducking. **~2 weeks.**

### Phase 3 — Native video
SFU integration, main room + team-private rooms, QM mute controls, the video grid in-console.
Reconnection hardening. **~3–4 weeks, and expect the long tail to exceed this.**

### Phase 4 — Written + visual connect rounds
These have their own state models and evaluation UIs. Could be pulled earlier if a specific
quiz needs them. **~2 weeks.**

### Phase 5 — Polish
Post-quiz breakdown export, scoreboard animations, QM audit log, spectator view.

**Deliberately deferred:** prelims/100+ scale, anti-cheat, generic rules engine, multi-quiz
tenancy, mobile-native clients.

---

## 8. Stack recommendation

Opinionated, chosen for "one person building a real-time app that must not break live":

- **Server:** Node + TypeScript. One process holding room state in memory, Postgres for
  durability. Do not start with a distributed state store; 10 teams fits in memory trivially
  and you can shard by room later if you ever need to.
- **Realtime:** raw WebSocket or Socket.IO. Not a BaaS — you want the state machine on your
  server, not in a rules language.
- **Client:** React + TypeScript. Zustand or similar for local state; the server is the truth.
- **Video:** LiveKit (self-host later, cloud first).
- **Storage:** Cloudflare R2 (no egress fees, which matters when 10 clients preload video).
- **DB:** Postgres. The ledger is relational and you'll want SQL over it.

**The one thing worth over-engineering:** the state machine. Write it as a pure reducer with
no I/O, exhaustively unit-tested against your rules — including wrap-around, pending partials,
one-pounce-per-connect, and direction reversal. It is the part where bugs are visible to ten
people at once and unfixable in the moment.

---

## 9. Open questions

**All five are answered.** `FORMAT_SPEC` §5 is the record, with the date and the reasoning
on each; it is normative and this list is not. In short: a pouncer is out of the bounce
whether it was right or wrong, a team may stake as many written answers as it likes,
staking is per question, a connect dies after the final reveal rather than bouncing, and
the QM may adjust any score at any time — with a reason, which the reducer and the schema
both insist on.

1. ~~Can a wrong-pouncing team still answer on bounce?~~ No, and nor can a right one.
2. ~~Can a team stake more than one written-round answer?~~ Yes.
3. ~~Per-question staking or one stake for the whole round?~~ Per question.
4. ~~Long visual connect: a bounce after the final reveal, or does it die?~~ It dies.
5. ~~Manual adjustments mid-quiz?~~ Yes, with a mandatory justification.

---

## 10. Importing an existing question set

Added after the fact, and numbered last so nothing above renumbers. Phase-0 tooling by
rights: a quiz that already exists as a spreadsheet or a PDF should not have to be retyped.

**Everything is parsed in the browser.** The file is never uploaded to read it — a dropped
document is read locally, and only the questions the quizmaster accepts are sent anywhere.
`pdfjs-dist` is a dynamic import so that ~350KB of PDF machinery stays out of the bundle
every team downloads to answer questions on a phone.

Three readers, one intermediate shape (`packages/client/src/import/model.ts`), so the
review screen and the writer do not care where the questions came from:

| Source | How it is read |
|---|---|
| TSV / CSV | Columns matched by normalised name, not position. Quoting is RFC 4180 by hand, because a question containing a comma is ordinary and losing half of it would be silent. |
| PDF question paper | Markers: `Round 1`, `Player 1 Question 2:`, `Answer:`. Prose under an answer becomes QM notes, not part of the answer — in the answer it would be on the reveal slide in front of everyone. |
| PDF slide deck | One question per page, its answer on the next. The page is rendered and attached as a picture, because a slide's question *is* its picture. |

**A review step, always.** Reading someone else's document is guesswork, and a quiz
assembled from a bad guess is discovered in front of ten people. Every question is listed
with the label it had in the source so the screen can be read against the document, rounds
can be dropped, and the import button comes after.

Two things learned from real files. A league spreadsheet that gives each player several
questions in a row does not match this app's rotation, which moves the direct question on
after every question — so the importer says so and leaves the choice alone rather than
quietly reordering somebody's quiz. And page rendering hangs in a tab the browser is not
painting, because `requestAnimationFrame` never fires there: it times out at 15 seconds,
and the first timeout stops the rest, since the cause is the tab rather than the page.

Media is allowed to fail. A dead link in a year-old sheet is normal; the question still
imports and the failure is reported with the link in it, so one thing gets fixed rather
than the whole import re-run.
