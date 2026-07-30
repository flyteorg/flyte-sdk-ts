#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const COPYRIGHT_HEADER = `/**
 * © Copyright Union Systems Inc 2026. All rights reserved.
 */

`

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

function hasExistingHeader(content) {
  const trimmedContent = content.trim()
  return (
    trimmedContent.startsWith('/**') &&
    trimmedContent.includes('© Copyright Union Systems Inc 2026. All rights reserved.')
  )
}

function addHeaderIfMissing(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')

  if (hasExistingHeader(content)) {
    return false
  }

  const newContent = COPYRIGHT_HEADER + content
  fs.writeFileSync(filePath, newContent, 'utf8')
  return true
}

function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only', { encoding: 'utf8' })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function shouldProcess(file) {
  const ext = path.extname(file)
  if (!EXTENSIONS.includes(ext)) return false
  if (!file.startsWith('src/')) return false
  if (file.startsWith('src/gen/')) return false
  return fs.existsSync(path.resolve(file))
}

function main() {
  const stagedFiles = getStagedFiles()
  let modifiedFiles = 0

  for (const file of stagedFiles) {
    if (!shouldProcess(file)) continue
    if (addHeaderIfMissing(path.resolve(file))) {
      console.log(`Added copyright header to: ${file}`)
      execSync(`git add "${file}"`)
      modifiedFiles++
    }
  }

  if (modifiedFiles > 0) {
    console.log(`\nAdded copyright headers to ${modifiedFiles} file(s)`)
  }
}

main()
