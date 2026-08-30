# CHLOE API Worker (`chloe-api`)

> ## Read this first: **the game does not need this folder.**
>
> CHLOE ships with the record board working **local-only**. Records live in the
> player's own `localStorage`, so **every player sees their own top ten and
> nobody else's** — a "world record" is really a "this-browser record", and the
> board says so on its face (`THIS BROWSER ONLY`).
>
> That is the shipped state, and it is not a bug. Turning it into a real shared
> board needs a **one-time deploy that only the repo owner can do**, because it
> needs `wrangler login` in a browser against their own Cloudflare account.
> Until somebody runs the steps below, nothing changes and nothing errors:
> `CHLOE.data.config.apiUrl` is unset, `engine/records.js` never makes a request,
> and the game behaves exactly as it does today.
>
> **The same is true of PvP (§32).** With no `CHLOE.data.config.netUrl` the
> deathmatch runs on `BroadcastChannel`, which needs no server at all — two tabs
> in one browser, and the lobby says `LOCAL TABS` on its face. The relay below is
> what turns that into play across machines, and it is the same one-line opt-in.

A zero-dependency Cloudflare Worker, entirely on the **free** plan (a
`workers.dev` subdomain, a free KV namespace and a free SQLite-backed Durable
Object).

---

## What it serves

### The record board (live — GAME_SPEC.md §27E)

| Endpoint                 | Body                             | Success                                   |
|--------------------------|----------------------------------|-------------------------------------------|
| `GET /records[?limit=N]` | —                                | `{ok:true, records:[...]}`                |
| `POST /records`          | `{name, round, timeMs, patch}`   | `{ok:true, record, records:[...]}`        |

A record is `{name, round, timeMs, patch, dateISO}`, sorted **round descending,
then time ascending**, then oldest claim first — byte-identical to the sort in
`game/js/engine/records.js`, so the local and world boards can never disagree
about who is in front.

Rules the server enforces (a client is never a validator):

- **`name`** — scrubbed of control characters, zero-widths and `< > & " ' \``,
  whitespace collapsed, then capped at **12 characters**. Rejected with `400`
  if nothing survives.
- **`round`** — integer, `1`–`100000`. **`timeMs`** — integer, `0`–30 days.
  Anything outside those is `400`, not clamped: a request that far off is a bug
  or an attack, and quietly storing a corrected version of it hides both.
- **`patch`** — must match `^[\w.\-+ ]{1,16}$`, otherwise it is stored as `?`.
  It goes onto a canvas in other people's browsers, so it is whitelisted rather
  than escaped.
- **`dateISO`** — **ignored if sent.** The server stamps it. A client-supplied
  timestamp is the first field a cheat would reach for.
- **Body size** — `413` over 2KB. A record is ~120 bytes.
- **Table cap** — the table keeps the best **100**; a bare `GET` returns the top
  **10** (§27E), `?limit=N` up to 100.
- **Rate limit** — **5 `POST`s per IP per minute** (`429` beyond that), keyed on
  `CF-Connecting-IP`. Reads are **not** metered, because metering a read costs a
  KV write per read and the free plan allows only 1,000 writes/day.

There is **no auth**, deliberately. A record is a name on a wall, not an
account; asking a player to register before they can be on the board would cost
more than the board is worth. What that buys an attacker is a fake name and a
fake round number, capped at 5/minute — a small friendly board, not a
tamper-proof one. If that ever stops being an acceptable trade, the mothballed
account routes below are the shape to reach for.

### The PvP relay (live — GAME_SPEC.md §32)

| Endpoint                                 | Success                          |
|------------------------------------------|----------------------------------|
| `GET /pvp?room=CODE` + `Upgrade: websocket` | `101`, joined to that room    |

One **Durable Object per room code** (`class PvpRoom`, binding `PVP_ROOM`),
addressed with `idFromName(code)` — so everyone who types the same code lands
in the same object, from anywhere in the world. It stores nothing durable; it
holds live sockets and forgets the room when the last one leaves.

A plain `GET /pvp` with no upgrade gets `426` in the house JSON envelope; a
code that survives no scrub gets `400`; a Worker deployed without the
`durable_objects` block answers `503` rather than an opaque `500`.

**Room codes.** Upper-cased, then everything that is not `A-Z0-9` is stripped,
then bounded to **3–8 characters**. `abcd`, `AB-CD` and `abcd ` are the same
room. The game mints 4 characters (`roomCodeLen` in `game/js/data/pvp.js`); the
bounds are loose on both sides so changing that never needs a redeploy. The
parameter is `?room=`, and `?code=` / `?r=` are accepted for the same value.
A room code is a **rendezvous, not a password** — 4 alphanumerics is ~1.7
million codes, which is plenty against a collision and nothing at all against
somebody who wants in. There is no lobby auth.

**What the room enforces** (the client is never a validator here either):

- **8 sockets.** The ninth joiner is completed to `101` and then closed with
  application code **`4001`**, rather than being refused at the handshake: a
  handshake that never reaches `101` arrives in the browser as a bare `1006`
  with no reason, and the lobby could not tell "room full" from "relay
  offline". Those want different words on screen.
- **Text JSON only, ≤ 2048 characters.** Binary frames and oversized ones are
  dropped. A `state` frame is ~120 characters.
- **60 messages per second per socket.** Over that, frames are dropped but the
  socket stays — a burst is far more often a lag spike catching up than an
  attack, and closing on one would eject a player for their own wifi. A socket
  past **600 in one second** is a send loop, not a spike, and is closed with
  **`4002`**. The counter lives in the object's memory, *not* in KV: the record
  board's `rateLimited()` costs a KV write per call against a 1,000/day budget,
  and a full room carries ~120 messages a second.
- **Display names are scrubbed**, with literally the same function as a record
  name — control characters, zero-widths and `< > & " ' \`` removed, whitespace
  collapsed, capped at **12**. A PvP name goes onto a canvas in seven other
  browsers, which is the same path `patch` takes. The host's `roster` is
  scrubbed too; the host is just another client.
- **Fan-out excludes the sender.** The sender already knows what it said.

The relay speaks on its own behalf in exactly **one** place: when a socket
dies, it emits the `{t:'bye', id}` that peer would have sent, using the `id`
and `v` it captured from that peer's own `hello` (so it never invents a
protocol version). A crashed tab never says goodbye, and without this every
other client carries a ghost body until `peerTimeoutMs` expires.

#### The cheating trade — read this before you host a tournament

**The relay does not simulate the match.** It is fan-out and a socket cap;
every fact about the fight is asserted by a client and believed. §32 partitions
authority so no two honest peers can contradict each other — you own your
position and your life total, an attacker owns "my swing hit you for N", a
victim owns "I died, and X killed me" — but *authority* is not *verification*.
A modified client can claim damage it never dealt, refuse to register a hit, or
simply never say it died.

That is deliberate, and it is the same trade the record board makes one section
up: **a friendly game with people you know, not a competitive ladder.** The fix
is an authoritative server simulation, and that cannot run on the free static
hosting this game is built for — it would need the game's own physics, arena
and combat loop running server-side, which is a different project with a
different bill. Stated plainly so nobody is surprised by it later.

### Cloud saves (mothballed — do not wire up)

`POST /register`, `/login`, `/save`, `/load`, all `{name, pinHash, ...}`.
**Nothing in the game calls these.** CHLOE became a roguelike in §15 — no
accounts, no saves, permadeath — and reconnecting them would break that rule.
They are kept in `worker.js` because the record board reuses the same deploy,
the same KV namespace and the same CORS contract, and a working example of the
auth shape is more use in the file than in git history.

| Endpoint    | Body                     | Success                      | Errors                      |
|-------------|--------------------------|------------------------------|-----------------------------|
| `/register` | `{name, pinHash}`        | `{ok:true}`                  | `409` name taken            |
| `/login`    | `{name, pinHash}`        | `{ok:true, savedAt}`         | `401` wrong PIN / unknown   |
| `/save`     | `{name, pinHash, save}`  | `{ok:true, savedAt}`         | `401`, `413` over 64KB      |
| `/load`     | `{name, pinHash}`        | `{ok:true, save, savedAt}`   | `401`                       |

`pinHash` is never returned by any endpoint.

### Everything else

Unknown paths and wrong methods return `404`. CORS is wide open
(`Access-Control-Allow-Origin: *`, methods `GET, POST, OPTIONS`) so the game can
call it from GitHub Pages, Cloudflare Pages or `file://`.

**CORS does not apply to `/pvp`.** Browsers do not preflight `new WebSocket()`,
so the `101` carries no CORS headers at all — it cannot, a handshake response
with extra headers is a handshake that can fail. Origin gating on the relay, if
it is ever wanted, has to be an explicit `Origin` header check inside
`handlePvpUpgrade`; the CORS block will not do it for you.

### Storage layout

| Key                        | Value                            |
|----------------------------|----------------------------------|
| `records:v1`               | `{v:1, rows:[record, ...]}`      |
| `rl:<ip>`                  | `{n, until}` — 120s TTL          |
| `acct:<name lowercased>`   | `{pinHash, save, savedAt}` (mothballed) |

All three are KV (`CHLOE_KV`). The `PVP_ROOM` Durable Object writes **nothing**
— no KV, no SQLite rows, no alarms. A room is its live sockets and a per-socket
message counter that is allowed to vanish when the room hibernates.

---

## Deploy — the one-time steps (owner only)

Prerequisites: Node.js, and a free Cloudflare account at
[dash.cloudflare.com](https://dash.cloudflare.com).

**Step 2 is the one that cannot be done for you** — it opens a browser and asks
you to approve access to your own Cloudflare account. Until you run it, the
game stays local-only.

1. **Install wrangler.**

   ```
   npm i -g wrangler
   ```

2. **Log in.** Opens a browser window; approve the request.

   ```
   wrangler login
   ```

3. **Create the KV namespace.** Run from this `worker/` directory.

   ```
   wrangler kv namespace create CHLOE_KV
   ```

   It prints a snippet containing `id = "..."` — a 32-character hex string.

4. **Paste that id into `wrangler.toml`**, replacing `REPLACE_ME`:

   ```toml
   kv_namespaces = [
     { binding = "CHLOE_KV", id = "<the id you just got>" }
   ]
   ```

5. **Deploy.**

   ```
   wrangler deploy
   ```

   On the first deploy wrangler may offer to register a `workers.dev`
   subdomain — accept the default. It then prints the Worker URL:

   ```
   https://chloe-api.<your-subdomain>.workers.dev
   ```

   This deploy also applies the `[[migrations]]` block in `wrangler.toml`,
   which creates the `PvpRoom` Durable Object class. There is no separate
   command for it and nothing to paste back into the config — unlike the KV
   namespace, a DO binding needs no id. If it fails with a message about the
   plan, check that the migration says **`new_sqlite_classes`** and not
   `new_classes`: the KV-backed classes are paid-plan only.

6. **Check it before wiring it in.**

   ```
   curl https://chloe-api.<your-subdomain>.workers.dev/records
   ```

   Expected: `{"ok":true,"records":[]}`.

   ```
   curl -X POST https://chloe-api.<your-subdomain>.workers.dev/records \
     -H "Content-Type: application/json" \
     -d "{\"name\":\"test\",\"round\":3,\"timeMs\":60000,\"patch\":\"v0.25.0\"}"
   ```

   Expected: `{"ok":true,"record":{...},"records":[...]}`. A sixth POST inside
   the same minute should come back `429` — that is the rate limiter working,
   not a failure.

   The relay answers over plain HTTP too, which is the cheap way to prove it is
   there without a WebSocket client:

   ```
   curl "https://chloe-api.<your-subdomain>.workers.dev/pvp?room=TEST"
   curl "https://chloe-api.<your-subdomain>.workers.dev/pvp?room=%20"
   ```

   Expected: `426` with `"GET /pvp is a WebSocket endpoint..."` for the first —
   a route that answers `404` instead means the deploy predates §32 — and `400`
   with the room-code message for the second. A `503` saying the relay is not
   deployed means the `durable_objects` block never made it into
   `wrangler.toml`. **Make the probe fail on purpose:** the second curl is that
   check, so run it, or a `426` from a stale deploy will read as success.

7. **Wire it into the game.** Add `apiUrl` to `CHLOE.data.config` in
   `game/js/data/config.js` (§15 removed the field; the record board is what
   brings it back), with **no trailing slash**:

   ```js
   apiUrl: 'https://chloe-api.your-subdomain.workers.dev'
   ```

   Leave it absent or `''` to stay local-only.

8. **Wire the PvP relay in — optional, and separate from the board.** Add
   `netUrl` to the same `CHLOE.data.config`, with **no trailing slash** and a
   **`wss://`** scheme (the game is served over HTTPS; a `ws://` URL from an
   HTTPS page is blocked as mixed content before it reaches the network):

   ```js
   netUrl: 'wss://chloe-api.your-subdomain.workers.dev'
   ```

   `engine/net.js` appends `/pvp?room=<code>` to it, the same way
   `engine/records.js` appends `/records` to `apiUrl`. The two keys are
   independent: a world record board with local-tabs-only PvP is a perfectly
   sensible deploy, and so is the reverse.

**Rolling back is one line each:** delete `apiUrl` again and `engine/records.js`
falls straight back to the local board, because the remote list is only ever
used after a `GET /records` has actually succeeded. Delete `netUrl` and the
lobby drops back to `BroadcastChannel` and says `LOCAL TABS`. Neither deletion
needs a redeploy of this Worker.

---

## How the game behaves either way

`engine/records.js` treats the network as decoration, never as a dependency:

- **No `apiUrl`** — nothing is requested. `source()` is `'local'`, the board
  reads `localStorage['chloe.records.v1']` and prints `THIS BROWSER ONLY`.
- **`apiUrl` set, server reachable** — a `GET /records` on startup swaps the
  displayed list to the world one and the footer reads `WORLD RECORDS`.
- **`apiUrl` set, server down / slow / CORS-blocked / offline** — the 4-second
  request fails silently and the board stays local. Nothing throws, nothing
  blocks the room, no error reaches the player.
- **Submitting** — the record is written to `localStorage` **first**, then
  pushed to the server fire-and-forget. A dead server costs the player nothing;
  they keep their own record either way.

A player's local board is never erased when a world board appears — the two are
separate, and a browser that later loses its connection falls back to the
records it already had.

`engine/net.js` treats the relay the same way (§32 calls it "the `records.js`
law"): no `netUrl` and no request is ever made, the deathmatch runs on
`BroadcastChannel` between tabs of one browser, and the lobby says which
transport it is on because "8 players" means something different on each. A
`netUrl` that points at a dead or unreachable Worker reports through the
lobby's error path and leaves the rest of the game exactly as it was — PvE never
touches any of this.

---

## Free-tier limits (plenty for this game)

- Workers: 100,000 requests/day.
- KV: 100,000 reads/day, **1,000 writes/day**, 1 GB storage.
- The write budget is why reads are unmetered and writes are rate-limited: at
  5 POSTs/minute/IP the board would need ~200 distinct busy players to run the
  daily write budget out, and each one costs 2 writes (the table and the
  limiter).

### What a held socket actually costs

Durable Objects are billed on two axes, and the relay sits on both: **duration**
while the object is awake, and **requests**, which under the WebSocket
Hibernation API counts every inbound message, not just the handshake. The free
plan includes roughly **1,000,000 DO requests** and **400,000 GB-s of duration**
a month. Storage does not enter into it — `PvpRoom` persists nothing.

The arithmetic, for a full 8-player, 10-minute match:

| | |
|---|---|
| Inbound `state` frames | 8 players × 15 Hz (`sendHz`) = **120/second** |
| Over 10 minutes | 600 s × 120 = **72,000 requests** |
| Duration for the same match | 600 s awake at 128 MB = **75 GB-s** |
| Request allowance | ~**13** such matches a month |
| Duration allowance | ~**5,300** such matches a month |

So **requests bind first, by about 400×**, and `sendHz` in
`game/js/data/pvp.js` is the single dial that moves the number — it is linear,
and halving it doubles the month. Four players instead of eight is 60 frames a
second, or ~27 matches.

**What hibernation buys is everything that is not a match.** A held socket bills
duration for as long as it is open, whether or not anybody is playing: eight
players sitting in a lobby picking names, or one tab forgotten overnight, would
be ~8 hours of an awake object — about 3,600 GB-s, near 1% of the month's
duration for zero gameplay, and ten forgotten tabs is a tenth of it. With
`state.acceptWebSocket()` the object is evicted between messages and an idle
room costs nothing at all. That is why the room uses the hibernation handlers
and not `server.accept()`, and it is not a micro-optimisation — it is the
difference between a mode that runs on the free plan and one that does not.

Those are the published allowances at the time of writing, and the request line
in particular depends on Cloudflare counting each inbound WebSocket message as
a request. **Check the current pricing page before planning a tournament on
it** — and note that the whole table above is a *hobby* budget. This is a
friendly game for people you know; see the cheating trade above for the other
half of that same sentence.

## A known limit worth writing down

`POST /records` is a read-modify-write against a single KV key, and KV has no
compare-and-set. Two records landing in the same instant can lose one. That is
still accepted deliberately — but the reason this file used to give has
expired, and it is worth saying so rather than quietly rewriting it. It read:
*the fix is a Durable Object, which is not on the free plan this game is hosted
from.* That stopped being true in **April 2025**, when Cloudflare opened
SQLite-backed Durable Objects to the Workers Free plan; the `PvpRoom` relay
above is one, on this very deploy, at no cost.

What survives of the old reasoning is only the cheaper half: the failure mode
is a rare lost record on a hobby board, and moving the table onto a DO is a
migration nobody has needed yet. It is now a choice, not a constraint.
