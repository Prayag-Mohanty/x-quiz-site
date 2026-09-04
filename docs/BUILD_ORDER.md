# Build Order

Each phase ends with something you can actually run a quiz on. That constraint is the
point — it forces the fallback to stay intact.

---

## Phase 0 — Content tooling ✅ engine done, authoring UI pending

**Why first:** without an authoring tool you will hand-edit JSON at 2am before a quiz.
Build it plain and ugly.

- [x] Format spec written (`docs/FORMAT_SPEC.md`)
- [x] Engine: types, rotation, scoring ledger, reducer
- [x] Engine test suite (37 tests, all rules covered)
- [x] Postgres schema + migrations (`packages/db`) — written, not yet run against a live server
- [ ] Question authoring UI: rounds, questions, parts, media upload, answers
- [ ] Quiz setup: teams, round order, direction per round

**Done when:** you can author a complete quiz and see it stored.

---

## Phase 1 — Quiz engine live, video stubbed

Video is an embedded Meet link beside the app. This is deliberate: if the engine breaks
you still have Meet, and if Meet breaks you still have the engine. Do not skip this.

- [ ] WebSocket server wrapping the reducer; room state in memory, Postgres for durability
- [ ] Full state snapshot on connect, deltas after — **reconnection is mandatory**
- [ ] QM console (see ARCHITECTURE §6): state bar, pounce panel, bounce order, scoreboard
- [ ] Keyboard-first controls
- [ ] Team client: question view, pounce box, shared team draft with typing indicators
- [ ] Public scoreboard view
- [ ] Undo (VOID_EVENT) wired to a single keystroke

**Done when:** you have hosted a real quiz on it.
**Test this first:** kill wifi mid-pounce. It is the most likely live failure.

---

## Phase 2 — Media pipeline

- [ ] Object storage (R2) + signed URLs
- [ ] Transcode uploads to one web rendition (H.264/AAC MP4, ≤1080p)
- [ ] Client preload into Cache API / IndexedDB before each round
- [ ] QM readiness grid — team-by-team "media loaded ✓", with override
- [ ] Synced play: QM cue + clock-offset handshake, clients play local copies
- [ ] Auto-mute participant mics during media playback, restore after

---

## Phase 3 — Native video

Expect the long tail to exceed the estimate. This is where you replace Meet.

- [ ] SFU integration (LiveKit)
- [ ] Main room: QM broadcast + selective unmute
- [ ] Team-private audio rooms — the thing that replaces WhatsApp coordination
- [ ] Video grid inside the QM console
- [ ] Reconnection hardening under real network conditions

---

## Phase 4 — Written + visual connect rounds

Engine support already exists. This is UI.

- [ ] Written round: staged display, collection, stake toggle, evaluation grid
- [ ] Visual connect: staged reveals, per-stage pounce, spent-team tracking

---

## Phase 5 — Polish

- [ ] Post-quiz breakdown export (per-team, from the ledger)
- [ ] Scoreboard animation
- [ ] QM audit log
- [ ] Spectator/stream view

---

## Deliberately deferred

Prelims and 100+ scale · anti-cheat and proctoring · a generic rules engine for other
formats · multi-quiz tenancy · native mobile clients.

**On anti-cheat specifically:** it is not solvable in a browser. A participant has a
phone, a second laptop, a friend on a muted call. Do not position this product as
solving fairness — position it as solving coordination.
