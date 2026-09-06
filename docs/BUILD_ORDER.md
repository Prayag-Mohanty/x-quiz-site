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
- [x] Postgres schema + migrations (`packages/db`) — verified on PostgreSQL 17.11
- [x] Row types + engine↔DB mappers (`packages/db/src`) — 21 tests
- [x] Authoring API (`packages/server`) — quizzes, teams, rounds, questions, parts; 18 tests
- [x] Question authoring UI: rounds, questions, parts, answers (`packages/client`)
- [x] Media upload (local disk for Phase 0; R2 in Phase 2)
- [x] Quiz setup: teams, round order, direction per round

**Done when:** you can author a complete quiz and see it stored.

---

## Phase 1 — Quiz engine live, video stubbed

Video is an embedded Meet link beside the app. This is deliberate: if the engine breaks
you still have Meet, and if Meet breaks you still have the engine. Do not skip this.

- [x] WebSocket server wrapping the reducer; room state in memory, Postgres for durability
- [x] Full state snapshot on connect — reconnection verified; full views rather than deltas
- [x] QM console (`packages/client` `/qm`): state bar, pounce panel, bounce order, scoreboard
- [x] Keyboard-first controls (space advances, y/n judge the bounce, u undoes)
- [x] Team client: question view, pounce box, shared team draft with typing indicators
- [x] Public scoreboard view (`/scoreboard?quiz=…`)
- [x] Undo (VOID_EVENT) wired to a single keystroke
- [x] One port serving everything, so a tunnel exposes the whole app (`docs/RUNNING.md`)
- [x] Access boundary: the authoring API is loopback-only until ADMIN_TOKEN is set

- [x] Manual score adjustment, with a mandatory reason (§5.5)

**Done when:** you have hosted a real quiz on it. **Done — 2026-09-06.** The action log
of that quiz is what turned up the undo bug below; running it found in one evening what
the test suite had not in a week.
**Test this first:** kill wifi mid-pounce. It is the most likely live failure.

---

## Phase 2 — Media pipeline

- [ ] Object storage (R2) + signed URLs
- [ ] Transcode uploads to one web rendition (H.264/AAC MP4, ≤1080p)
- [x] Client preload before each round — sealed with AES-GCM, key released on the cue
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

- [x] Written round: staged display, collection, stake toggle, evaluation grid
- [x] Visual connect: staged reveals, per-stage pounce, spent-team tracking

---

## Phase 5 — Polish

- [x] Post-quiz breakdown export (per-team, from the ledger) — `/breakdown?quiz=…`, CSV
- [ ] Scoreboard animation
- [ ] QM audit log
- [x] Spectator/stream view — the projector view at `/scoreboard?quiz=…`

---

## Deliberately deferred

Prelims and 100+ scale · anti-cheat and proctoring · a generic rules engine for other
formats · multi-quiz tenancy · native mobile clients.

**On anti-cheat specifically:** it is not solvable in a browser. A participant has a
phone, a second laptop, a friend on a muted call. Do not position this product as
solving fairness — position it as solving coordination.
