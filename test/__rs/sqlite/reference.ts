/**
 * Differential scenarios for the reference SQLite build (libSQL 3.45.1 +
 * SQLite3 Multiple Ciphers 1.8.1, see crates/payload-sqlite/src/lib.rs) and
 * for binding-level semantics of `libsql@0.4.7`: named parameter lookup,
 * typed array binding, `lastInsertRowid` rounding, sequential batches,
 * `sync()` and encryption at rest.
 */
import fs from 'node:fs'

import type { Scenario } from './scenarios.js'

const E = 'SQLite3 can only bind numbers, strings, bigints, buffers, and null'

export const referenceScenarios: Scenario[] = [
  {
    name: 'reference SQLite build',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await step('version', () =>
        c.execute('select sqlite_version(), sqlite_source_id(), sqlite3mc_version()'),
      )
      await step('compile options (without COMPILER)', async () =>
        (await c.execute('pragma compile_options')).rows
          .map((row: unknown[]) => row[0])
          .filter((option: unknown) => !String(option).startsWith('COMPILER=')),
      )
      await step('function list', () =>
        c.execute(
          'select name, builtin, type, enc, narg, flags from pragma_function_list order by name, narg, type, enc',
        ),
      )
      await step('module list', () =>
        c.execute('select name from pragma_module_list order by name'),
      )
      await step('pragma list', () =>
        c.execute('select name from pragma_pragma_list order by name'),
      )
      await step('extension functions', () =>
        c.execute(
          `select regexp('a', 'abc'), regexpi('A', 'abc'), 'abc' regexp 'b', charindex('b', 'abc'), charindex('b', 'abcb', 3),
            reverse('abc'), proper('hello wORLD'), padl('a', 3), padr('a', 3), padc('a', 4), strfilter('abcb', 'b'),
            leftstr('abc', 2), rightstr('abc', 2), replicate('ab', 3), difference('Robert', 'Rupert'), soundex('Robert'),
            hex(sha3('a')), hex(sha3('a', 384)), length(uuid()), uuid_str(uuid_blob('d1a8fc56-0b14-4a8b-a9d8-2ae4d1b7a3c1'))`,
        ),
      )
      await step('regexp errors', () => c.execute(`select regexp('(', 'a')`))
      await step('aggregates', async () => {
        await c.execute('create table agg (x)')
        await c.execute('insert into agg values (1), (2), (4), (10), (null), (2)')
        return c.execute(
          'select median(x), stdev(x), variance(x), mode(x), lower_quartile(x), upper_quartile(x) from agg',
        )
      })
      await step('version-specific behaviour', () =>
        c.execute(
          `select '[1,2,3]' -> -1, '[1,2,3]' ->> '$[#-1]', strftime('%f', '2020-01-01T00:00:00.9999'),
            json_valid('{"a":1,}'), json('{"a":1,}'), datetime('2020-01-01 00:00:00.9999'), round(2.5), printf('%.20f', 0.1)`,
        ),
      )
      await step('functions added after 3.45', () =>
        c.execute(`select unistr('a\\u0062'), concat_ws(',', 1, 2)`),
      )
      await step('vector functions', () =>
        c.execute(
          `select vector_extract(vector('[1,2]')), vector_distance_cos(vector('[1,0]'), vector('[0,1]')), hex(vector32('[1]'))`,
        ),
      )
      await step('virtual tables', async () => {
        await c.execute('create virtual table ft using fts5(a)')
        await c.execute(`insert into ft values ('hello world')`)
        return c.execute(
          `select a, (select count(*) from generate_series(1, 5)) from ft where ft match 'hello'`,
        )
      })
      c.close()
    },
  },
  {
    name: 'named parameter lookup',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      for (const name of [
        'constructor',
        'toString',
        '__proto__',
        'hasOwnProperty',
        'valueOf',
        'missing',
      ]) {
        await step(`:${name}`, () => c.execute({ args: {}, sql: `select :${name}` }))
      }
      await step('numbered', () => c.execute({ args: { 1: 5, 2: 'x' }, sql: 'select ?1, ?2' }))
      await step('tcl name', () => c.execute({ args: { 'a::b(c)': 1 }, sql: 'select $a::b(c)' }))
      await step('prefixes', () =>
        c.execute({ args: { ':a': 1, '@b': 2, $c: 3, d: 4 }, sql: 'select :a, @b, $c, :d, @a' }),
      )
      await step('__proto__ key', () =>
        c.execute({ args: { ['__proto__']: 3, x: 1 }, sql: 'select :x' }),
      )
      await step('number args', () => c.execute({ args: 5, sql: 'select :a' }))
      await step('string args', () => c.execute({ args: 'xy', sql: 'select :0, :1' }))
      await step('no args', () => c.execute({ sql: 'select 1' }))
      await step('bad value', () => c.execute({ args: { a: undefined }, sql: 'select :a' }))
      await step('bad value before prepare error', () =>
        c.execute({ args: { a: undefined }, sql: 'select nope(' }),
      )
      await step('prepare error before lookup', () =>
        c.execute({ args: {}, sql: 'select :toString from nope' }),
      )
      await step('getter order', async () => {
        const seen: string[] = []
        const args = {
          get a() {
            seen.push('a')
            return 1
          },
          get b() {
            seen.push('b')
            return 2
          },
        }
        const r = await c.execute({ args, sql: 'select :b, :a' })
        return [seen, r]
      })
      const t = await c.transaction()
      await step('tx named', () => t.execute({ args: { a: 1 }, sql: 'select :a' }))
      await t.commit()
      await step('closed tx named', () => t.execute({ args: { a: undefined }, sql: 'select :a' }))
      c.close()
      await step('closed client named', () => c.execute({ args: { a: 1 }, sql: 'select :a' }))
    },
  },
  {
    // upstream reads the statement after `#checkNotClosed()` / `#getDb()`: getters, proxies and
    // accessor elements must not run when the transaction is closed
    name: 'statement reads after the closed check',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      const seen: string[] = []
      const withGetters = (args: unknown) => ({
        get args() {
          seen.push('args')
          return args
        },
        get sql() {
          seen.push('sql')
          return 'select ?'
        },
      })
      const proxied = () =>
        new Proxy(
          { args: [1], sql: 'select ?' },
          {
            get: (target, key, receiver) => {
              seen.push(`get ${String(key)}`)
              return Reflect.get(target, key, receiver)
            },
            getOwnPropertyDescriptor: (target, key) => {
              seen.push(`descriptor ${String(key)}`)
              return Reflect.getOwnPropertyDescriptor(target, key)
            },
          },
        )
      const accessorArgs = () => {
        const args: unknown[] = []
        Object.defineProperty(args, 0, {
          enumerable: true,
          get: () => {
            seen.push('element')
            return 1
          },
        })
        return { args, sql: 'select ?' }
      }
      const run = async (label: string, fn: () => unknown) => {
        seen.length = 0
        await step(label, fn)
        await step(`${label}: reads`, () => [...seen])
      }
      await run('client getters', () => c.execute(withGetters([1]) as never))
      await run('client proxy', () => c.execute(proxied() as never))
      await run('client accessor element', () => c.execute(accessorArgs() as never))
      await run('client NaN', () => c.execute({ args: [NaN], sql: 'select ?' }))
      const t = await c.transaction()
      await run('tx getters', () => t.execute(withGetters([1]) as never))
      await run('tx proxy', () => t.execute(proxied() as never))
      await t.commit()
      await run('closed tx getters', () => t.execute(withGetters([1]) as never))
      await run('closed tx named getters', () => t.execute(withGetters({ a: 1 }) as never))
      await run('closed tx proxy', () => t.execute(proxied() as never))
      await run('closed tx accessor element', () => t.execute(accessorArgs() as never))
      await run('closed tx NaN', () => t.execute({ args: [NaN], sql: 'select ?' }))
      c.close()
      await run('closed client getters', () => c.execute(withGetters([1]) as never))
    },
  },
  {
    name: 'typed array binding',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer
      const values: Array<[string, unknown]> = [
        ['Uint8ClampedArray', new Uint8ClampedArray([1, 2, 3])],
        ['Uint8ClampedArray view', new Uint8ClampedArray(buffer, 1, 2)],
        ['Int8Array', new Int8Array([1, -2])],
        ['Uint16Array', new Uint16Array([1, 2])],
        ['Float32Array view', new Float32Array(buffer, 4, 1)],
        ['Float32Array', new Float32Array([1.5])],
        ['Float64Array', new Float64Array([1])],
        ['Int32Array', new Int32Array([7])],
        ['BigInt64Array', new BigInt64Array([1n])],
        ['DataView', new DataView(buffer)],
        ['Uint8Array view', new Uint8Array(buffer, 2, 3)],
        ['Buffer view', Buffer.from(buffer, 3, 2)],
        ['SharedArrayBuffer view', new Uint8Array(new SharedArrayBuffer(2))],
        ['empty Uint8ClampedArray', new Uint8ClampedArray(0)],
        ['function', () => 1],
        ['object', {}],
        ['symbol', Symbol('x')],
      ]
      for (const [label, value] of values) {
        await step(`positional ${label}`, () =>
          c.execute({ args: [value], sql: 'select hex(?), typeof(?1)' }),
        )
        await step(`named ${label}`, () =>
          c.execute({ args: { v: value }, sql: 'select hex(:v), typeof(:v)' }),
        )
      }
      await step('batch', () =>
        c.batch([{ args: [new Uint8ClampedArray([9])], sql: 'select hex(?)' }]),
      )
      await step('message', () => E)
      c.close()
    },
  },
  {
    name: 'lastInsertRowid rounding',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await c.execute('create table r (id integer primary key)')
      for (const id of [
        '9223372036854775807',
        '9223372036854774807',
        '-9223372036854775807',
        '-9223372036854775808',
        '9007199254740993',
        '9007199254740991',
        '1',
      ]) {
        await step(id, () => c.execute(`insert into r values (${id})`))
      }
      await step('batch', () => c.batch(['insert into r values (9223372036854775806)']))
      await step('json', async () =>
        (await c.execute('insert into r values (9223372036854775805)')).toJSON(),
      )
      c.close()
    },
  },
  {
    name: 'sync() on a local database',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await step('sync', () => c.sync())
      const t = await c.transaction()
      await step('sync after transaction() (reopens #db)', () => c.sync())
      await t.commit()
      c.close()
      await step('closed sync', () => c.sync())
    },
  },
  {
    name: 'sequential batches',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await step('commit then non-string sql', () => c.batch(['select 1', 'commit', { sql: 123 }]))
      await step('commit then null', () => c.batch(['select 1', 'commit', null]))
      await step('non-string sql rolls back', () => c.batch(['create table bb(a)', { sql: 123 }]))
      await step('null statement', () => c.batch(['create table bb(a)', null]))
      await step('after', () => c.execute(`select count(*) from sqlite_master where name = 'bb'`))
      await step('bad mode', () => c.batch(['select 1'], 'nope'))
      await step('String mode', () => c.batch(['select 1'], new String('write')))
      await step('lazy getters', async () => {
        const seen: string[] = []
        const lazy = (label: string, sql: string) => ({
          get args() {
            seen.push(`${label}.args`)
            return []
          },
          get sql() {
            seen.push(`${label}.sql`)
            return sql
          },
        })
        const r = await c
          .batch([lazy('s0', 'select 1'), 'select nope', lazy('s2', 'select 2')])
          .catch((e: Error) => e.message)
        return [seen, r]
      })
      await step('throwing getter', async () => {
        await c.execute('create table g (a)')
        const r = await c
          .batch([
            'insert into g values (1)',
            {
              get sql(): string {
                throw new Error('boom')
              },
            },
          ])
          .catch((e: Error) => e.message)
        return [r, (await c.execute('select count(*) from g')).rows]
      })
      await step('getter runs a nested execute', async () => {
        let nested: Promise<unknown> | undefined
        const r = await c.batch([
          'insert into g values (2)',
          {
            args: [],
            get sql() {
              nested = c.execute('insert into g values (3)')
              return 'select count(*) from g'
            },
          },
        ])
        await nested
        return [r, (await c.execute('select count(*) from g')).rows]
      })
      await step('named args see earlier statements', () =>
        c.batch([
          'create table nb (a)',
          { args: { a: 1 }, sql: 'insert into nb values (:a)' },
          { args: { a: 1 }, sql: 'select count(*) from nb where a = :a' },
        ]),
      )
      await step('migrate non-string sql', () => c.migrate(['create table mm(a)', { sql: 5 }]))
      await step('migrate commit inside', () => c.migrate(['commit', 'select 1']))
      await step('migrate fk restored', () => c.execute('pragma foreign_keys'))
      const t = await c.transaction()
      await step('tx batch commit inside', () => t.batch(['select 1', 'commit', { sql: 5 }]))
      await step('tx batch after commit', () => t.batch([]))
      c.close()
    },
  },
  {
    name: 'encryption at rest',
    run: async ({ createClient, step, url }) => {
      const file = url.slice('file:'.length)
      const open = async (config: Record<string, unknown>, sql: string) => {
        const d = createClient({ url, ...config })
        try {
          return await d.execute(sql)
        } finally {
          d.close()
        }
      }
      const c = createClient({ encryptionKey: 'secret', url })
      await step('write', () => c.batch(['create table t(a)', `insert into t values ('hello')`]))
      await step('transaction (lazily reopened #db keeps the key)', async () => {
        const t = await c.transaction()
        await t.execute(`insert into t values ('x')`)
        await t.commit()
        return c.execute('select count(*) from t')
      })
      c.close()
      await step(
        'plaintext header',
        () => fs.readFileSync(file).subarray(0, 16).toString('latin1') === 'SQLite format 3\0',
      )
      await step('same key', () => open({ encryptionKey: 'secret' }, 'select * from t'))
      await step('no key', () => open({}, 'select * from t'))
      await step('wrong key', () => open({ encryptionKey: 'nope' }, 'select * from t'))
      await step('empty key', () => open({ encryptionKey: '' }, 'select * from t'))
      await step('null key', () => open({ encryptionKey: null }, 'select 1'))
      await step('number key', () => open({ encryptionKey: 5 }, 'select 1'))
      await step('object key', () =>
        open({ encryptionKey: { toString: () => 'secret' } }, 'select 1'),
      )
      await step('number authToken', () => open({ authToken: 5 }, 'select 1'))
      await step('url authToken over number authToken', async () => {
        const d = createClient({ authToken: 5, encryptionKey: 'secret', url: `${url}?authToken=x` })
        const r = await d.execute('select count(*) from t')
        d.close()
        return r
      })
      await step('number authToken before bad url', () =>
        createClient({ authToken: 5, url: `${url}?foo=1` }),
      )
      await step('memory with key', async () => {
        const m = createClient({ encryptionKey: 'k', url: ':memory:' })
        await m.execute('create table q (a)')
        const r = await m.execute('select count(*) from q')
        m.close()
        return r
      })
      await step('memory ignores bad key and authToken', async () => {
        const m = createClient({
          authToken: 5,
          encryptionKey: 5,
          url: 'file::memory:?cache=shared',
        })
        const r = await m.execute('select 1')
        m.close()
        return r
      })
      await step('file:///:memory: is not in-memory mode', () =>
        createClient({ encryptionKey: 5, url: 'file:///:memory:' }),
      )
      const other = `${file}-nul`
      fs.rmSync(other, { force: true })
      await step('key with NUL', async () => {
        const d = createClient({ encryptionKey: 'a\0b', url: `file:${other}` })
        await d.execute('create table q (a)')
        d.close()
        const results = []
        for (const key of ['a\0b', 'a']) {
          const e = createClient({ encryptionKey: key, url: `file:${other}` })
          results.push(await e.execute('select count(*) from q').catch((err: Error) => err.message))
          e.close()
        }
        return results
      })
      fs.rmSync(other, { force: true })
    },
  },
]
