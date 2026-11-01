import { createClient } from '@libsql/client'
import fs from 'node:fs'
const f = '/tmp/rs-sqlite-probe.db'
for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(f + s, { force: true })
import util from 'node:util'
util.inspect.defaultOptions.depth = 8
util.inspect.defaultOptions.breakLength = 200
const c = createClient({ url: 'file:' + f })
const show = async (label, fn) => {
  try {
    const r = await fn()
    console.log(
      label,
      '=>',
      r && r.rows
        ? {
            cols: r.columns,
            types: r.columnTypes,
            rows: r.rows.map((x) =>
              [...Array.prototype.slice.call(x)].map((v) => [
                typeof v,
                v instanceof ArrayBuffer ? ['AB', v.byteLength] : v,
              ]),
            ),
            ra: r.rowsAffected,
            lid: r.lastInsertRowid,
          }
        : r,
    )
  } catch (e) {
    console.log(
      label,
      'ERR',
      e.constructor.name,
      e.name,
      JSON.stringify(e.message),
      e.code,
      e.rawCode,
      e.cause && [
        e.cause.constructor.name,
        e.cause.name,
        e.cause.message,
        e.cause.code,
        e.cause.rawCode,
      ],
    )
  }
}
await show('typeof', () =>
  c.execute({
    sql: 'select typeof(?) a, typeof(?) b, typeof(?) c, typeof(?) d, typeof(?) e, typeof(?) f, typeof(?) g',
    args: [1, 1.5, 2 ** 53, 10n, 'x', null, -0],
  }),
)
await show('vals', () => c.execute({ sql: 'select ?, ?, ?, ?', args: [1, 1.5, 1e300, -0] }))
await show('bool', () => c.execute({ sql: 'select ?, typeof(?)', args: [true, false] }))
await show('date', () =>
  c.execute({ sql: 'select ?, typeof(?)', args: [new Date(1000), new Date(1500)] }),
)
await show('buf', () =>
  c.execute({ sql: 'select ?, typeof(?)', args: [Buffer.from('ab'), new Uint8Array([1, 2, 3])] }),
)
await show('ab', () =>
  c.execute({
    sql: 'select ?, typeof(?)',
    args: [new Uint8Array([1, 2]).buffer, new ArrayBuffer(3)],
  }),
)
await show('obj', () => c.execute({ sql: 'select ?', args: [{ a: 1 }] }))
await show('arr', () => c.execute({ sql: 'select ?', args: [[1]] }))
await show('sym', () => c.execute({ sql: 'select ?', args: [Symbol('x')] }))
await show('fn', () => c.execute({ sql: 'select ?', args: [() => 1] }))
await show('undef', () => c.execute({ sql: 'select ?', args: [undefined] }))
await show('nan', () => c.execute({ sql: 'select ?', args: [NaN] }))
await show('bigbig', () => c.execute({ sql: 'select ?', args: [2n ** 64n] }))
await show('toofew', () => c.execute({ sql: 'select ?, ?', args: [1] }))
await show('toomany', () => c.execute({ sql: 'select ?', args: [1, 2] }))
await show('noargs', () => c.execute('select ?'))
await show('named', () => c.execute({ sql: 'select :a, @b, $c', args: { a: 1, '@b': 2, $c: 3 } }))
await show('named-missing', () => c.execute({ sql: 'select :a, :b', args: { a: 1 } }))
await show('numbered', () => c.execute({ sql: 'select ?2, ?1', args: [1, 2] }))
await show('largeint', () => c.execute('select 9007199254740993'))
await show('maxint', () => c.execute('select 9223372036854775807, -9223372036854775808'))
await show('multi', () => c.execute('select 1; select 2'))
await show('multi2', () => c.execute('create table m1(a); create table m2(a)'))
await show('empty', () => c.execute(''))
await show('comment', () => c.execute('-- hi'))
await show('ws', () => c.execute('   '))
await show('syntax', () => c.execute('selec 1'))
await show('notable', () => c.execute('select * from nope'))
await show('create', () =>
  c.execute(
    'create table t (id integer primary key, a text unique, b real, c blob, d numeric, e, f integer not null default 0, g integer references t(id))',
  ),
)
await show('insert', () =>
  c.execute({
    sql: 'insert into t (a, b, c, d, e) values (?, ?, ?, ?, ?)',
    args: ['x', 1.25, new Uint8Array([9, 8]), '12', 'zz'],
  }),
)
await show('insret', () =>
  c.execute({ sql: 'insert into t (a) values (?) returning *', args: ['y'] }),
)
await show('dup', () => c.execute({ sql: 'insert into t (a) values (?)', args: ['x'] }))
await show('notnull', () =>
  c.execute({ sql: 'insert into t (a, f) values (?, ?)', args: ['q', null] }),
)
await show('pk', () => c.execute({ sql: 'insert into t (id, a) values (1, ?)', args: ['qq'] }))
await show('pragma fk on', () => c.execute('PRAGMA foreign_keys = ON'))
await show('fk', () => c.execute({ sql: 'insert into t (a, g) values (?, ?)', args: ['fk', 999] }))
await show('check', () => c.execute('create table ck (a integer check (a > 0))'))
await show('checkfail', () => c.execute('insert into ck values (-1)'))
await show('select', () => c.execute('select * from t'))
await show('select expr', () => c.execute('select id, id + 1, a as a, a, count(*) over () from t'))
await show('dupcol', () => c.execute('select 1 as x, 2 as x'))
await show('update', () => c.execute({ sql: 'update t set b = ? where id > ?', args: [2, 0] }))
await show('delete', () => c.execute('delete from t where id = 2'))
await show('pragma jm', () => c.execute('PRAGMA journal_mode'))
await show('pragma wal', () => c.execute('PRAGMA journal_mode = WAL'))
await show('pragma bt', () => c.execute('PRAGMA busy_timeout'))
await show('pragma bt set', () => c.execute('PRAGMA busy_timeout = 5000'))
await show('pragma sync', () => c.execute('PRAGMA synchronous = NORMAL'))
await show('pragma fk', () => c.execute('PRAGMA foreign_keys'))
await show('pragma fklist', () => c.execute('PRAGMA table_info(t)'))
await show('begin', () => c.execute('BEGIN'))
await show('commit', () => c.execute('COMMIT'))
await show('commit2', () => c.execute('COMMIT'))
await show('json', () =>
  c.execute(`select json_object('a', 1, 'b', json('[1,2]')) j, json_extract('{"a":1.5}', '$.a') x`),
)
await show('row access', async () => {
  const r = await c.execute('select 1 as a, 2 as b')
  const row = r.rows[0]
  return {
    keys: Object.keys(row),
    json: JSON.stringify(row),
    len: row.length,
    i0: row[0],
    a: row.a,
    desc: Object.getOwnPropertyDescriptors(row),
    rj: JSON.stringify(r),
  }
})
await show('row named length', async () => {
  const r = await c.execute('select 1 as length, 2 as "0"')
  const row = r.rows[0]
  return {
    keys: Object.keys(row),
    len: row.length,
    i0: row[0],
    desc: Object.getOwnPropertyDescriptors(row),
  }
})
await show('rs', async () => {
  const r = await c.execute('select 1')
  return [r.constructor.name, Object.keys(r), JSON.stringify(r), r.toJSON()]
})
await show('batch', () =>
  c.batch([{ sql: 'insert into t (a) values (?)', args: ['b1'] }, 'select count(*) from t']),
)
await show('batch fail', () =>
  c.batch([
    { sql: 'insert into t (a) values (?)', args: ['b2'] },
    { sql: 'insert into t (a) values (?)', args: ['b2'] },
  ]),
)
await show('after batch fail', () => c.execute(`select count(*) from t where a = 'b2'`))
await show('batch commit inside', () =>
  c.batch(["insert into t (a) values ('b3')", 'commit', 'select 1']),
)
await show('batch mode', () => c.batch(['select 1'], 'nope'))
await show('batch read', () => c.batch(['select 1'], 'read'))
await show('exm', () =>
  c.executeMultiple('create table em(a); insert into em values (1); insert into em values (2);'),
)
await show('exm fail', () =>
  c.executeMultiple('insert into em values (3); selec; insert into em values (4);'),
)
await show('exm after', () => c.execute('select * from em'))
await show('exm begin', () => c.executeMultiple('begin; insert into em values (5);'))
await show('exm begin after', () => c.execute('select * from em'))
await show('exm empty', () => c.executeMultiple(''))
const tx = await c.transaction('write')
await show('tx props', async () => [tx.constructor.name, tx.closed, Object.keys(tx)])
await show('tx exec', () => tx.execute({ sql: 'insert into t (a) values (?)', args: ['tx1'] }))
await show('outside during tx', () => c.execute('select count(*) from t'))
await show('outside write during tx', () => c.execute(`insert into t (a) values ('o1')`))
await show('pragma bt new conn', () => c.execute('PRAGMA busy_timeout'))
await show('tx batch', () => tx.batch(['select 1', { sql: 'select ?', args: [2] }]))
await show('tx batch fail', () => tx.batch(['select 1', 'selec 2', 'select 3']))
await show('tx still', async () => tx.closed)
await show('tx commit', () => tx.commit())
await show('tx closed', async () => tx.closed)
await show('tx exec after', () => tx.execute('select 1'))
await show('tx rollback after', () => tx.rollback())
await show('tx commit after', () => tx.commit())
await show('tx close after', async () => tx.close())
const tx2 = await c.transaction()
await show('tx2 exec', () => tx2.execute(`insert into t (a) values ('tx2')`))
await show('tx2 rollback', () => tx2.rollback())
await show('tx2 after', () => c.execute(`select count(*) from t where a='tx2'`))
const tx3 = await c.transaction('deferred')
await show('tx3 commit stmt', () => tx3.execute('COMMIT'))
await show('tx3 closed', async () => tx3.closed)
await show('tx3 commit', () => tx3.commit())
await show('tx mode bad', () => c.transaction('bad'))
const tx4 = await c.transaction('read')
await show('tx4 write', () => tx4.execute(`insert into t (a) values ('r')`))
tx4.close()
await show('tx4 closed', async () => tx4.closed)
const tx5 = await c.transaction()
await show('tx5 err', () => tx5.execute(`insert into t (a) values ('x')`))
await show('tx5 closed after err', async () => tx5.closed)
await show('tx5 rollback', () => tx5.rollback())
await show('savepoint', async () => {
  const t = await c.transaction()
  await t.execute('savepoint sp0')
  await t.execute(`insert into t (a) values ('sp')`)
  await t.execute('rollback to savepoint sp0')
  await t.execute('release savepoint sp0')
  await t.commit()
  return (await c.execute(`select count(*) c from t where a = 'sp'`)).rows[0].c
})
await show('migrate', () => c.migrate(['select 1']))
await show('client props', async () => [c.constructor.name, c.closed, c.protocol, Object.keys(c)])
c.close()
await show('closed exec', () => c.execute('select 1'))
await show('closed batch', () => c.batch(['select 1']))
await show('closed tx', async () => {
  const t = await c.transaction()
  return t.closed
})
await show('closed exm', () => c.executeMultiple('select 1'))
await show('closed close', async () => c.close())
