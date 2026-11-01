import { createClient } from '@libsql/client'
import fs from 'node:fs'
const f = '/tmp/rs-sqlite-probe3.db'
for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(f + s, { force: true })
const c = createClient({ url: 'file:' + f })
const show = async (label, fn) => {
  try {
    const r = await fn()
    console.log(label, '=>', r && r.rows ? JSON.stringify(r) : r)
  } catch (e) {
    console.log(
      label,
      'ERR',
      e.constructor.name,
      JSON.stringify(e.message),
      JSON.stringify(e.code),
      e.rawCode,
    )
  }
}
await show('dt2', async () => {
  await c.execute(
    'create table dt2 (a Numeric, b NUMERIC, c Blob, d boolean, e date, f any, g FLOAT, h Real, i "double precision", j string, k char, l "", m Integer primary key, n "INTEGER", o "Text ", p " text", q TEXT(5), r "real", s rEaL)',
  )
  return c.execute('select * from dt2')
})
await show('vacuum fresh', () => c.execute(`vacuum`))
await show('dt', async () => {
  await c.execute(
    'create table dt (a int, b integer, c Integer, d iNt, e int(11), f bigint, g text, h Text, i real, j blob, k numeric, l "int", m [Int], n INT NOT NULL, o tinyint, p double, q float, r varchar, s TEXT, t "text", u json)',
  )
  return c.execute('select * from dt')
})
await show('dt view', async () => {
  await c.execute('create view v as select a, b from dt')
  return c.execute('select * from v')
})
await show('nul bind', () =>
  c.execute({ sql: 'select length(?), hex(?), ?', args: ['a\u0000b', 'a\u0000b', 'a\u0000b'] }),
)
await show('nul lit', () =>
  c.execute(`select 'x' || char(0) || 'y', length('x' || char(0) || 'y')`),
)
await show('lone surrogate', () =>
  c.execute({ sql: 'select hex(?), ?', args: ['\ud800', '\ud800'] }),
)
await show('url dir code', async () => {
  try {
    createClient({ url: 'file:/tmp' })
  } catch (e) {
    return [e.code, typeof e.code, e.constructor === Error, Object.getOwnPropertyDescriptors(e)]
  }
})
await show('busy new conn', async () => {
  await c.execute('PRAGMA busy_timeout = 3000')
  const t = await c.transaction('read')
  await t.commit()
  return c.execute('PRAGMA busy_timeout')
})
await show('fk default', () => c.execute('PRAGMA foreign_keys'))
await show('rec triggers', () => c.execute('PRAGMA recursive_triggers'))
await show('compile', async () => (await c.execute('select sqlite_version()')).rows[0][0])
await show('defensive', () => c.execute(`PRAGMA journal_mode`))
await show('double quoted str', () => c.execute(`select "nope_col"`))
await show('like', () => c.execute(`select 'A' like 'a', 'ä' like 'Ä'`))
await show('json fns', () => c.execute(`select json_each.value from json_each('[1,2]')`))
await show('fts5', () => c.execute(`create virtual table ft using fts5(x)`))
await show('rtree', () => c.execute(`create virtual table rt using rtree(id, a, b)`))
await show('math', () => c.execute(`select sqrt(4), ln(1)`))
await show('trailing semi', () => c.execute(`select 1;`))
await show('two semi', () => c.execute(`;select 1`))
await show('param named in array', () => c.execute({ sql: `select :a, ?`, args: [1, 2] }))
await show('param array to named', () => c.execute({ sql: `select :a`, args: { b: 1 } }))
await show('param named numeric key', () =>
  c.execute({ sql: `select ?1, ?2`, args: { 1: 'x', 2: 'y' } }),
)
await show('args null', () => c.execute({ sql: `select 1`, args: null }))
await show('args undefined', () => c.execute({ sql: `select 1` }))
await show('exec string args', () => c.execute(`select ?`, [5]))
await show('stmt string', () => c.batch([`select 1`]))
await show('batch empty', () => c.batch([]))
await show('exm reader', () => c.executeMultiple(`select 1; select 2`))
await show('exm err code', () =>
  c.executeMultiple(`create table u(a unique); insert into u values (1); insert into u values (1)`),
)
