# Quizmaster

An online quiz platform for **finals-format quizzing** — one application replacing the
current stack of Meet + slides + Google Forms + WhatsApp + Google Sheets. 

## The problem

Online competitive quizzing today spans four platforms. Questions are screenshared from
slides, answers arrive via Google Forms, pounces come as private WhatsApp messages, scores
live in a spreadsheet, and teammates in different cities coordinate over a separate call.
The QM needs a team of volunteers just to keep track. This collapses all of it into one
screen. This is my take on streamlining pounces online.

The product solves coordination.This does **not** solve cheating/googling.
## Start here

| Document | What it covers |
|---|---|
| `CLAUDE.md` | Project context and architecture invariants. Read first. |
| `docs/FORMAT_SPEC.md` | **Normative** quiz rules. Code that disagrees is a bug. |
| `docs/DECISIONS.md` | Stack and architecture choices, pre-made. What's still open. |
| `docs/GLOSSARY.md` | Web/database terms explained for a hardware person. |
| `docs/ARCHITECTURE.md` | Data model, media pipeline, QM console, stack rationale. |
| `docs/DATA_MODEL.md` | How the engine's types map onto the Postgres schema. |
| `docs/BUILD_ORDER.md` | Phased plan with what "done" means per phase. |
| `docs/RUNNING.md` | How to run a quiz other people can actually join. |

---

## Running it

You need PostgreSQL 14+ and Node 22+. Create a database, apply the migrations in order,
then start the two processes.

```
Get-ChildItem packages/db/migrations/*.sql | Sort-Object Name | ForEach-Object {
  psql -d quizmaster -v ON_ERROR_STOP=1 -f $_.FullName
}
```

Apply them in numeric order — the loop above does that, and does not go stale
when another one is added.

Put a `DATABASE_URL` in `packages/server/.env`, then, in two terminals. One command per
line — Windows PowerShell 5.1 has no `&&`, and this is a Windows project:

```
cd packages/server
npm install
npm run build
npm start
```

```
cd packages/client
npm install
npm run dev
```

Open <http://localhost:5173> — `localhost`, not `127.0.0.1`, since Vite binds the IPv6
name. On Windows PowerShell use `npm.cmd` rather than `npm`; `packages/client/README.md`
explains that and the other shell papercuts.
`packages/db/README.md` has a recipe for a disposable Postgres if you would rather not
install a permanent one.

### The four screens

| URL | Who it is for |
|---|---|
| `/` | Authoring. Write the quiz: teams, rounds, questions, parts, answers. |
| `/qm` | The quizmaster console. Drives the live quiz. |
| `/play` | The team client. Teams join with a short code. |
| `/scoreboard?quiz=…` | The projector view: the question, the bounce, the answer at reveal, the scores. Safe to share. |
| `/breakdown?quiz=…` | Post-quiz report: every award, every answer written. Needs your token. |

The authoring screen has a **Run this quiz** panel with your console link, the scoreboard
link, and one join code per team.

Question and answer text take simple inline formatting — `**bold**`, `*italic*`,
`_underline_` — with B / I / U buttons over each field. The markers are stored as plain
text, so a question written before they existed is still a valid question, and one written
with them is still readable in `psql`. An unclosed marker stays literal, so `2 * 3` and
`snake_case` mean what they say.

### Letting other people in

The setup above answers only to the machine it runs on, which is right for
writing questions and useless for running a quiz. **`docs/RUNNING.md`** covers
the difference: building the client so everything is one port, what stays open
to players and what does not, and getting teams in from other cities.

---

## How a quiz actually runs

**You still need a video call.** That is deliberate, not an omission: Phase 1 leaves
voice and video on Meet or Zoom beside the app, so that if the app breaks you still have
the call and if the call breaks you still have the app. The app is the quiz. The call is
the room. Native video is Phase 3.

Concretely, three things people ask about:

### How teams discuss among themselves

Each team gets a **Team notes** box on its own screen — one shared text area for that
team. Any of the three members can type in it, everyone on that team sees the text as it
changes, and it shows who is typing. Nobody outside the team ever receives it.

That replaces the WhatsApp thread, which is the coordination the format actually needs:
one agreed answer, written down where the person who submits it can see it. It does not
replace talking. **Teammates who want to talk still need their own call** — a second Meet
room, a Discord channel, whatever they already use. Team-private audio rooms are the
Phase 3 item that removes that, and they are not built.

### How the QM takes bounce answers

**Out loud, on the call.** The bounce is a spoken round: the app tells everyone whose
turn it is — the bounce order sits on every screen with the current team marked, and that
team gets "Your turn — answer out loud" — and then you listen and press a key.

`y` correct, `n` wrong or pass, `b` steps back a team if you press the wrong one. On a
multi-part question the partial buttons are pre-computed from the split you authored, so
partial credit is a click rather than arithmetic done live.

Pounces are the opposite and always have been: **typed, never spoken**, submitted blind.
You see who has pounced while the window is open and what they wrote only after you close
it — the rule binds you too, so the decision to close is not coloured by what came in.

### What to put on the shared screen

`/scoreboard?quiz=…` — it carries the question as it is presented, whose turn it is on the
bounce, the answer when you reveal it, and the scores. It has a full-screen button, and it
needs no credential, so it can go on a projector, into a screenshare, or to a spectator.

It shows exactly what a team is allowed to see and nothing that is theirs: no pounce text,
no canonical answer before the reveal, and APPLIED points only — a partial you have awarded
and not yet revealed is as absent from it as it is from a team's screen.

Teams do not need it; the question is already on their own screens, and they can full-screen
it there.

### How the QM sees the teams

**By name, not by face.** The console's *Who is here* panel lists every team with the
people currently connected under it, live. That answers "are we waiting for someone?",
which is the question that actually stalls the start of a quiz. Teams see the same panel.

There is no video grid in the console — you are looking at the video call for faces. A
grid inside the console is Phase 3, alongside the SFU.

---

## Packages

### `packages/engine` — the state machine

Pure: no I/O, no clock, no randomness, no dependencies. Every transition is a function of
the previous state and one explicit QM action. `npm test` runs 60 tests covering every rule
in `FORMAT_SPEC`.

### `packages/db` — schema and mapping

Raw SQL migrations, row types, and the translation between database rows and the engine's
types. No `pg` and no queries — it is the schema and the mapping, nothing else. 35 SQL
assertions run against a real Postgres, plus 21 mapping tests.

### `packages/shared` — the wire protocol

Types only. Client-to-server messages mirror the engine's `Action` type rather than
inventing a second vocabulary for the network.

### `packages/server` — Fastify, Postgres, WebSockets

The authoring API, the live room, and the socket layer. One quiz in flight is one room
holding one `QuizState` in memory; Postgres is durability, not the live store. 65 tests,
against a real database and real sockets, including the access boundary that keeps the
answers behind the quizmaster's token.

### `packages/client` — Vite + React

All five screens in one bundle, and the server serves the build so everything is one
origin on one port. The server is the source of truth; the client is a render cache. The
team screen has two layouts: one column on a phone, question-plus-sidebar on a desktop.
18 tests on the inline text formatter and the slide spacing. Inter is bundled from npm
rather than fetched from a CDN, so a question never renders in a fallback face because
someone's DNS was slow mid-quiz.

---

## Three ideas that shape the code

**The QM drives the state machine; timers never mutate state.** Every transition is an
explicit quizmaster action. The format has human judgment embedded in it — partial credit,
when to reveal, whether an answer is close enough — and automating those produces a worse
quiz than a spreadsheet. Timers may render a countdown; a timer callback that dispatches an
action is a bug.

**Scores are an append-only ledger, not an integer.** Partial credit must be *recorded but
unpublished* until the answer reveal, otherwise later teams could infer a confirmed part
from a visible score change. `PENDING → APPLIED` does exactly that, and gives undo,
post-quiz breakdowns, and tiebreak stats for free. The database enforces this with a
trigger: ledger rows cannot be deleted or edited, only voided.

**Nobody receives the quiz state.** The server holds one `QuizState` and sends each client
a projection built for its role. That is not a rendering convenience — a team can open dev
tools and read whatever their browser received, so anything they must not know is never
sent. The answer is absent until the reveal, a team gets its own pounce text and never
another's, and withheld partials never cross the wire to a team at all.

---

## Status

**Phases 0, 1, 4 and part of 5 are built.** Every round type in `FORMAT_SPEC` has a
console and a team screen, the whole thing runs from one port through a tunnel, and there
is a post-quiz report.

**It has now run a real quiz** — 2026-09-06, five teams, three rounds, 185 actions in the
log. That was Phase 1's definition of done, and it earned its keep immediately: the log
of that quiz showed the quizmaster pressing undo fifteen times in twelve seconds against
one award, because "Undo last" pointed at an event it had already voided and said nothing.
No test had caught it. That is what running one is for.

### Done

| | |
|---|---|
| **Authoring** | Teams, rounds, question order, multi-part answers with point splits, images and audio, readiness checks. Inline `**bold**` / `*italic*` / `_underline_` on questions and answers. |
| **Direct rounds (§2.1)** | Written-blind pounce, infinite bounce with the order always on screen, partial credit recorded and withheld until the reveal, correct direct-team advancement. |
| **Written rounds (§2.2)** | Questions read one at a time above a single answer sheet, per-question staking, a grading grid across every team. |
| **Visual connect (§2.3)** | Staged reveals with the decay ladder on both screens, one pounce per team per connect, spent-team tracking. |
| **Running it** | QM console, team client, live scoreboard, undo on one key, manual score adjustment with a mandatory reason, reconnection into the exact current state, five clients acting at once converging on one state. |
| **Presenting** | `/scoreboard?quiz=…` — question, bounce, answer at reveal, scores. No credential, full-screen, safe to project. |
| **Afterwards** | `/breakdown?quiz=…` — every award attributed, what each team wrote, tiebreak signals, two CSVs. |
| **Getting people in** | One port serving everything, an access boundary that keeps the answers behind the quizmaster's token, and `docs/RUNNING.md` for LAN versus a tunnel. |

### Left

- **Phase 2 — media pipeline.** Object storage, a team-by-team "media loaded" grid, and
  synced playback on a QM cue. Images are now downscaled in the browser before upload, so
  a question image reaches a team in about a second through a tunnel rather than four.
  Preload is deliberately NOT built — see below. Video is still untested.
- **Phase 3 — native video.** LiveKit, QM broadcast with selective unmute, team-private
  audio rooms, a video grid in the console. This is the part that removes the second
  browser window.
- **Phase 5 — the rest of the polish.** Scoreboard animation and a QM audit log. The
  spectator view is done — it is the projector view above.
- **Hosting.** Deliberately deferred until a real quiz has been run. A tunnel is the
  stand-in and it is enough.

### Preload, and why it is not built

`ARCHITECTURE` calls for question media to be preloaded to clients and played on the QM's
cue. It is not built, because preloading means sending a team the media of a question that
has not been asked yet — and on a visual connect that is the whole round. Anything a
browser has fetched is one click away in its network tab, so there is no version of this
that is merely inconvenient to look at.

Measured through a Cloudflare tunnel, the cost of not preloading is about a second for a
normal image and roughly four for an unoptimised 4MB one, of which ~0.7s is the round trip
that no amount of preloading removes. Downscaling on upload takes most of the rest.

If the remaining second matters — it is a fairness question on a connect, since teams see
the image at slightly different moments while a pounce window is open — the honest fix is
to preload the bytes encrypted and release the key on the cue. That is real work and a
real decision, not a default.

### Open rules

None. `FORMAT_SPEC` §5 tracked five rules that were genuinely undecided and all five are
now answered and implemented: pouncers are out of the bounce, a connect dies after the
final reveal, staking is per question, a team may stake as many written answers as it
likes, and the QM may adjust any score at any time — with a reason, which the reducer and
the schema both insist on.

### Test suites

```
cd packages/engine && npm test    # 70 — the state machine, every rule in FORMAT_SPEC
cd packages/db     && npm test    # 21 — row-to-domain mapping
cd packages/server && npm test    # 73 — API, projections, sockets, access, concurrency
cd packages/client && npm test    # 27 — text formatting, slide spacing, image sizing
psql -d quizmaster -f packages/db/test/smoke.sql   # 35 — the schema enforces FORMAT_SPEC
```

The server suite needs `DATABASE_URL` and runs against a real Postgres; it creates its own
quizzes and deletes them afterwards, so it is safe against a database with real ones in it.
