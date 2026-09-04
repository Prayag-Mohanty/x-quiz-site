# @quizmaster/client

Phase 0 authoring UI. One screen: quizzes on the left, the selected quiz in the
middle, the question you are editing and the readiness panel on the right.

Plain and ugly on purpose. This is the tool that stops you hand-editing JSON at
2am before a quiz — the console that has to work under pressure is the Phase 1
QM console, and that one earns its layout budget.

## Running it

Two terminals. Commands are one per line — Windows PowerShell 5.1 does not
accept `&&` as a separator, and this is a Windows project.

The API, in the first terminal:

```
cd packages/server
npm run build
npm start
```

The client, in the second:

```
cd packages/client
npm run dev
```

Open http://localhost:5173 — `localhost`, not `127.0.0.1`, since Vite binds the
IPv6 name. Vite proxies `/api` to the server on port 3000, so the browser only
ever talks to one origin and CORS never comes up.

`npm run build` in the server is only needed after changing its source.

The server needs `DATABASE_URL` in `packages/server/.env`. See
`packages/db/README.md` for a disposable Postgres if you don't have one.

## How it works

The server is the source of truth; this is a render cache. Every edit calls the
API and then refetches the quiz rather than patching local state optimistically.
That is a deliberate choice, not laziness: the database renumbers positions when
you delete something and rejects writes the format forbids, so guessing the new
state means guessing wrong. At authoring speed the round trip is invisible.

Text fields save on blur rather than on every keystroke — one request per edit,
and one place for a rejection to surface.

Rejected writes are usually the schema enforcing `FORMAT_SPEC`, so the error bar
shows the sentence the server sent ("Two teams in the same quiz cannot share a
name") rather than a status code.

## The two things this UI is careful about

**Team order is the seating order.** A team's position is its seat at the
notional table, and CW/ACW rotation, bounce order and next-direct advancement are
all computed from those indices. The ↑/↓ buttons reorder the whole table in one
request, because the positions have to stay contiguous.

**Direction is only offered on DIRECT rounds**, because it only means anything
there — it is the pounce-and-bounce order. The schema rejects it elsewhere; the
UI simply doesn't offer it.

## Not done

Media upload. Everything else in Phase 0 authoring is here.
