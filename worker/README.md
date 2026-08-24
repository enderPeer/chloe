# CHLOE Cloud-Save Worker (chloe-api)

> **DEPRECATED — never deployed.** CHLOE is a roguelike now (GAME_SPEC.md §14):
> no accounts, no saves, no cloud sync. The game-side client code and the
> `apiUrl` config field were removed. This folder is kept for reference only
> and is safe to delete.

A zero-dependency Cloudflare Worker that stores CHLOE game accounts and saves in
Workers KV. Runs entirely on the **free** Cloudflare plan (workers.dev subdomain,
free KV namespace).

## API

All endpoints are `POST` with a JSON body. All responses are JSON. `pinHash` is
never returned by any endpoint.

| Endpoint    | Body                     | Success                      | Errors                        |
|-------------|--------------------------|------------------------------|-------------------------------|
| `/register` | `{name, pinHash}`        | `{ok:true}`                  | `409` name taken              |
| `/login`    | `{name, pinHash}`        | `{ok:true, savedAt}`         | `401` wrong PIN / unknown     |
| `/save`     | `{name, pinHash, save}`  | `{ok:true, savedAt}`         | `401`, `413` save over 64KB   |
| `/load`     | `{name, pinHash}`        | `{ok:true, save, savedAt}`   | `401`                         |

Other rules: name must be 1-16 characters (`400` otherwise), unknown routes
return `404`, CORS is wide open (`Access-Control-Allow-Origin: *`) so the game
can call it from GitHub Pages, Cloudflare Pages, or `file://`.

Storage: KV key `acct:<name lowercased>` holding `{pinHash, save, savedAt}`.

## Deploy (free tier, step by step)

Prerequisites: a free Cloudflare account (dash.cloudflare.com) and Node.js.

1. **Install wrangler** (Cloudflare's CLI):

   ```
   npm i -g wrangler
   ```

2. **Log in** (opens a browser window; approve the request):

   ```
   wrangler login
   ```

3. **Create the KV namespace** (run from this `worker/` directory):

   ```
   wrangler kv namespace create CHLOE_KV
   ```

   The command prints a snippet containing an `id = "..."` value (a 32-char hex
   string).

4. **Paste the id into `wrangler.toml`** — replace `REPLACE_ME`:

   ```toml
   kv_namespaces = [
     { binding = "CHLOE_KV", id = "<the id you just got>" }
   ]
   ```

5. **Deploy**:

   ```
   wrangler deploy
   ```

   On first deploy, wrangler may ask to register a `workers.dev` subdomain —
   accept the default. It then prints your Worker URL, e.g.:

   ```
   https://chloe-api.<your-subdomain>.workers.dev
   ```

6. **Wire it into the game** — open `game/js/data/config.js` and set `apiUrl`
   to that printed URL (no trailing slash), e.g.:

   ```js
   CHLOE.data.config.apiUrl = 'https://chloe-api.your-subdomain.workers.dev';
   ```

   Leave it as `''` to stay in local-only save mode.

## Quick test (optional)

```
curl -X POST https://chloe-api.<your-subdomain>.workers.dev/register \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"test\",\"pinHash\":\"0123456789abcdef0123456789abcdef\"}"
```

Expected: `{"ok":true}` — a second run returns `409 {"ok":false,"error":"Name already taken"}`.

## Free-tier limits (plenty for this game)

- Workers: 100,000 requests/day.
- KV: 100,000 reads/day, 1,000 writes/day, 1 GB storage.
- Save payloads are capped at 64KB by the Worker itself.
