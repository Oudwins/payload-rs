import { createClient } from '@libsql/client'
const c = createClient({ url: ':memory:' })
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
      e.libsqlError,
    )
  }
}
await show('f64arr', () =>
  c.execute({
    sql: 'select typeof(?), hex(?)',
    args: [new Float64Array([1]), new Float64Array([1])],
  }),
)
await show('u16', () =>
  c.execute({
    sql: 'select typeof(?), hex(?)',
    args: [new Uint16Array([1]), new Uint16Array([1])],
  }),
)
await show('dv', () =>
  c.execute({ sql: 'select typeof(?), hex(?)', args: [new DataView(new ArrayBuffer(2)), 1] }),
)
await show('sub', () =>
  c.execute({ sql: 'select hex(?)', args: [Buffer.from([1, 2, 3, 4]).subarray(1, 3)] }),
)
await show('u8sub', () =>
  c.execute({ sql: 'select hex(?)', args: [new Uint8Array([1, 2, 3, 4]).subarray(1, 3)] }),
)
await show('named dup', () => c.execute({ sql: 'select :a, @a, $a', args: { a: 1, '@a': 2 } }))
await show('named undefined', () => c.execute({ sql: 'select :a', args: { a: undefined } }))
await show('named extra', () => c.execute({ sql: 'select :a', args: { a: 1, b: 2 } }))
await show('bind err + syntax', () => c.execute({ sql: 'selec ?', args: [{}] }))
await show('bind err run', () => c.execute({ sql: 'create table if not exists q (a); ', args: [] }))
await show('bind err run2', () => c.execute({ sql: 'insert into q values (?)', args: [{}] }))
await show('undef + syntax', () => c.execute({ sql: 'selec ?', args: [undefined] }))
await show('bool string', () => c.execute({ sql: 'select ?', args: [new String('x')] }))
await show('num obj', () => c.execute({ sql: 'select ?', args: [new Number(1)] }))
await show('negzero big', () =>
  c.execute({ sql: 'select ?, ?', args: [-9223372036854775808n, 9223372036854775807n] }),
)
await show('real round', () =>
  c.execute({ sql: 'select ?, ?, ?', args: [0.1, 1e-320, 123456789.123456789] }),
)
await show('int as real str', () =>
  c.execute({ sql: 'select cast(? as text), cast(? as text)', args: [1, 1e21] }),
)
const b = await c.execute(`select x'0102'`)
console.log(
  'ab detail',
  b.rows[0][0].byteLength,
  b.rows[0][0].constructor.name,
  Object.prototype.toString.call(b.rows[0][0]),
  b.rows[0][0].resizable,
)
await show('bt', () => c.execute('PRAGMA busy_timeout = 100'))
await show('wal mem', () => c.execute('PRAGMA journal_mode = WAL'))
