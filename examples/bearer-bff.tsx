/**
 * Browser / Next.js client component example (bearer auth via BFF).
 *
 * Your Route Handler (or API route) holds the API key and returns a short-lived
 * access token. The browser never sees FLYTE_API_KEY.
 *
 * ```tsx
 * 'use client'
 *
 * import { Flyte, phaseName } from 'flyte-sdk-ts'
 * import { useMemo, useState } from 'react'
 *
 * const ENDPOINT = process.env.NEXT_PUBLIC_FLYTE_ENDPOINT!
 * const ORG = process.env.NEXT_PUBLIC_FLYTE_ORG!
 *
 * export function RunTaskButton() {
 *   const [status, setStatus] = useState<string>()
 *
 *   const flytePromise = useMemo(
 *     () =>
 *       Flyte.init({
 *         endpoint: ENDPOINT,
 *         org: ORG,
 *         auth: {
 *           getAccessToken: async () => {
 *             const res = await fetch('/api/flyte/token')
 *             if (!res.ok) throw new Error(await res.text())
 *             const { accessToken } = (await res.json()) as { accessToken: string }
 *             return accessToken
 *           },
 *         },
 *       }),
 *     [],
 *   )
 *
 *   async function handleRun() {
 *     const flyte = await flytePromise
 *     const run = await flyte.run({
 *       task: 'my_task',
 *       project: process.env.NEXT_PUBLIC_FLYTE_PROJECT!,
 *       domain: process.env.NEXT_PUBLIC_FLYTE_DOMAIN!,
 *       inputs: { x: 1 },
 *     })
 *     setStatus(`Started ${run.name}`)
 *     await run.wait({ onPhase: (p) => setStatus(phaseName(p)) })
 *   }
 *
 *   return (
 *     <button type="button" onClick={handleRun}>
 *       Run task {status ? `(${status})` : ''}
 *     </button>
 *   )
 * }
 * ```
 *
 * Local dev sidecar (same idea as `/api/flyte/token`): see `token-server.ts` and
 * `pnpm demo:token` in this repo.
 */

export {}
