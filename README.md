# flyte-sdk-ts

Official JavaScript/TypeScript client for **Flyte 2** — launch runs of deployed
tasks, stream their progress, fetch typed outputs, signal conditions, and upload
data. Works in **Node**, **Next.js**, and the **browser**.

Uses ConnectRPC over HTTP/JSON (same wire format as the Flyte 2 console).

This is a client for tasks that are **already deployed** on a control plane — it
does not author or deploy tasks. Use the Python SDK for that.

## Quickstart

You need a Flyte 2 control plane with at least one **deployed task**. If you
don't have one yet, deploy this with the Python SDK:

```python
# hello.py
import flyte

env = flyte.TaskEnvironment(name="hello")

@env.task
async def add(x: int, y: int = 10) -> int:
    return x + y

@env.task
async def say_hello(name: str = "world") -> str:
    return f"Hello, {name}!"
```

```bash
flyte deploy hello.py env      # registers hello.add and hello.say_hello
```

### 1. Install

```bash
npm install flyte-sdk-ts
# pnpm add flyte-sdk-ts / yarn add flyte-sdk-ts
```

Requires `fetch` (Node 18+, modern browsers, Next.js).

### 2. Connect

**On your own machine**, reuse the config the Flyte CLI already wrote — no
arguments, no secrets. It supplies the endpoint, org, project, and domain, and
logs you in through the browser on first use:

```ts
import { Flyte } from 'flyte-sdk-ts'

const flyte = await Flyte.initFromConfig()
```

**On a server or in CI**, use a platform API key instead. It carries the
endpoint and org, so only project and domain are left to set:

```ts
const flyte = await Flyte.init({
  auth: { apiKey: process.env.FLYTE_API_KEY },
  project: 'flytesnacks',
  domain: 'development',
})
```

### 3. Run a task

```ts
import { Flyte, phaseName } from 'flyte-sdk-ts'

const flyte = await Flyte.initFromConfig()

// Optional: check what the task takes before calling it.
const task = await flyte.getTask('hello.add')
console.log(task.version, task.interface?.inputs?.variables.map((v) => v.key))

const run = await flyte.run({ task: 'hello.add', inputs: { x: 1 } })
console.log(`Watch it at ${run.url}`)

await run.wait({ onPhase: (p) => console.log(phaseName(p)) })
console.log(await run.outputs())
```

Save it as `hello.mts` and run it with `npx tsx hello.mts`. (The `.mts`
extension makes it ESM, which top-level `await` needs; a plain `.ts` file works
too if your `package.json` has `"type": "module"`.)

```
c35fdcacd1ee0be0fe57cc81e3f13a3b [ 'x', 'y' ]
Watch it at https://my-flyte.example.com/v2/domain/development/project/flytesnacks/runs/undk4t84rzd8n5hdx57b
QUEUED
WAITING_FOR_RESOURCES
INITIALIZING
RUNNING
SUCCEEDED
{ o0: 11 }
```

`o0` is `11` because `y` fell back to its registered default of `10`. Inputs
are checked against the task's typed interface before anything is sent, so a
typo fails immediately and locally:

```
FlyteError: Unknown input "z": task hello.add accepts [x, y].
```

### Where to go next

- **Stream progress instead of blocking** — [`run.watch()`](#progress-actions-and-conditions)
- **Customize the run** — labels, env vars, queue, recovery: [run options](#run-options)
- **Approve a paused task** — [conditions](#progress-actions-and-conditions)
- **Run in a browser or Next.js** — [auth modes](#auth-modes)
- **Runnable scripts** — [`examples/`](examples/README.md)

## Connecting

Beyond the two entry points in the quickstart, you can spell everything out —
useful for a local sandbox, or when the endpoint comes from your own settings:

```ts
await Flyte.init({ endpoint: 'my-flyte.example.com', project: 'p', domain: 'd' })
```

`project` and `domain` can be set once on init and overridden per call, or left
off entirely and passed on every call — whichever suits your app. `org` is
derived from the API key, or failing that from the endpoint hostname's first
DNS label (`acme` for `acme.example.com`); single-tenant deployments have none
and work without it.

`initFromConfig()` searches `./config.yaml`, `./.flyte/config.yaml`,
`<git root>/.flyte/config.yaml`, `$UCTL_CONFIG`, `$FLYTECTL_CONFIG`,
`~/.union/config.yaml`, then `~/.flyte/config.yaml`, and reads:

```yaml
admin:
  endpoint: dns:///my-flyte.example.com
  authType: Pkce          # or ClientSecret / DeviceFlow / ExternalCommand
  caCertFilePath: /etc/ssl/corp-ca.pem   # optional
task:
  org: my-org
  project: my-project
  domain: development
```

Pass a path to pin one file, and overrides to layer on top — so CI can reuse a
developer's config while supplying its own credentials:

```ts
await Flyte.initFromConfig('/etc/flyte/config.yaml', {
  auth: { apiKey: process.env.FLYTE_API_KEY },
})
```

## Auth modes

| Mode | Use when | Secrets in browser? |
|------|----------|---------------------|
| `client_credentials` | Node, CI, server routes | No (API key stays on server) |
| `pkce` | Interactive CLI / dev machine (opens a browser, caches the token) | n/a (Node only) |
| `device_flow` | Headless machine where a browser can't open | n/a (Node only) |
| `external_command` | Token minted by another program | n/a (Node only) |
| `session` | Logged-in user in browser / `'use client'` | No (cookies only) |
| `bearer` | Browser with a BFF that mints short-lived tokens | No |
| `anonymous` | Local sandbox / metadata discovery | No |

The OAuth client, endpoints, scopes, and audience for `pkce` and `device_flow`
are discovered from the control plane, so nothing needs registering. Tokens from
interactive logins are cached in `~/.flyte/ts-sdk-token-cache.json` (mode 0600)
so re-runs don't re-prompt; set `auth.disableTokenCache` to opt out, or
`auth.tokenCache` to supply your own store.

**Defaults.** The mode is inferred from whichever credentials you provide; with
none, it is `anonymous`. `pkce` and `device_flow` are never inferred, since
opening a browser or printing a code should not happen by surprise in a server
or a browser bundle. `Flyte.initFromConfig` is the exception: a flytectl-style
config file implies an interactive context, so it defaults to `pkce`.

```ts
// Interactive login on a dev machine.
await Flyte.init({ endpoint: 'my-flyte.example.com', auth: { mode: 'pkce' } })

// Headless machine — prints a code and URL to confirm elsewhere.
await Flyte.init({
  endpoint: 'my-flyte.example.com',
  auth: {
    mode: 'device_flow',
    onDeviceAuthorization: ({ userCode, verificationUri }) =>
      console.log(`Enter ${userCode} at ${verificationUri}`),
  },
})

// Browser — session (Flyte console model)
import { createBrowserAuth } from 'flyte-sdk-ts'

await Flyte.init({
  endpoint: 'https://my-flyte.example.com',
  auth: createBrowserAuth({ endpoint: 'https://my-flyte.example.com' }),
})

// Browser — bearer from your BFF
await Flyte.init({
  endpoint: 'https://my-flyte.example.com',
  auth: {
    getAccessToken: async () => {
      const res = await fetch('/api/flyte/token')
      return (await res.json()).accessToken
    },
  },
})
```

Never put `FLYTE_API_KEY`, `clientSecret`, or long-lived tokens in client
bundles or `NEXT_PUBLIC_*` variables.

**Copy-paste snippets:** [`examples/browser-session.tsx`](examples/browser-session.tsx),
[`examples/bearer-bff.tsx`](examples/bearer-bff.tsx)

## Configuration

| Option | Env var | Notes |
|--------|---------|-------|
| `endpoint` | `FLYTE_ENDPOINT` | Control-plane URL. Inferred from an API key if omitted. Accepts a bare host, an `http(s)` URL, or `dns:///host`. |
| `org` | `FLYTE_ORG` | Default org. Derived from the API key or endpoint if omitted. |
| `project` | `FLYTE_PROJECT` | Default project; overridable per call. |
| `domain` | `FLYTE_DOMAIN` | Default domain; overridable per call. |
| `insecure` | — | Use plain HTTP (local development). |
| `auth.apiKey` | `FLYTE_API_KEY` | Server/CI only. |
| `auth.clientId` / `clientSecret` | `FLYTE_CLIENT_ID` / `FLYTE_CLIENT_SECRET` | Server/CI only. Also `clientSecretEnvVar` and `clientSecretLocation` (read lazily). |
| `retry` | — | Unary retry/deadline policy — see below. |
| `runSource` | — | `'web'` (default) or `'cli'`: how runs are attributed in the console. |
| `caCertFilePath` | — | PEM CA bundle for a private-CA cluster. Node only. |
| `insecureSkipVerify` | — | Skip certificate verification. Node only, unsafe. |

See [`.env.example`](.env.example) for local development.

### Reliability

Unary calls retry automatically when the server is `Unavailable` — the request
never reached a healthy server, so replaying it is safe — and each attempt is
bounded by a deadline so a hung connection can't stall the caller. Streaming
progress (`watch`, and `wait` built on it) is never cut off by that deadline;
it reconnects on its own through idle timeouts and rollouts.

```ts
await Flyte.init({
  retry: {
    maxRetries: 4,             // default; 0 disables retries
    backoffMs: 250,            // nth retry waits n × this
    maxBackoffMs: 8000,
    perAttemptTimeoutMs: 30000, // 0 disables the deadline
  },
})
```

A request that comes back `Unauthenticated` drops the cached token and retries
once with a fresh one, so a revoked or server-rotated token recovers without
restarting the process.

### Private CAs and proxies

```ts
await Flyte.init({
  endpoint: 'flyte.corp.internal',
  caCertFilePath: '/etc/ssl/corp-ca.pem',
  // Behind an authenticating proxy:
  auth: { proxyCommand: ['mint-proxy-token'] },
})
```

TLS trust settings need the optional [`undici`](https://github.com/nodejs/undici)
peer dependency (`npm install undici`), since that is the only way to give
Node's `fetch` a custom certificate store. Setting `NODE_EXTRA_CA_CERTS` before
starting Node works without it.

## Inputs and outputs

Pass plain JavaScript values as `inputs`. They are validated against the task's
typed interface before anything is sent: unknown names and missing required
inputs are errors, and omitted inputs fall back to the task's registered
defaults. `Date` becomes an RFC 3339 string; objects and arrays go through JSON.

`run.outputs()` returns plain JavaScript values keyed by output name (`o0`,
`o1`, …). It waits for completion first if the run is still in progress, and
throws `FlyteRunFailedError` if the run did not succeed. For the raw wire-format
literals, use `run.rawData()`.

## Run options

```ts
await flyte.run({
  task: 'my_env.my_task',
  inputs: { x: 1 },
  runName: 'my-run-001',      // server generates one when omitted
  labels: { team: 'ml' },
  annotations: { note: 'nightly' },
  envVars: { LOG_LEVEL: 'DEBUG' },
  interruptible: true,
  overwriteCache: true,
  queue: 'gpu-queue',
  maxActionConcurrency: 4,
  rawDataPath: 's3://bucket/prefix',
  runBaseDir: 's3://bucket/metadata',
  serviceAccount: 'my-sa',
  recoverFrom: 'previous-run',     // reuse successful actions, re-run the rest
  forceRerunActions: ['a3'],       // ...except these
  relation: { run: 'other-run', type: 'rerun' }, // provenance only
  wait: true,
})
```

## Progress, actions, and conditions

```ts
// Stream every status update until the run finishes.
for await (const { phase, details } of run.watch()) {
  console.log(phaseName(phase), details.status?.attempts)
}

// Drill into the actions a run is made of.
for (const action of await run.listActions()) {
  console.log(action.name, action.parent, phaseName(action.phase))
}
const root = await run.action('a0')
console.log(root.errorInfo?.message, root.attemptDetails.length)
await root.abort('not needed')

// Human-in-the-loop: signal a paused condition.
for (const condition of await run.listConditions()) {
  console.log(condition.prompt)
  await condition.signal(true)
}
```

## API surface

```ts
// Client
await Flyte.init(config) | Flyte.initFromConfig(path?) | Flyte.initFromApiKey(key?)
await flyte.getTask(name | ref, scope?)   // TaskDetails: version, interface, defaults
await flyte.run(args)                     // RunHandle
await flyte.getRun(name, scope?)          // attach to an existing run
await flyte.listRuns(scope?, limit?)

// Runs
run.name | .project | .domain | .org | .url | .lastPhase
await run.details() | .phase() | .wait(opts?) | .outputs(opts?) | .rawData()
await run.abort(reason?)
run.watch(opts?)                          // async iterator of status updates
await run.listActions() | .action(name)
await run.listConditions() | .condition(name)

// Actions and conditions
action.name | .parent | .actionType | .phase | .attempts | .recoveredFrom
action.errorInfo | .abortInfo | .signalInfo | .attemptDetails | .details
await action.refresh() | .wait(opts?) | .abort(reason?)
action.watch(opts?)
await condition.signal(value)             // boolean | string | number | bigint
condition.prompt | .description | .condition

// Data
await flyte.data.uploadFile({ data, filename, project, domain })

// Raw Connect clients
flyte.services.run | .task | .dataproxy | .cluster | .translator | .auth
```

Errors are typed: `FlyteConfigError`, `FlyteAuthError`, `FlyteNotFoundError`,
`FlyteAlreadyExistsError`, `FlyteTimeoutError`, and `FlyteRunFailedError` (which
carries `phase` and `errorMessage`), all extending `FlyteError`.

A run or action that ends in `RECOVERED` counts as successful — its result was
reused from a source run without re-executing.

## Examples

These read your config file, so they need no setup beyond being logged in:

```bash
pnpm install
pnpm example:config       # init from config, inspect a task, stream, list actions
pnpm example:approve      # signal a paused condition (human-in-the-loop)
```

These use an API key — copy `.env.example` to `.env` and fill it in first:

```bash
pnpm example:run          # minimal client_credentials run
pnpm example:quickstart   # run + wait + outputs
pnpm example:auth         # discovery + client_credentials + bearer
pnpm demo:browser         # interactive browser demo (session + bearer)
```

Set `FLYTE_TASK` to point any of them at one of your own tasks.

Full index: **[examples/README.md](examples/README.md)**

## Development

```bash
git clone https://github.com/unionai-oss/flyte-sdk-ts.git
cd flyte-sdk-ts
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

`pnpm test` runs the unit tests (no cluster needed). `pnpm test:e2e` runs
against a real control plane — see [test/e2e/README.md](test/e2e/README.md).

Regenerate protobuf types (requires [buf](https://buf.build/docs/installation/)
and a checkout of [flyteorg/flyte](https://github.com/flyteorg/flyte)):

```bash
pnpm gen --flyte-repo /path/to/flyte
```

## License

[UNION-LICENSE.txt](UNION-LICENSE.txt) · [NOTICE.txt](NOTICE.txt)
