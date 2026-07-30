# flyte-sdk-ts

Official JavaScript/TypeScript client for **Flyte 2** — trigger runs, poll status,
fetch outputs, and upload data. Works in **Node**, **Next.js**, and the **browser**.

Uses ConnectRPC over HTTP/JSON (same wire format as the Flyte 2 console).

## Install

```bash
npm install flyte-sdk-ts
# pnpm add flyte-sdk-ts / yarn add flyte-sdk-ts
```

Requires `fetch` (Node 18+, modern browsers, Next.js).

## Quick start (server / CI)

```ts
import { Flyte, phaseName } from 'flyte-sdk-ts'

const flyte = await Flyte.init({
  endpoint: process.env.FLYTE_ENDPOINT,
  org: process.env.FLYTE_ORG,
  auth: { apiKey: process.env.FLYTE_API_KEY },
})

const run = await flyte.run({
  task: 'my_task',
  project: 'my-project',
  domain: 'development',
  inputs: { x: 1 },
})

await run.wait({ onPhase: (p) => console.log(phaseName(p)) })
const { outputs } = await run.outputs()
```

**Project and domain are always passed per call** — not stored in `Flyte.init()`.

## Auth modes

| Mode | Use when | Secrets in browser? |
|------|----------|---------------------|
| `client_credentials` | Node, CI, server routes | No (API key stays on server) |
| `session` | Logged-in user in browser / `'use client'` | No (cookies only) |
| `bearer` | Browser with a BFF that mints short-lived tokens | No |
| `anonymous` | Local sandbox / metadata discovery | No |

```ts
// Browser — session (Flyte console model)
import { Flyte, createBrowserAuth } from 'flyte-sdk-ts'

await Flyte.init({
  endpoint: 'https://my-flyte.example.com',
  org: 'my-org',
  auth: createBrowserAuth({ endpoint: 'https://my-flyte.example.com' }),
})

// Browser — bearer from your BFF
await Flyte.init({
  endpoint: 'https://my-flyte.example.com',
  org: 'my-org',
  auth: {
    getAccessToken: async () => {
      const res = await fetch('/api/flyte/token')
      return (await res.json()).accessToken
    },
  },
})
```

Never put `FLYTE_API_KEY`, `clientSecret`, or long-lived tokens in client bundles
or `NEXT_PUBLIC_*` variables.

**Copy-paste snippets:** [`examples/browser-session.tsx`](examples/browser-session.tsx),
[`examples/bearer-bff.tsx`](examples/bearer-bff.tsx)

## Configuration

| Option | Env var | Notes |
|--------|---------|-------|
| `endpoint` | `FLYTE_ENDPOINT` | Control-plane URL. Inferred from API key if omitted. |
| `org` | `FLYTE_ORG` | Default org for calls |
| `auth.apiKey` | `FLYTE_API_KEY` | Server/CI only |
| `auth.clientId` / `clientSecret` | `FLYTE_CLIENT_ID` / `FLYTE_CLIENT_SECRET` | Server/CI only |

See [`.env.example`](.env.example) for local development.

## API surface

```ts
// Runs
await flyte.run({ task, project, domain, inputs?, runName?, wait? })
await run.wait({ intervalMs?, timeoutMs?, onPhase? })
await run.outputs()
await run.abort(reason?)

// Data (Node MD5 today)
await flyte.data.uploadFile({ data, filename, project, domain })

// Raw Connect clients
flyte.services.run | .task | .dataproxy | .cluster | .auth | ...
```

Tasks must already be deployed (via the Python SDK). Plain JSON `inputs` are
converted server-side from the task interface.

## Examples

Copy `.env.example` to `.env`, fill in your deployment, then:

```bash
pnpm install
pnpm example:run          # minimal client_credentials run
pnpm example:quickstart   # run + wait + outputs
pnpm example:auth         # discovery + client_credentials + bearer
pnpm demo:browser         # interactive browser demo (session + bearer)
```

Full index: **[examples/README.md](examples/README.md)**

## Development

```bash
git clone https://github.com/unionai-oss/flyte-sdk-ts.git
cd flyte-sdk-ts
pnpm install
cp .env.example .env
pnpm typecheck && pnpm build
```

Regenerate protobuf types (requires [buf](https://buf.build/docs/installation/)):

```bash
pnpm gen
```

## License

[UNION-LICENSE.txt](UNION-LICENSE.txt) · [NOTICE.txt](NOTICE.txt)
