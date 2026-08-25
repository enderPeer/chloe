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
> Until somebody runs the seven steps below, nothing changes and nothing errors:
> `CHLOE.data.config.apiUrl` is unset, `engine/records.js` never makes a request,
> and the game behaves exactly as it does today.

A zero-dependency Cloudflare Worker, entirely on the **free** plan (a
`workers.dev` subdomain and a free KV namespace).

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

### KV layout

| Key                        | Value                            |
|----------------------------|----------------------------------|
| `records:v1`               | `{v:1, rows:[record, ...]}`      |
| `rl:<ip>`                  | `{n, until}` — 120s TTL          |
| `acct:<name lowercased>`   | `{pinHash, save, savedAt}` (mothballed) |

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

7. **Wire it into the game.** Add `apiUrl` to `CHLOE.data.config` in
   `game/js/data/config.js` (§15 removed the field; the record board is what
   brings it back), with **no trailing slash**:

   ```js
   apiUrl: 'https://chloe-api.your-subdomain.workers.dev'
   ```

   Leave it absent or `''` to stay local-only.

**Rolling back is one line:** delete `apiUrl` again. `engine/records.js` falls
straight back to the local board, because the remote list is only ever used
after a `GET /records` has actually succeeded.

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

---

## Free-tier limits (plenty for this game)

- Workers: 100,000 requests/day.
- KV: 100,000 reads/day, **1,000 writes/day**, 1 GB storage.
- The write budget is why reads are unmetered and writes are rate-limited: at
  5 POSTs/minute/IP the board would need ~200 distinct busy players to run the
  daily write budget out, and each one costs 2 writes (the table and the
  limiter).

## A known limit worth writing down

`POST /records` is a read-modify-write against a single KV key, and KV has no
compare-and-set. Two records landing in the same instant can lose one. That is
accepted deliberately: the fix is a Durable Object, which is not on the free
plan this game is hosted from, and the failure mode (a rare lost record on a
hobby board) is cheaper than the hosting bill.
