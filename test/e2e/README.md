# End-to-end tests

These tests run real tasks on a real Flyte control plane. They are excluded
from `pnpm test` and run with:

```bash
pnpm test:e2e
```

## Connecting

Configuration comes from the same places the Go and Python SDKs use, in this
order:

1. `FLYTE_API_KEY` (plus `FLYTE_PROJECT` / `FLYTE_DOMAIN` if not in the config
   file) — headless, best for CI.
2. A flytectl/uctl-style config file: `./config.yaml`, `./.flyte/config.yaml`,
   `<git root>/.flyte/config.yaml`, `$UCTL_CONFIG`, `$FLYTECTL_CONFIG`,
   `~/.union/config.yaml`, `~/.flyte/config.yaml`. With no `authType`, this
   uses the interactive PKCE browser login and caches the token, so the first
   run opens a browser.

Point at a different file with `FLYTE_CONFIG=/path/to/config.yaml`.

## Fixture tasks

The tests need the `sdk_ts_e2e` task environment deployed in the target
project/domain. Deploy it with the Python SDK:

```bash
flyte deploy test/e2e/fixtures/sdk_ts_e2e.py env
```

It defines five deliberately tiny tasks:

| Task | Purpose |
|------|---------|
| `sdk_ts_e2e.add` | typed scalars and a registered default |
| `sdk_ts_e2e.echo_types` | every simple scalar type plus a collection |
| `sdk_ts_e2e.parent` | fans out to child actions |
| `sdk_ts_e2e.always_fails` | failure reporting |
| `sdk_ts_e2e.needs_approval` | conditions and signals |

Override the environment name with `FLYTE_E2E_ENV` if you deployed it under a
different name.
