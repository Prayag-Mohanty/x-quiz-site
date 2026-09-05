# Running a quiz other people can join

The development setup runs two processes on two ports and answers only to the
machine it runs on. That is right for writing questions and wrong for running a
quiz: four teams in four cities need one URL that works from their laptops.

This document is the difference between those two states.

---

## One port, not two

`npm run dev` starts Vite on 5173 and the API on 3000, and Vite proxies `/api`,
`/ws` and `/media` across. That is a development convenience and it does not
travel: a tunnel exposes one port, and "open :5173, but the API is on :3000" is
not something you can say to four teams over a video call.

So build the client once and let the server serve it. Then everything — the
pages, the API, the sockets, the uploaded images — is on port 3000.

```bash
cd packages/client; npm run build
```

```bash
cd packages/server; npm run build; npm start
```

`http://localhost:3000` now serves all five screens. The server looks for
`../client/dist` and skips this silently if there is no build, so the two-port
dev setup still works exactly as before.

---

## Who is allowed to do what

Four things are open to anyone who can reach the server, because the people
using them are the players:

| Path | Guarded by |
|---|---|
| `/play` and `/api/join` | the team's join code |
| `/qm` and `/api/join/qm` | the quizmaster token in the link |
| `/scoreboard?quiz=…` | nothing — it is meant to be projected |
| `/breakdown?quiz=…` | the quizmaster token, in a header |

Everything else under `/api` is the **authoring** tool, and the authoring tool
can read every canonical answer in the database, mint join codes, and hand out
the quizmaster token. The quiz id is not a secret — it is sitting in the
scoreboard URL — so an open authoring API means any player who changes the path
can read the answers.

`packages/server/src/access.ts` enforces this:

- **`ADMIN_TOKEN` unset** — authoring answers requests from the machine the
  server runs on, and nobody else. This is the default, so the local workflow
  needs no configuration and exposing the server by accident fails closed.
- **`ADMIN_TOKEN` set** — authoring requires that token in an `x-admin-token`
  header, from anywhere including localhost. The authoring page prompts for it
  and remembers it.

Set one before exposing the server, even if you only ever author from your own
laptop — the token, not the machine, is then the credential:

```bash
cd packages/server; $env:ADMIN_TOKEN = "pick-something-long"; npm start
```

---

## Same building: the local network

Bind to every interface instead of loopback:

```bash
cd packages/server; $env:HOST = "0.0.0.0"; npm start
```

The server prints the addresses it is listening on. Give teams
`http://<that address>:3000/play`.

Two things that stop this working, in order of likelihood:

**Client isolation.** Most university and café networks (eduroam included) stop
devices on the wifi from talking to each other. Nothing you can configure on
your laptop fixes it. Use a tunnel instead.

**Windows Firewall.** If the address is right and nothing loads, allow the port
from an administrator shell:

```bash
New-NetFirewallRule -DisplayName "Quizmaster" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

A local network is useful for testing on your own phone. It is not how this
product is meant to be used — the format is people in different cities.

---

## Different cities: a tunnel

A tunnel gives your laptop a public HTTPS address without opening a port,
buying a domain, or deploying anything. Cloudflare's quick tunnels need no
account:

```bash
winget install --id Cloudflare.cloudflared
```

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a `https://something-random.trycloudflare.com` URL. Everything works
through it — WebSockets included, which is the part that usually breaks. Teams
open `<that URL>/play`, you open `<that URL>/qm?token=…`.

Three things to know before you rely on it:

- **The URL changes every run.** Fine for a quiz you are starting now; useless
  for a link you sent yesterday. Start the tunnel, then send the link.
- **Your laptop is the server.** Close it, sleep it, or lose wifi and the quiz
  stops for everyone. Plug it in and turn off sleep.
- **Set `ADMIN_TOKEN` first.** The tunnel is public. Without a token the
  authoring API is closed to the whole internet, which is safe but also means
  you cannot edit through the tunnel either.

`HOST` can stay unset with a tunnel — cloudflared connects to `localhost:3000`
from the same machine.

---

## Before the quiz starts

- **Postgres has to be running.** On this machine it is a Windows service
  (`QuizmasterPostgres`) and starts with the computer. `packages/db/README.md`
  covers registering one.
- **Do not edit the quiz while it is running.** The live room replays the action
  log through the reducer, so a question deleted mid-quiz makes the log
  unreplayable and the room refuses to rebuild. Author first, then run.
- **Check the readiness panel.** The authoring screen lists what would block the
  quiz — no teams, empty questions, a direct round with no parts.
- **Open the breakdown afterwards.** `/breakdown?quiz=…` answers "how did we get
  45" and "what did we actually write", and flags any points that were scored
  and never revealed.

---

## Beyond this

Real hosting is deferred on purpose (`docs/DECISIONS.md`) until Phase 1 has run
a real quiz. A tunnel is not hosting — it is one command and no infrastructure,
which is exactly what that deferral was protecting. When the quiz has actually
been run and the thing is worth hosting, the change is small: this already
builds to one process serving one port, which is what every host wants.
