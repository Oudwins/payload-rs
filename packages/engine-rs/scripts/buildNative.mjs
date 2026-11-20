import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootDir = path.resolve(packageDir, '../..')
const isRelease = process.argv.includes('--release')

execFileSync('cargo', ['build', '-p', 'payload-node', ...(isRelease ? ['--release'] : [])], {
  cwd: rootDir,
  stdio: 'inherit',
})

const libName = {
  darwin: 'libpayload_node.dylib',
  linux: 'libpayload_node.so',
  win32: 'payload_node.dll',
}[process.platform]

// cargo honours CARGO_TARGET_DIR (relative to the workspace root); copied under a temporary name
// and renamed, so a process that has the previous addon loaded keeps its file
const targetDir = path.resolve(rootDir, process.env.CARGO_TARGET_DIR || 'target')
const addon = path.join(packageDir, 'payload-engine.node')
fs.copyFileSync(path.join(targetDir, isRelease ? 'release' : 'debug', libName), `${addon}.tmp`)
fs.renameSync(`${addon}.tmp`, addon)
