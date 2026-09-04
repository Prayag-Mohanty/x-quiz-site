# Quizmaster

An online quiz platform for **finals-format quizzing** — one application replacing the
current stack of Meet + slides + Google Forms + WhatsApp + Google Sheets.

## The problem

Online quizzing today is spread across four platforms. Questions are screenshared from
slides, answers arrive via Google Forms, pounces come as private WhatsApp messages, scores
live in a spreadsheet, and teammates in different cities coordinate over a separate call.
The QM needs a team of volunteers just to keep track. This collapses all of it into one
screen.

## What it is not

This does **not** solve cheating. Nothing that runs in a browser can — participants have
phones, second laptops, and friends on muted calls. The product solves coordination.

## Start here

| Document | What it covers |
|---|---|
| `CLAUDE.md` | Project context and architecture invariants. Read first. |
| `docs/FORMAT_SPEC.md` | **Normative** quiz rules. Code that disagrees is a bug. |
| `docs/DECISIONS.md` | Stack and architecture choices, pre-made. What's still open. |
| `docs/GLOSSARY.md` | Web/database terms explained for a hardware person. |
| `docs/ARCHITECTURE.md` | Data model, media pipeline, QM console, stack rationale. |
| `docs/BUILD_ORDER.md` | Phased plan with what "done" means per phase. |

## Packages

### `packages/engine`

The quiz state machine and scoring ledger. Pure — no I/O, no dependencies, no mutation.

```bash
cd packages/engine
npm install
npm test        # 37 tests covering every rule in FORMAT_SPEC
```

Two things worth understanding before changing anything here:

**The QM drives the state machine; timers never mutate state.** Every transition is an
explicit quizmaster action. The format has human judgment embedded in it — partial credit,
when to reveal, whether an answer is close enough — and automating those produces a worse
quiz than a spreadsheet.

**Scores are an append-only ledger, not an integer.** Partial credit must be *recorded but
unpublished* until the answer reveal, otherwise later teams could infer a confirmed part
from a visible score change. `PENDING → APPLIED` does exactly that, and gives undo,
post-quiz breakdowns, and tiebreak stats for free.

## Status

Phase 0. Engine complete and tested. Nothing else built yet.
