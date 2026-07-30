/**
 * Auth smoke test — discovery, client_credentials, bearer (Node).
 * Session: pnpm example:session · See examples/README.md
 */

import { create } from '@bufbuild/protobuf'

import {
  Flyte,
  buildLoginUrl,
  discoverOAuth2Metadata,
  discoverPublicClientConfig,
  phaseName,
  resolveConfig,
} from '../src'
import { ProjectIdentifierSchema } from '../src/gen/flyteidl2/common/identifier_pb'
import { ListTasksRequestSchema } from '../src/gen/flyteidl2/task/task_service_pb'
import { exampleScope, optionalTaskName, requireEnv } from './_env'

async function testDiscovery(endpoint: string) {
  console.log('\n=== 1. OAuth discovery (anonymous) ===')
  const oauth = await discoverOAuth2Metadata(endpoint)
  console.log('  token_endpoint:', oauth.tokenEndpoint)
  console.log('  grant_types:', oauth.grantTypesSupported?.join(', '))

  const pub = await discoverPublicClientConfig(endpoint)
  console.log('  public client_id:', pub.clientId)
  console.log('  auth header key:', pub.authorizationMetadataKey || 'authorization')
  console.log('  login URL:', buildLoginUrl(endpoint, '/'))
}

async function testClientCredentials(scope: ReturnType<typeof exampleScope>) {
  console.log('\n=== 2. client_credentials ===')
  const flyte = await Flyte.init({
    endpoint: scope.endpoint,
    org: scope.org,
    auth: { apiKey: process.env.FLYTE_API_KEY },
  })
  const res = await flyte.services.task.listTasks(
    create(ListTasksRequestSchema, {
      request: { limit: 1 },
      scopeBy: {
        case: 'projectId',
        value: create(ProjectIdentifierSchema, {
          organization: scope.org,
          domain: scope.domain,
          name: scope.project,
        }),
      },
    }),
  )
  console.log('  listTasks ok, count:', res.tasks.length)
  console.log('  first task:', res.tasks[0]?.taskId?.name ?? '(none)')
}

async function testBearerViaM2MToken(scope: ReturnType<typeof exampleScope>) {
  console.log('\n=== 3. bearer (token from client_credentials exchange) ===')
  const resolved = resolveConfig({
    endpoint: scope.endpoint,
    org: scope.org,
    auth: { apiKey: process.env.FLYTE_API_KEY },
  })
  if (resolved.auth.mode !== 'client_credentials') {
    throw new Error('expected client_credentials for token exchange')
  }

  const oauth = await discoverOAuth2Metadata(resolved.endpoint)
  const tokenUrl = oauth.tokenEndpoint!
  const basic = Buffer.from(
    `${encodeURIComponent(resolved.auth.clientId)}:${encodeURIComponent(resolved.auth.clientSecret)}`,
  ).toString('base64')

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
      accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all' }),
  })
  if (!tokenRes.ok) {
    throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`)
  }
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }
  console.log('  got access_token (len):', accessToken.length)

  const flyte = await Flyte.init({
    endpoint: resolved.endpoint,
    org: resolved.org,
    auth: { mode: 'bearer', bearerToken: accessToken },
  })

  const run = await flyte.run({
    task: optionalTaskName(),
    project: scope.project,
    domain: scope.domain,
    inputs: { x: 1 },
  })
  console.log('  createRun ok:', run.name)

  const details = await run.wait({
    intervalMs: 2000,
    timeoutMs: 5 * 60_000,
    onPhase: (p) => console.log('    phase:', phaseName(p)),
  })
  console.log('  final:', phaseName(details.action?.status?.phase ?? 0))
}

async function main() {
  requireEnv('FLYTE_API_KEY')
  const scope = exampleScope()

  await testDiscovery(scope.endpoint)
  await testClientCredentials(scope)
  await testBearerViaM2MToken(scope)

  console.log('\n=== 4. session ===')
  console.log('  Session auth requires a browser with login cookies.')
  console.log('  Run: pnpm example:session')
  console.log('\nAll Node-side auth tests passed.')
}

main().catch((e) => {
  console.error('\nFAILED:', e)
  process.exit(1)
})
