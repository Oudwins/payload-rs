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

fs.copyFileSync(
  path.join(rootDir, 'target', isRelease ? 'release' : 'debug', libName),
  path.join(packageDir, 'payload-engine.node'),
)
