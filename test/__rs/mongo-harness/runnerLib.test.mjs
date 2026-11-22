/**
 * Unit tests of the mongo-harness runner helpers and the child-process resolve hook.
 *
 *   node --test test/__rs/mongo-harness/runnerLib.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { createResolveHook } from './childProcessHooks.mjs'
import { readEngineStats, testsOf } from './runnerLib.mjs'

const harnessDir = new URL('./', import.meta.url)

test('testsOf keys duplicate full names by occurrence index', () => {
  const tests = testsOf({
    assertionResults: [
      { fullName: 'a > same', status: 'passed' },
      { fullName: 'a > other', status: 'passed' },
      { fullName: 'a > same', status: 'failed' },
      { fullName: 'a > same', status: 'skipped' },
    ],
  })
  assert.deepEqual(
    [...tests].map(([key, t]) => [key, t.status]),
    [
      ['a > same', 'passed'],
      ['a > other', 'passed'],
      ['a > same [#2]', 'failed'],
      ['a > same [#3]', 'skipped'],
    ],
  )
  assert.equal(testsOf(undefined).size, 0)
})

test('readEngineStats sums the live engine calls of per-process files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-runnerlib-'))
  try {
    assert.deepEqual(readEngineStats(path.join(dir, 'missing')), {
      calls: 0,
      files: 0,
      live: 0,
      nativeCalls: 0,
    })
    fs.writeFileSync(
      path.join(dir, 'mongo-engine-1.json'),
      JSON.stringify({ engines: { live: 1 }, liveCalls: { create: 2, find: 3 } }),
    )
    fs.writeFileSync(
      path.join(dir, 'mongo-engine-4.json'),
      JSON.stringify({ engines: { live: 1 }, liveCalls: { create: 1, find: 6 } }),
    )
    // temporaries and foreign files are ignored
    fs.writeFileSync(path.join(dir, 'mongo-engine-3.json.3.tmp'), '{')
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ liveCalls: { find: 100 } }))
    assert.deepEqual(readEngineStats(dir), {
      calls: 12,
      files: 2,
      live: 2,
      nativeCalls: 12,
    })
  } finally {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

test('resolve hook redirects databaseAdapter.js without consulting the default resolver', () => {
  const testDir = new URL('../../', harnessDir).href
  const hook = createResolveHook({
    harnessDir: harnessDir.href,
    target: new URL('databaseAdapter.ts', harnessDir).href,
    testDir,
  })
  const failingNext = () => {
    const error = new Error('Cannot find module databaseAdapter.js')
    error.code = 'ERR_MODULE_NOT_FOUND'
    throw error
  }
  assert.deepEqual(
    hook(
      '../databaseAdapter.js',
      { parentURL: new URL('cli/config.ts', testDir).href },
      failingNext,
    ),
    { shortCircuit: true, url: new URL('databaseAdapter.ts', harnessDir).href },
  )
  // a databaseAdapter.js elsewhere goes to the default resolver
  const passthrough = { url: 'file:///elsewhere/databaseAdapter.js' }
  assert.equal(
    hook(
      './databaseAdapter.js',
      { parentURL: new URL('cli/x.ts', testDir).href },
      () => passthrough,
    ),
    passthrough,
  )
  // imports from the harness itself and from node_modules are not redirected
  assert.equal(
    hook(
      '../../databaseAdapter.js',
      { parentURL: new URL('x.ts', harnessDir).href },
      () => passthrough,
    ),
    passthrough,
  )
})

test('a child process on a clean checkout (no test/databaseAdapter.js) loads the harness adapter', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-clean-checkout-')))
  try {
    const testDir = path.join(root, 'test')
    const fakeHarness = path.join(testDir, '__rs', 'mongo-harness')
    fs.mkdirSync(path.join(testDir, 'cli'), { recursive: true })
    fs.mkdirSync(fakeHarness, { recursive: true })
    fs.writeFileSync(
      path.join(fakeHarness, 'databaseAdapter.mjs'),
      'export const which = "harness"\n',
    )
    fs.writeFileSync(
      path.join(testDir, 'cli', 'child.mjs'),
      'import { which } from "../databaseAdapter.js"\nconsole.log(which)\n',
    )
    const loader = path.join(root, 'loader.mjs')
    fs.writeFileSync(
      loader,
      `import { registerHooks } from 'node:module'
import { createResolveHook } from ${JSON.stringify(pathToFileURL(new URL('childProcessHooks.mjs', harnessDir).pathname).href)}
registerHooks({ resolve: createResolveHook({
  harnessDir: ${JSON.stringify(pathToFileURL(fakeHarness).href + '/')},
  target: ${JSON.stringify(pathToFileURL(path.join(fakeHarness, 'databaseAdapter.mjs')).href)},
  testDir: ${JSON.stringify(pathToFileURL(testDir).href + '/')},
}) })
`,
    )
    assert.equal(fs.existsSync(path.join(testDir, 'databaseAdapter.js')), false)
    const child = spawnSync(
      process.execPath,
      ['--import', loader, path.join(testDir, 'cli', 'child.mjs')],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(child.stderr, '')
    assert.equal(child.stdout.trim(), 'harness')
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})
