/**
 * Scenarios run identically against `@libsql/client` and the Rust runtime.
 * Each step records the described outcome (value or thrown error).
 */
import { describeValue } from './describe.js'

export type AnyClient = any
export type CreateClient = (config: any) => AnyClient
export type Log = unknown[]

export type Scenario = {
  name: string
  run: (ctx: { createClient: CreateClient; step: Step; url: string }) => Promise<void>
}

type Step = (label: string, fn: () => unknown) => Promise<unknown>

export const makeStep =
  (log: Log): Step =>
  async (label, fn) => {
    try {
      const value = await fn()
      log.push([label, 'ok', describeValue(value)])
      return value
    } catch (e) {
      log.push([label, 'error', describeValue(e)])
      return undefined
    }
  }

const T =
  'create table t (id integer primary key, a text unique, b real, c blob, d numeric, e, f integer not null default 0, g integer references t(id), h json, i int, j boolean)'

export const scenarios: Scenario[] = [
  {
    name: 'value binding and type mapping',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await step('typeof', () =>
        c.execute({
          args: [1, 1.5, 2 ** 53, 10n, 'x', null, -0, new Uint8Array(1), true, new Date(1000)],
          sql: 'select typeof(?) a, typeof(?) b, typeof(?) c, typeof(?) d, typeof(?) e, typeof(?) f, typeof(?) g, typeof(?) h, typeof(?) i, typeof(?) j',
        }),
      )
      await step('values', () =>
        c.execute({
          args: [1, 1.5, 1e300, -0, 0.1, 1e-320, 123456789.123456789],
          sql: 'select ?, ?, ?, ?, ?, ?, ?',
        }),
      )
      await step('bool/date', () =>
        c.execute({ args: [true, false, new Date(1500)], sql: 'select ?, ?, ?' }),
      )
      await step('blobs', () =>
        c.execute({
          args: [
            Buffer.from('ab'),
            new Uint8Array([1, 2, 3]),
            new Uint8Array([1, 2]).buffer,
            new ArrayBuffer(0),
            Buffer.from([1, 2, 3, 4]).subarray(1, 3),
            new Uint8Array([1, 2, 3, 4]).subarray(1, 3),
          ],
          sql: 'select ?, ?, ?, ?, hex(?), hex(?)',
        }),
      )
      await step('literal blobs', () =>
        c.execute(`select x'0102ff', zeroblob(0), x'', zeroblob(3)`),
      )
      await step('bigint', () =>
        c.execute({ args: [-9007199254740991n, 9007199254740991n], sql: 'select ?, ?' }),
      )
      await step('unsafe int', () => c.execute('select 9007199254740993'))
      await step('max int', () => c.execute({ args: [-9223372036854775808n], sql: 'select ?' }))
      await step('reals', () =>
        c.execute(
          `select 1/0, 5/2, 5.0/2, 'a' || 1, 1e400, -1e400, 0.1+0.2, 9007199254740993.0, cast(1 as real)`,
        ),
      )
      await step('text', () =>
        c.execute({
          args: ['héllo 😀', '\ud800', 'a\u0000b', 'a\u0000b', ''],
          sql: 'select ?, ?, ?, hex(?), ?',
        }),
      )
      await step('nul literal', () =>
        c.execute(`select 'x' || char(0) || 'y', length('x' || char(0) || 'y')`),
      )
      await step('json', () =>
        c.execute(
          `select json_object('a', 1, 'b', json('[1,2]')) j, json_extract('{"a":1.5}', '$.a') x, json_extract('{"a":true}', '$.a') y`,
        ),
      )
      await step('dup cols', () => c.execute('select 1 as x, 2 as x, 3 as "0", 4 as length'))
      c.close()
    },
  },
  {
    name: 'argument errors and binding modes',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      for (const [label, arg] of [
        ['obj', { a: 1 }],
        ['arr', [1]],
        ['sym', Symbol('x')],
        ['fn', () => 1],
        ['undef', undefined],
        ['nan', NaN],
        ['inf', Infinity],
        ['bigbig', 2n ** 64n],
        ['f64arr', new Float64Array([1])],
        ['u16', new Uint16Array([1])],
        ['dataview', new DataView(new ArrayBuffer(2))],
        ['String obj', new String('x')],
        ['Number obj', new Number(1)],
      ] as const) {
        await step(label, () => c.execute({ args: [arg], sql: 'select ?' }))
      }
      await step('bind err + syntax', () => c.execute({ args: [{}], sql: 'selec ?' }))
      await step('undef + syntax', () => c.execute({ args: [undefined], sql: 'selec ?' }))
      await step('bind err run', () =>
        c.execute({ args: [{}], sql: 'create table if not exists q (a)' }),
      )
      await step('toofew', () => c.execute({ args: [1], sql: 'select ?, ?' }))
      await step('toomany', () => c.execute({ args: [1, 2], sql: 'select ?' }))
      await step('noargs', () => c.execute('select ?'))
      await step('string + args', () => c.execute('select ?, ?', [5, 'x']))
      await step('named', () =>
        c.execute({ args: { $c: 3, '@b': 2, a: 1 }, sql: 'select :a, @b, $c' }),
      )
      await step('named missing', () => c.execute({ args: { a: 1 }, sql: 'select :a, :b' }))
      await step('named dup', () =>
        c.execute({ args: { '@a': 2, a: 1 }, sql: 'select :a, @a, $a' }),
      )
      await step('named undefined', () => c.execute({ args: { a: undefined }, sql: 'select :a' }))
      await step('named numeric', () =>
        c.execute({ args: { 1: 'x', 2: 'y' }, sql: 'select ?1, ?2' }),
      )
      await step('numbered positional', () => c.execute({ args: [1, 2], sql: 'select ?2, ?1' }))
      await step('named in array', () => c.execute({ args: [1, 2], sql: 'select :a, ?' }))
      await step('args null', () => c.execute({ args: null, sql: 'select 1' }))
      await step('args missing', () => c.execute({ sql: 'select 1' }))
      await step('stmt undefined', () => c.execute(undefined))
      c.close()
    },
  },
  {
    name: 'statements, results and sqlite errors',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await step('multi select', () => c.execute('select 1; select 2'))
      await step('multi create', () => c.execute('create table m1(a); create table m2(a)'))
      await step('tables', () =>
        c.execute(`select name from sqlite_master where name like 'm%' order by name`),
      )
      for (const sql of [
        '',
        '-- hi',
        '   ',
        ';select 1',
        'select 1;',
        'selec 1',
        'select * from nope',
        'select "nope_col"',
      ]) {
        await step(`sql ${JSON.stringify(sql)}`, () => c.execute(sql))
      }
      await step('create', () => c.execute(T))
      await step('insert', () =>
        c.execute({
          args: ['x', 1.25, new Uint8Array([9, 8]), '12', 'zz', 1, 1, true],
          sql: 'insert into t (a, b, c, d, e, h, i, j) values (?, ?, ?, ?, ?, ?, ?, ?)',
        }),
      )
      await step('insert returning', () =>
        c.execute({
          args: ['y', 2, 2.5, '3'],
          sql: 'insert into t (a, b, d, e) values (?, ?, ?, ?) returning *',
        }),
      )
      await step('dup run', () => c.execute({ args: ['x'], sql: 'insert into t (a) values (?)' }))
      await step('dup returning', () =>
        c.execute({ args: ['x'], sql: 'insert into t (a) values (?) returning id' }),
      )
      await step('notnull', () =>
        c.execute({ args: ['q', null], sql: 'insert into t (a, f) values (?, ?)' }),
      )
      await step('pk', () =>
        c.execute({ args: ['qq'], sql: 'insert into t (id, a) values (1, ?)' }),
      )
      await step('fk default', () => c.execute('PRAGMA foreign_keys'))
      await step('fk', () =>
        c.execute({ args: ['fk', 999], sql: 'insert into t (a, g) values (?, ?)' }),
      )
      await step('check', () => c.execute('create table ck (a integer check (a > 0))'))
      await step('check fail', () => c.execute('insert into ck values (-1)'))
      await step('runtime err reader', () => c.execute(`select json('{bad')`))
      await step('runtime err 2nd row', () =>
        c.execute(`select json(a) from (select '1' a union all select '{bad')`),
      )
      await step('runtime err run', () =>
        c.execute(`insert into t (a, e) values ('z', json('{bad'))`),
      )
      await step('overflow', () => c.execute('select abs(-9223372036854775808)'))
      await step('select', () => c.execute('select * from t'))
      await step('select expr', () =>
        c.execute('select id, id + 1, a as a, a, count(*) over () from t'),
      )
      await step('decltypes', async () => {
        await c.execute(
          `create table dt (a int, b integer, c Integer, d iNt, e int(11), f bigint, g text, h Text, i real, j blob, k numeric, l "int", m [Int], n INT NOT NULL, o tinyint, p double, q float, r varchar, s TEXT, t "text", u json, v Numeric, w any, x boolean, y DATETIME, z "weird type")`,
        )
        return c.execute('select *, a as aa, a || 1 from dt')
      })
      await step('view', async () => {
        await c.execute('create view v as select a, b from dt')
        return c.execute('select * from v')
      })
      await step('update', () =>
        c.execute({ args: [2, 0], sql: 'update t set b = ? where id > ?' }),
      )
      await step('update none', () => c.execute('update t set b = 1 where id < 0'))
      await step('ddl after dml', () => c.execute('create table after_dml (a)'))
      await step('delete', () => c.execute('delete from t where id = 2'))
      await step('pragma jm', () => c.execute('PRAGMA journal_mode'))
      await step('pragma wal', () => c.execute('PRAGMA journal_mode = WAL'))
      await step('pragma bt', () => c.execute('PRAGMA busy_timeout'))
      await step('pragma bt set', () => c.execute('PRAGMA busy_timeout = 5000'))
      await step('pragma sync', () => c.execute('PRAGMA synchronous = NORMAL'))
      await step('pragma sync get', () => c.execute('PRAGMA synchronous'))
      await step('pragma table_info', () => c.execute('PRAGMA table_info(t)'))
      await step('pragma index_list', () => c.execute('PRAGMA index_list(t)'))
      await step('pragma fk_list', () => c.execute('PRAGMA foreign_key_list(t)'))
      for (const p of [
        'cache_size',
        'page_size',
        'temp_store',
        'secure_delete',
        'auto_vacuum',
        'legacy_alter_table',
        'trusted_schema',
        'automatic_index',
        'recursive_triggers',
        'encoding',
        'locking_mode',
        'wal_autocheckpoint',
        'journal_size_limit',
        'defer_foreign_keys',
      ]) {
        await step(`pragma ${p}`, () => c.execute(`PRAGMA ${p}`))
      }
      await step('begin', () => c.execute('BEGIN'))
      await step('commit', () => c.execute('COMMIT'))
      await step('commit again', () => c.execute('COMMIT'))
      await step('like', () => c.execute(`select 'A' like 'a', 'ä' like 'Ä'`))
      await step('math', () => c.execute('select sqrt(4), ln(1)'))
      await step('fts5', () => c.execute('create virtual table ft using fts5(x)'))
      await step('rtree', () => c.execute('create virtual table rt using rtree(id, a, b)'))
      await step('row assign', async () => {
        const r = await c.execute('select 1 a')
        const row = r.rows[0]
        row.a = 5
        row.z = 1
        const out = [row.a, row.z, Object.isExtensible(row)]
        row[0] = 9
        return out
      })
      await step('rs toJSON', async () => (await c.execute(`select 1, x'0a', 2.5`)).toJSON())
      c.close()
    },
  },
  {
    name: 'batch',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await c.execute(T)
      await step('batch', () =>
        c.batch([{ args: ['b1'], sql: 'insert into t (a) values (?)' }, 'select count(*) from t']),
      )
      await step('batch fail', () =>
        c.batch([
          { args: ['b2'], sql: 'insert into t (a) values (?)' },
          { args: ['b2'], sql: 'insert into t (a) values (?)' },
        ]),
      )
      await step('after batch fail', () => c.execute(`select count(*) from t where a = 'b2'`))
      await step('batch arg error', () =>
        c.batch([
          { args: ['b3'], sql: 'insert into t (a) values (?)' },
          { args: [undefined], sql: 'select ?' },
        ]),
      )
      await step('after arg error', () => c.execute(`select count(*) from t where a = 'b3'`))
      await step('batch syntax + arg error', () =>
        c.batch(['selec', { args: [undefined], sql: 'select ?' }]),
      )
      await step('batch commit inside', () =>
        c.batch([`insert into t (a) values ('b4')`, 'commit', 'select 1']),
      )
      await step('after commit inside', () => c.execute(`select count(*) from t where a = 'b4'`))
      await step('batch rollback inside', () =>
        c.batch([`insert into t (a) values ('b5')`, 'rollback', 'select 1']),
      )
      await step('batch bad mode', () => c.batch(['select 1'], 'nope'))
      await step('batch read', () => c.batch(['select 1'], 'read'))
      await step('batch write', () =>
        c.batch([`insert into t (a) values ('b6') returning a`], 'write'),
      )
      await step('batch empty', () => c.batch([]))
      await step('batch undefined stmt', () =>
        c.batch([`insert into t (a) values ('b7')`, undefined]),
      )
      await step('after undefined stmt', () => c.execute(`select count(*) from t where a = 'b7'`))
      await step('migrate', () =>
        c.migrate([`insert into t (a) values ('m1')`, 'PRAGMA foreign_keys']),
      )
      await step('migrate fail', () => c.migrate([`insert into t (a) values ('m2')`, 'selec']))
      await step('after migrate', () => c.execute(`select a from t where a like 'm%'`))
      await step('fk after migrate', () => c.execute('PRAGMA foreign_keys'))
      await step('exm', () =>
        c.executeMultiple(
          'create table em(a); insert into em values (1); insert into em values (2);',
        ),
      )
      await step('exm fail', () =>
        c.executeMultiple('insert into em values (3); selec; insert into em values (4);'),
      )
      await step('exm constraint', () =>
        c.executeMultiple(`insert into t (a) values ('x1'); insert into t (a) values ('x1');`),
      )
      await step('exm begin', () => c.executeMultiple('begin; insert into em values (5);'))
      await step('exm after', () => c.execute('select * from em'))
      await step('exm empty', () => c.executeMultiple(''))
      await step('exm reader', () => c.executeMultiple('select 1; select 2'))
      await step('exm nul', () =>
        c.executeMultiple('insert into em values (7);\u0000insert into em values (8);'),
      )
      await step('exm after nul', () => c.execute('select * from em'))
      c.close()
    },
  },
  {
    name: 'interactive transactions',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await c.execute(T)
      const tx = await step('tx', () => c.transaction('write'))
      await step('tx props', () => [
        (tx as any).constructor.name,
        (tx as any).closed,
        Object.keys(tx as object),
      ])
      await step('tx exec', () =>
        (tx as any).execute({ args: ['tx1'], sql: 'insert into t (a) values (?)' }),
      )
      await step('outside read during tx', () => c.execute('select count(*) from t'))
      await step('outside write during tx', () => c.execute(`insert into t (a) values ('o1')`))
      await step('second write tx busy', () => c.transaction('write'))
      await step('bt new conn', () => c.execute('PRAGMA busy_timeout'))
      await step('tx batch', () => (tx as any).batch(['select 1', { args: [2], sql: 'select ?' }]))
      await step('tx batch fail', () => (tx as any).batch(['select 1', 'selec 2', 'select 3']))
      await step('tx executeMultiple', () =>
        (tx as any).executeMultiple(
          `insert into t (a) values ('tx2'); insert into t (a) values ('tx3')`,
        ),
      )
      await step('tx constraint', () => (tx as any).execute(`insert into t (a) values ('tx1')`))
      await step('tx still open', () => (tx as any).closed)
      await step('tx commit', () => (tx as any).commit())
      await step('tx closed', () => (tx as any).closed)
      await step('tx exec after', () => (tx as any).execute('select 1'))
      await step('tx exec after bad arg', () =>
        (tx as any).execute({ args: [undefined], sql: 'select ?' }),
      )
      await step('tx batch after', () => (tx as any).batch(['select 1']))
      await step('tx exm after', () => (tx as any).executeMultiple('select 1'))
      await step('tx rollback after', () => (tx as any).rollback())
      await step('tx commit after', () => (tx as any).commit())
      await step('tx close after', () => (tx as any).close())
      await step('committed', () => c.execute(`select a from t where a like 'tx%' order by a`))
      const tx2 = await c.transaction()
      await step('tx2 exec', () => tx2.execute(`insert into t (a) values ('r1')`))
      await step('tx2 rollback', () => tx2.rollback())
      await step('tx2 after', () => c.execute(`select count(*) from t where a = 'r1'`))
      const tx3 = await c.transaction('deferred')
      await step('tx3 COMMIT stmt', () => tx3.execute('COMMIT'))
      await step('tx3 closed', () => tx3.closed)
      await step('tx3 commit', () => tx3.commit())
      await step('tx bad mode', () => c.transaction('bad'))
      const tx4 = await c.transaction('read')
      await step('tx4 write', () => tx4.execute(`insert into t (a) values ('rd')`))
      await step('tx4 close', () => tx4.close())
      await step('tx4 closed', () => tx4.closed)
      await step('tx4 rolled back', () => c.execute(`select count(*) from t where a = 'rd'`))
      c.close()
    },
  },
  {
    // Separate client: in libsql, reader statements of earlier (committed)
    // transaction connections are only reset on GC and keep a SHARED lock,
    // which makes later commits fail with SQLITE_BUSY (see 'libsql quirks').
    name: 'savepoints and unawaited calls',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await c.execute(T)
      await step('savepoints', async () => {
        const t = await c.transaction()
        await t.execute('savepoint sp0')
        await t.execute(`insert into t (a) values ('sp')`)
        await t.execute('rollback to savepoint sp0')
        await t.execute('release savepoint sp0')
        await t.commit()
        return c.execute(`select count(*) c from t where a = 'sp'`)
      })
      await step('unawaited tx ops', async () => {
        const t = await c.transaction()
        const ps = [
          t.execute(`insert into t (a) values ('u1')`),
          t.execute(`insert into t (a) values ('u1')`),
          t.execute(`select count(*) from t where a = 'u1'`),
          t.commit(),
          t.execute('select 1'),
        ]
        return Promise.allSettled(ps)
      })
      await step('unawaited client ops', () =>
        Promise.allSettled([
          c.execute(`insert into t (a) values ('c1')`),
          c.batch([`insert into t (a) values ('c2')`, `insert into t (a) values ('c1')`]),
          c.execute(`select a from t where a like 'c%' order by a`),
          c.executeMultiple(`insert into t (a) values ('c3')`),
          c.execute(`select a from t where a like 'c%' order by a`),
        ]),
      )
      c.close()
    },
  },
  {
    name: 'client lifecycle',
    run: async ({ createClient, step, url }) => {
      const c = createClient({ url })
      await step('props', () => [c.constructor.name, c.closed, c.protocol, Object.keys(c)])
      const t = await c.transaction()
      c.close()
      await step('closed after tx', () => c.closed)
      await step('closed exec', () => c.execute('select 1'))
      await step('closed batch', () => c.batch(['select 1']))
      await step('closed migrate', () => c.migrate(['select 1']))
      await step('closed exm', () => c.executeMultiple('select 1'))
      await step('closed tx (db was null -> reopens)', async () => {
        const t2 = await c.transaction()
        const r = await t2.execute('select 1')
        await t2.commit()
        return r
      })
      await step('closed close', () => c.close())
      await step('old tx still works', () => t.execute('select 2'))
      await step('old tx commit', () => t.commit())
      const c2 = createClient({ url })
      c2.close()
      await step('tx on closed db', () => c2.transaction())
    },
  },
  {
    name: 'int modes',
    run: async ({ createClient, step, url }) => {
      for (const intMode of ['bigint', 'string', 'number']) {
        const c = createClient({ intMode, url })
        await step(`${intMode} select`, () =>
          c.execute({
            args: [true, 5, 7n],
            sql: 'select 1, 1.5, ?, typeof(?), ?, 9223372036854775807',
          }),
        )
        await step(`${intMode} run`, async () => {
          await c.execute('create table if not exists im (a)')
          return c.execute({ args: [true], sql: 'insert into im values (?)' })
        })
        c.close()
      }
    },
  },
  {
    name: 'in-memory databases',
    run: async ({ createClient, step }) => {
      const m = createClient({ url: ':memory:' })
      await step('create', () => m.execute('create table a(x)'))
      await step('tables', () => m.execute('select name from sqlite_master'))
      const t = await m.transaction()
      await step('new conn sees empty db', () => m.execute('select name from sqlite_master'))
      await step('tx sees table', () => t.execute('select name from sqlite_master'))
      await t.commit()
      await step('wal on memory', () => m.execute('PRAGMA journal_mode = WAL'))
      m.close()
      const s = createClient({ url: 'file::memory:?cache=shared' })
      await step('shared', () => s.execute('select 1'))
      s.close()
    },
  },
]

/** Config validation scenarios (no database file is created). */
export const configCases: Array<[string, unknown]> = [
  ['not an object', 'file:x'],
  ['null', null],
  ['bad url', { url: 'nope' }],
  ['undefined url', {}],
  ['unknown scheme', { url: 'foo://x' }],
  ['file host', { url: 'file://host/x.db' }],
  ['file port', { url: 'file://localhost:80/x.db' }],
  ['file userinfo', { url: 'file://u:p@localhost/x.db' }],
  ['query param', { url: 'file:/tmp/rs-sqlite-diff-x.db?foo=1' }],
  ['tls param', { url: 'file:/tmp/rs-sqlite-diff-x.db?tls=2' }],
  ['fragment', { url: 'file:/tmp/rs-sqlite-diff-x.db#a' }],
  ['bad percent', { url: 'file:/tmp/%zz.db' }],
  ['bad authority', { url: 'file://a@b:x/y' }],
  ['memory bad cache', { url: 'file::memory:?cache=x' }],
  ['memory bad param', { url: 'file::memory:?mode=ro' }],
  ['memory syncUrl', { syncUrl: 'http://x', url: ':memory:' }],
  ['bad intMode', { intMode: 'x', url: ':memory:' }],
  ['bad intMode + fragment', { intMode: 'x', url: 'file:a#b' }],
  ['bad intMode + scheme', { intMode: 5, url: 'foo:a' }],
  ['directory', { url: 'file:/tmp' }],
  ['missing dir', { url: 'file:/nonexistent-rs-sqlite/dir/x.db' }],
  ['libsql tls=0 no port', { url: 'libsql://x?tls=0' }],
]

export const mathScenario: Scenario = {
  name: 'math functions',
  run: async ({ createClient, step, url }) => {
    const c = createClient({ url })
    const inputs = ['2', '2.5', '-2.5', '0', '-1', 'null', `'abc'`, `'4'`, '9007199254740993', `x'01'`, '1e400', '-0.0', '0.5']
    for (const f of ['ceil', 'ceiling', 'floor', 'trunc', 'ln', 'log', 'log10', 'log2', 'exp', 'acos', 'asin', 'atan', 'cos', 'sin', 'tan', 'cosh', 'sinh', 'tanh', 'acosh', 'asinh', 'atanh', 'sqrt', 'radians', 'degrees', 'cot', 'coth', 'square', 'sign', 'abs']) {
      await step(f, () => c.execute(`select ${inputs.map((i) => `${f}(${i})`).join(', ')}`))
    }
    for (const f of ['pow', 'power', 'mod', 'atan2', 'atn2', 'log']) {
      await step(f + '2', () => c.execute(`select ${f}(2, 3), ${f}(2.5, -1), ${f}(0, 0), ${f}(null, 1), ${f}(1, 'x'), ${f}('x', 2), ${f}(-8, 1.0/3)`))
    }
    await step('pi', () => c.execute('select pi(), sign(-2), sign(3.5), sign(0), sign(null)'))
    await step('index on math', () => c.execute('create table mi (a real); create index mi_a on mi(floor(a))'))
    c.close()
  },
}
