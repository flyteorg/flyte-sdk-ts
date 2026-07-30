/**
 * Browser / Next.js snippet — session auth (logged-in user, cookies).
 * See examples/README.md
 *
 * ```tsx
 * 'use client'
 *
 * import { Flyte, createBrowserAuth, phaseName } from 'flyte-sdk-ts'
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
 *         auth: createBrowserAuth({
 *           endpoint: ENDPOINT,
 *           loginRedirectPath: '/my-app/runs',
 *         }),
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
 *   return <button type="button" onClick={handleRun}>Run task {status}</button>
 * }
 * ```
 */

export {}
