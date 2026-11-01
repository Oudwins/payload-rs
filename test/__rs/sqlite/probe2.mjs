import { createClient } from '@libsql/client'
import fs from 'node:fs'
const f = '/tmp/rs-sqlite-probe2.db'
for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(f + s, { force: true })
const c = createClient({ url: 'file:' + f })
const show = async (label, fn) => {
  try {
    const r = await fn()
    console.log(
      label,
      '=>',
      r && r.rows ? JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v + 'n' : v)) : r,
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
      Object.keys(e),
      Object.getOwnPropertyNames(e),
      e.libsqlError,
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
await c.execute(
  'create table t (id integer primary key, a text unique, n integer, tx text, r real)',
)
await show('typeof', () =>
  c.execute({
    sql: 'select typeof(?) a, typeof(?) b, typeof(?) c, typeof(?) d, typeof(?) e, typeof(?) f, typeof(?) g, typeof(?) h',
    args: [1, 1.5, 2 ** 53, 10n, 'x', null, -0, new Uint8Array(1)],
  }),
)
await show('ins', () =>
  c.execute({
    sql: 'insert into t (a, n, tx, r) values (?, ?, ?, ?) returning *',
    args: ['x', 1, 1, 1],
  }),
)
await show('ins2', () =>
  c.execute({
    sql: 'insert into t (a, n, tx, r) values (?, ?, ?, ?) returning *',
    args: ['y', 1.5, 2.5, true],
  }),
)
await show('dupret', () =>
  c.execute({ sql: 'insert into t (a) values (?) returning id', args: ['x'] }),
)
await show('dupret-tx', async () => {
  const t = await c.transaction()
  try {
    return await t.execute({ sql: 'insert into t (a) values (?) returning id', args: ['x'] })
  } finally {
    t.close()
  }
})
await show('runtime err select', () => c.execute(`select json('{bad')`))
await show('runtime err select 2nd row', () =>
  c.execute(`select json(a) from (select '1' a union all select '{bad')`),
)
await show('runtime err non-reader', () =>
  c.execute(`insert into t (a, tx) values ('z', json('{bad'))`),
)
await show('div', () => c.execute(`select 1/0, 5/2, 5.0/2, 'a' || 1, 1e400, -1e400, 0.1+0.2`))
await show('abs overflow', () => c.execute(`select abs(-9223372036854775808)`))
await show('large in real', () =>
  c.execute(`select 9007199254740993.0, cast(9007199254740993 as real)`),
)
await show('text unicode', () =>
  c.execute({ sql: 'select ?, length(?)', args: ['héllo 😀 \u0000x', '😀'] }),
)
await show('blob ret', async () => {
  const r = await c.execute(`select x'0102ff', zeroblob(0), x''`)
  const v = r.rows[0]
  return [
    v[0] instanceof ArrayBuffer,
    v[0].byteLength,
    [...new Uint8Array(v[0])],
    v[1].byteLength,
    v[1] instanceof ArrayBuffer,
    Object.prototype.toString.call(v[2]),
  ]
})
await show('row frozen?', async () => {
  const r = await c.execute(`select 1 a`)
  const row = r.rows[0]
  row.a = 5
  row[0] = 9
  row.z = 1
  return [
    row.a,
    row[0],
    row.z,
    Object.isExtensible(row),
    Object.getPrototypeOf(row) === Object.prototype,
    Array.isArray(r.rows),
    Object.isFrozen(r.rows),
  ]
})
await show('intMode bigint', async () => {
  const c2 = createClient({ url: 'file:' + f, intMode: 'bigint' })
  const r = await c2.execute({ sql: 'select 1, 1.5, ?, ?, 9223372036854775807', args: [true, 5] })
  c2.close()
  return r
})
await show('intMode string', async () => {
  const c2 = createClient({ url: 'file:' + f, intMode: 'string' })
  const r = await c2.execute({
    sql: 'select 1, 1.5, ?, typeof(?), 9223372036854775807',
    args: [true, true],
  })
  c2.close()
  return r
})
await show('intMode bad', async () => createClient({ url: 'file:' + f, intMode: 'x' }))
await show('url bad', async () => createClient({ url: 'nope' }))
await show('url http', async () => createClient({ url: 'foo://x' }))
await show('url host', async () => createClient({ url: 'file://host/x.db' }))
await show('url query', async () => createClient({ url: 'file:x.db?foo=1' }))
await show('url frag', async () => createClient({ url: 'file:x.db#a' }))
await show('url dir', async () => createClient({ url: 'file:/tmp' }))
await show('url missing dir', async () => createClient({ url: 'file:/nonexistent/dir/x.db' }))
await show('not obj', async () => createClient('file:x'))
await show('mem', async () => {
  const m = createClient({ url: ':memory:' })
  await m.execute('create table a(x)')
  const r = await m.execute('select name from sqlite_master')
  const t = await m.transaction()
  const r2 = await m.execute('select name from sqlite_master')
  await t.commit()
  return [r.rows.length, r2.rows.length]
})
await show('mem2', async () => {
  const m = createClient({ url: 'file::memory:?cache=shared' })
  return (await m.execute('select 1')).rows.length
})
await show('readonly reader stmt', () => c.execute(`with x as (select 1) select * from x`))
await show('explain', () => c.execute(`explain query plan select * from t`))
await show('vacuum', () => c.execute(`vacuum`))
await show('decltypes', async () => {
  await c.execute('create table dt (a varchar(10), b DATETIME, c boolean, d "weird type", e int)')
  return c.execute('select * , a as aa, a || 1 from dt')
})
