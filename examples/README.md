# Examples

All examples read configuration from a repo-root **`.env`** file (copy from [`.env.example`](../.env.example)).
Do not commit `.env` or put API keys in browser code.

## By auth mode

| Auth | Where it runs | Example | Command |
|------|---------------|---------|---------|
| **client_credentials** | Node, CI, server | [`run-noop.ts`](run-noop.ts) — minimal run + wait | `pnpm example:run` |
| **client_credentials** | Node, CI, server | [`quickstart.ts`](quickstart.ts) — run, wait, outputs | `pnpm example:quickstart` |
| **from config file** (PKCE by default) | Node / dev machine | [`config-file.ts`](config-file.ts) — init from `~/.flyte/config.yaml`, inspect the task, stream progress, list actions | `pnpm example:config` |
| **from config file** | Node / dev machine | [`approve-condition.ts`](approve-condition.ts) — signal a paused condition (human-in-the-loop) | `pnpm example:approve` |
| **client_credentials** | Node | [`scan-tasks.ts`](scan-tasks.ts) — list tasks + launch forms | `pnpm example:scan-tasks` |
| **client_credentials + bearer + discovery** | Node | [`auth-test.ts`](auth-test.ts) — smoke test all Node paths | `pnpm example:auth` |
| **session** | Next.js / React | [`browser-session.tsx`](browser-session.tsx) — copy-paste snippet | — |
| **session** | Browser (automated) | [`session-browser-test.ts`](session-browser-test.ts) | `pnpm example:session` |
| **bearer (BFF)** | Next.js / React | [`bearer-bff.tsx`](bearer-bff.tsx) — copy-paste snippet | — |
| **bearer (BFF)** | Browser demo | [`token-server.ts`](token-server.ts) + [`browser-demo/`](browser-demo/) | `pnpm demo:browser` |
| **anonymous** | Any | OAuth discovery only (see `auth-test.ts` step 1) | `pnpm example:auth` |

## Browser demo

Interactive page that calls the real SDK in Chrome (session or bearer).

**Prerequisites**

1. Copy `.env.example` → `.env` and set `FLYTE_*`, `FLYTE_DEMO_HOST`, `FLYTE_ADMIN_HOST`, and `VITE_FLYTE_*`.
2. `/etc/hosts`: `127.0.0.1 <FLYTE_DEMO_HOST>` (e.g. `localhost.my-flyte.example.com`).
3. [mkcert](https://github.com/FiloSottile/mkcert): `brew install mkcert && mkcert -install`
4. Generate certs: `pnpm demo:ssl`

**Run**

```bash
pnpm demo:browser          # token sidecar + Vite (recommended)
# or separately:
pnpm demo:token            # terminal 1 — BFF token (uses FLYTE_API_KEY from .env)
pnpm demo:client           # terminal 2 — https://<FLYTE_DEMO_HOST>:8080
```

**Automated check:** `pnpm demo:browser:proof` (Playwright, headless).

### Session mode

1. Open the demo URL (printed by Vite).
2. Select **Session** → **Log in** → sign in on your Flyte host.
3. **List tasks** or **Run task**.

### Bearer mode

1. Select **Bearer** (token sidecar must be running via `demo:token` or `demo:browser`).
2. **Run task** — API key stays on the server; the browser only gets a short-lived token.

## Shared helpers

[`_env.ts`](_env.ts) loads `.env` and exports `exampleScope()`, `requireEnv()`, etc. Import it from Node examples only.
