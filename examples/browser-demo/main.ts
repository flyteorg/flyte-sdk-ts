/**
 * Browser client demo — same dev pattern as flyte2-ui:
 *   UI:  https://localhost.<admin-host>:8080
 *   API: FLYTE_ENDPOINT (direct, credentials: include)
 *
 * Config via examples/browser-demo/.env.local (see .env.example).
 */
import { create } from '@bufbuild/protobuf'

import { Flyte, buildLoginUrl, createBrowserAuth, phaseName } from '../../src'
import { ProjectIdentifierSchema } from '../../src/gen/flyteidl2/common/identifier_pb'
import { ListTasksRequestSchema } from '../../src/gen/flyteidl2/task/task_service_pb'

const ENDPOINT = import.meta.env.VITE_FLYTE_ENDPOINT as string | undefined
const ORG = import.meta.env.VITE_FLYTE_ORG as string | undefined
const PROJECT = import.meta.env.VITE_FLYTE_PROJECT as string | undefined
const DOMAIN = import.meta.env.VITE_FLYTE_DOMAIN as string | undefined
const TOKEN_SIDECAR = 'http://127.0.0.1:8787/token'

const logEl = document.getElementById('log')!
const listBtn = document.getElementById('list') as HTMLButtonElement
const runBtn = document.getElementById('run') as HTMLButtonElement
const clearBtn = document.getElementById('clear') as HTMLButtonElement
const loginBtn = document.getElementById('login') as HTMLButtonElement | null

function log(msg: string) {
  logEl.textContent += msg + '\n'
  logEl.scrollTop = logEl.scrollHeight
}

function requireConfig(): { endpoint: string; org: string; project: string; domain: string } {
  const missing = [
    !ENDPOINT && 'VITE_FLYTE_ENDPOINT',
    !ORG && 'VITE_FLYTE_ORG',
    !PROJECT && 'VITE_FLYTE_PROJECT',
    !DOMAIN && 'VITE_FLYTE_DOMAIN',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')}. Copy .env.example to .env at the repo root.`,
    )
  }
  return { endpoint: ENDPOINT!, org: ORG!, project: PROJECT!, domain: DOMAIN! }
}

function authMode(): 'bearer' | 'session' {
  const checked = document.querySelector<HTMLInputElement>('input[name="auth"]:checked')
  return checked?.value === 'session' ? 'session' : 'bearer'
}

async function fetchBearerToken(): Promise<string> {
  let res: Response
  try {
    res = await fetch(TOKEN_SIDECAR)
  } catch (cause) {
    throw new Error(
      'Token sidecar not reachable. In another terminal:\n  export FLYTE_API_KEY=...\n  pnpm demo:token',
      { cause },
    )
  }
  if (!res.ok) {
    throw new Error(`Token sidecar ${res.status}: ${await res.text()}`)
  }
  const { accessToken } = (await res.json()) as { accessToken?: string }
  if (!accessToken?.trim()) {
    throw new Error('Token sidecar returned an empty accessToken. Check FLYTE_API_KEY.')
  }
  return accessToken
}

async function createClient() {
  const cfg = requireConfig()
  const mode = authMode()
  log(`→ Flyte.init({ endpoint, auth: ${mode} })`)

  if (mode === 'session') {
    return Flyte.init({
      endpoint: cfg.endpoint,
      org: cfg.org,
      auth: createBrowserAuth({
        endpoint: cfg.endpoint,
        loginRedirectPath: '/v2/projects',
      }),
    })
  }

  return Flyte.init({
    endpoint: cfg.endpoint,
    org: cfg.org,
    auth: {
      getAccessToken: async () => {
        log('→ fetching bearer token from local sidecar (API key stays on server)')
        return fetchBearerToken()
      },
    },
  })
}

loginBtn?.addEventListener('click', () => {
  const cfg = requireConfig()
  const url = buildLoginUrl(cfg.endpoint, '/v2/projects')
  log('→ opening login in new tab')
  window.open(url, '_blank', 'noopener,noreferrer')
})

listBtn.addEventListener('click', async () => {
  listBtn.disabled = true
  try {
    const cfg = requireConfig()
    const flyte = await createClient()
    log('→ flyte.services.task.listTasks(...)  [generated Connect client]')
    const res = await flyte.services.task.listTasks(
      create(ListTasksRequestSchema, {
        request: { limit: 5 },
        scopeBy: {
          case: 'projectId',
          value: create(ProjectIdentifierSchema, {
            organization: cfg.org,
            domain: cfg.domain,
            name: cfg.project,
          }),
        },
      }),
    )
    const names = res.tasks.map((t) => t.taskId?.name).filter(Boolean)
    log(`✓ ${names.length} tasks: ${names.join(', ')}`)
  } catch (e) {
    log(`✗ ${e instanceof Error ? e.message : e}`)
  } finally {
    listBtn.disabled = false
  }
})

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true
  try {
    const cfg = requireConfig()
    const flyte = await createClient()
    log('→ flyte.run({ task, project, domain, inputs })')
    const run = await flyte.run({
      task: import.meta.env.VITE_FLYTE_TASK ?? 'my_task',
      project: cfg.project,
      domain: cfg.domain,
      inputs: { x: 1 },
    })
    log(`✓ run created: ${run.name}`)
    log(`  ${run.url}`)
    log('→ run.wait() …')
    const details = await run.wait({
      intervalMs: 2000,
      onPhase: (p) => log(`  phase: ${phaseName(p)}`),
    })
    log(`✓ final: ${phaseName(details.action?.status?.phase ?? 0)}`)
  } catch (e) {
    log(`✗ ${e instanceof Error ? e.message : e}`)
  } finally {
    runBtn.disabled = false
  }
})

clearBtn.addEventListener('click', () => {
  logEl.textContent = ''
})

try {
  const cfg = requireConfig()
  log(`Browser client on ${window.location.host} → API ${cfg.endpoint}\n`)
} catch (e) {
  log(`✗ ${e instanceof Error ? e.message : e}\n`)
}
