#!/usr/bin/env node
/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

/**
 * Regenerates `src/gen/` from the flyteidl2 protos.
 *
 * The protos are read from a checkout of https://github.com/flyteorg/flyte
 * rather than the Buf Schema Registry, because the `buf.build/flyteorg/flyte`
 * module is no longer published there.
 *
 *   pnpm gen --flyte-repo /path/to/flyte
 *   FLYTE_REPO=/path/to/flyte pnpm gen
 *
 * With neither, a sibling `../flyte` checkout is used if present.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function flyteRepoPath() {
  const flag = process.argv.indexOf('--flyte-repo')
  const fromFlag = flag !== -1 ? process.argv[flag + 1] : undefined
  const candidate = fromFlag ?? process.env.FLYTE_REPO ?? join(repoRoot, '..', 'flyte')
  const path = resolve(candidate)
  if (!existsSync(join(path, 'flyteidl2'))) {
    console.error(
      `No flyteidl2 protos found at ${path}.\n\n` +
        'Clone the protos and point this script at them:\n\n' +
        '  git clone --depth 1 --filter=blob:none --sparse https://github.com/flyteorg/flyte.git\n' +
        '  cd flyte && git sparse-checkout set flyteidl2\n\n' +
        '  pnpm gen --flyte-repo /path/to/flyte',
    )
    process.exit(1)
  }
  return path
}

const protos = flyteRepoPath()
const buf = join(repoRoot, 'node_modules', '.bin', 'buf')

console.log(`Generating src/gen from ${protos}`)
rmSync(join(repoRoot, 'src', 'gen'), { recursive: true, force: true })
execFileSync(buf, ['generate', protos, '--template', 'buf.gen.yaml'], {
  cwd: repoRoot,
  stdio: 'inherit',
})
console.log('Done. Review the diff and run `pnpm typecheck && pnpm test`.')
