#!/usr/bin/env node
/**
 * Recompiles every `src` file newer than its `dist` file with the package's own swc config (what
 * its `build:swc` does), so `dist` matches `src` without a full package build. A stale
 * `'use client'` file aborts: those need the package's full build (react compiler, bundling).
 *
 *   node test/__rs/packaging/rebuildStale.mjs payload db-sqlite db-mongodb richtext-lexical
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** Package dir name (under packages/) -> swc config file its `build:swc` uses. */
const swcConfigs = { 'db-mongodb': '.swcrc-build' }

/**
 * @param {{ dirs: string[] }} args
 * @returns {Record<string, number>} recompiled file count per package
 */
export const rebuildStaleDist = ({ dirs }) => {
  const swcModule = path.join(root, 'node_modules/@swc/core/index.js')
  if (!fs.existsSync(swcModule)) {
    throw new Error('@swc/core not found in the repo root node_modules')
  }
  const counts = {}
  for (const dir of dirs) {
    const packageDir = path.join(root, 'packages', dir)
    const stale = listFiles(path.join(packageDir, 'src')).filter((file) => {
      if (
        !/\.(ts|tsx|js|jsx)$/.test(file) ||
        file.endsWith('.d.ts') ||
        /\.spec\.[^/]+$/.test(file)
      ) {
        return false
      }
      const out = distFileFor(packageDir, file)
      return !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(file).mtimeMs
    })
    counts[dir] = stale.length
    if (stale.length === 0) {
      continue
    }
    const clientFiles = stale.filter((file) =>
      /^\s*['"]use client['"]/.test(fs.readFileSync(file, 'utf8')),
    )
    if (clientFiles.length > 0) {
      throw new Error(`stale client files need \`pnpm build:${dir}\`: ${clientFiles.join(', ')}`)
    }
    console.log(`rebuilding ${stale.length} stale dist file(s) of ${dir}`)
    const configFile = path.join(packageDir, swcConfigs[dir] ?? '.swcrc')
    const script = `
      const swc = require(${JSON.stringify(swcModule)})
      const fs = require('node:fs')
      const path = require('node:path')
      const jobs = JSON.parse(process.argv[1])
      for (const [file, out] of jobs) {
        const { code } = swc.transformFileSync(file, { configFile: ${JSON.stringify(configFile)}, sourceMaps: false })
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, code)
      }`
    execFileSync(
      'node',
      ['-e', script, JSON.stringify(stale.map((file) => [file, distFileFor(packageDir, file)]))],
      { cwd: packageDir, stdio: 'inherit' },
    )
  }
  return counts
}

function distFileFor(packageDir, file) {
  return path
    .join(packageDir, 'dist', path.relative(path.join(packageDir, 'src'), file))
    .replace(/\.[jt]sx?$/, '.js')
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(rebuildStaleDist({ dirs: process.argv.slice(2) })))
}
