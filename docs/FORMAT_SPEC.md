# Quiz Format Specification

This is the **normative** description of the quiz format this software implements.
It is the QM's own format. Where code and this document disagree, this document wins
and the code is a bug.

Terminology: **QM** = quizmaster/host. **Team** = a competing unit of up to 3 people in
different physical locations. **Direct** = the team a question is initially posed to.

---

## 1. Global rules

- Finals format. 8–10 teams typical (system must handle 2–12).
- Team names and count are given to the QM before the quiz.
- **The QM drives every transition.** Timers are advisory only. Nothing in the system
  advances a question, closes a window, or awards a point without an explicit QM action.
- Points are **not conserved** per question. A single question may yield more than its
  face value across multiple teams (see partial credit).

---

## 2. Round types

### 2.1 DIRECT round (pounce + infinite bounce)

The standard round. Each question is posed to a direct team; other teams may pounce
before bounce begins.

**Direction.** A round is clockwise (CW) or anticlockwise (ACW).
- CW: team order 1 → 2 → 3 → … → n → 1 (circular)
- ACW: team order n → n−1 → … → 1 → n (circular)
- Round 1 is conventionally CW, Round 2 ACW, but direction is per-round configuration.

**Pounce.**
- Opens after the QM has presented and read the question.
- Written-blind: a team submits text; **no team can see any other team's pounce**, and
  **the QM cannot read pounce contents until the window is closed**. The QM sees only
  *which* teams have pounced while the window is open.
- Window duration is at the QM's discretion (typically 15–20s). A timer may display, but
  only the QM closes the window.
- Scoring: **+10 correct, −5 wrong.**
- One pounce per team per question.
- The direct team does not pounce (the question is already theirs).
- **Pouncing spends your turn.** A team that has pounced is out of the bounce for
  that question, whether it was right or wrong. That is the trade the negative
  marking pays for.
- **The bounce still runs.** A pounce is answered on paper and shown to the QM
  before the question is opened to the room; it does not take the question away
  from the room. After the pounce window closes and pounces are judged, the
  question bounces among the teams that did not pounce.
- **Pounce results are withheld until the reveal.** The QM judges them before the
  bounce runs, but nothing is announced and no score moves until the answer is
  read out. A published pounce result would leak straight into the bounce: a team
  watching the scoreboard would see +10 appear and know the question was already
  answered, or see −5 and know that answer was wrong. Same reason partial credit
  is withheld, and the same mechanism.

**Bounce.**
- Begins at the direct team, then proceeds in round direction, wrapping circularly.
- **Infinite bounce**: continues until a team answers correctly or every team has been
  offered the question (then it dies).
- Scoring: **+10 correct, 0 wrong.** No negative marking on bounce.
- Teams that pounced are skipped. The bounce is offered to the remaining teams in
  round direction; if none of them gets it, the question dies.

**Direct-team advancement.** After a question resolves:
- If a team answered correctly (on bounce), the next direct question goes to the team
  *after that team*, in round direction.
- If the question died unanswered, the next direct question goes to the team *after the
  previous direct team*, in round direction.
- If a team won it on pounce, the next direct goes to the team after the *previous direct
  team* (the pouncing team's position does not shift the rotation).

Example, CW, 8 teams, direct = Team 1: Team 2 answers correctly on bounce → next direct
question goes to Team 3.

**Multi-part questions and partial credit.**

A question may have 2+ parts and is worth 10 marks total.

- A team that answers **some but not all** parts on bounce earns partial points
  (default 10 ÷ number of parts, QM-adjustable per award — parts are not always equally
  weighted).
- **Critically: the answer is NOT revealed after a partial.** Bounce continues. Revealing
  a confirmed part would let subsequent teams join the dots to the remaining part.
- The partial award is **withheld from the public scoreboard** until the answer is
  revealed. It is recorded immediately but published at reveal time.
- A team answering **all** parts earns the full +10, applied immediately, and the question
  resolves.
- On reveal, all withheld partial awards become visible.
- If the question dies unanswered, withheld partials are still published at reveal.
- Multiple teams may each earn partials on the same question.

Worked example — 2-part question worth 10, CW, direct Team 1:
1. Pounce opens, closes, all pounces wrong (those teams −5 each).
2. Bounce → Team 1: gets part A only. Award +5, **withheld**. No reveal. Continue.
3. Bounce → Team 2: wrong. Continue.
4. Bounce → Team 3: gets both parts. Award +10, applied. Question resolves.
5. QM reveals answer. Team 1's withheld +5 is now published.
6. Question yielded 15 points. This is correct and intended.

### 2.2 WRITTEN round

- Four questions displayed one at a time, all answers collected at the end.
- No pounce, no bounce. Every team answers every question.
- Scoring: **+10 / 0** per question by default.
- **Staking:** a team may stake an answer for **+15 / −5**. Stakes are declared at
  submission time and locked when the round closes.
- QM evaluates all teams' answers question-by-question after collection.

### 2.3 LONG VISUAL CONNECT round

- A single connection revealed through a series of images, shown one at a time.
- **Pounce-only.** No bounce.
- Scoring decays with each reveal:

  | Reveal | Correct | Wrong |
  |--------|---------|-------|
  | 1      | +20     | −15   |
  | 2      | +15     | −10   |
  | 3      | +10     | −5    |
  | 4      | +5      | 0     |

- **One pounce per team per question** — not per reveal. Once a team has pounced, they
  are out for the remainder of that connect regardless of whether they were right.
- All teams may pounce at a given reveal stage; each receives that stage's value.
- The QM evaluates pounces at each stage before advancing to the next reveal.
- On any correct pounce, the answer is revealed and the question ends.

---

## 3. Tie-breaking

The system **displays** tiebreak signals; it does not resolve ties automatically.

Signals available per team (derived from the score ledger):
- pounces attempted
- pounces correct
- pounces wrong

The QM decides. Tiebreak questions are additional questions appended to the quiz and
scored via a distinct ledger reason so they can be identified in the breakdown.

---

## 4. Question content

- **Plain text question body is always required.**
- May additionally include: images (1–4 typical), audio, video, or a combination.
- **Maximum one video per question.**
- Answer content is its own slide: text plus optionally an image or video.

---

## 5. Open questions (unresolved — confirm before relying on these)

1. ~~May a team that pounced incorrectly still answer on bounce?~~
   **ANSWERED (2026-09-05): NO — and it applies to every pouncer, not just a wrong
   one.** Pouncing spends your turn on that question. The bounce runs after every
   pounce window, among the teams that did not pounce. `RuleOptions.pouncersMayBounce`
   defaults to `false`; set it true to restore the old assumption.
2. May a team stake more than one of the four written-round answers? *Assumed YES.*
3. Is written-round staking per-question or one stake for the whole round? *Assumed per-question.*
4. ~~After the final (4th) reveal of a long visual connect with no correct pounce, does the
   question simply die, or is there a bounce?~~
   **ANSWERED (2026-09-06): IT DIES.** There is no bounce anywhere in a connect. The last
   image is shown, any pounces on it are judged, and then the answer is revealed.
   `RuleOptions.connectBouncesAfterFinalReveal` stays `false`.
5. Should the QM be able to make arbitrary manual score adjustments mid-quiz (e.g. a
   penalty for a rules violation)? *Assumed YES; ledger supports it.*
