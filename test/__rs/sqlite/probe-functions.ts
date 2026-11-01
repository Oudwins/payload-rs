// Lists SQL functions that differ between libsql and the Rust runtime.
import { createClient as L } from '@libsql/client'

import { createClient as R } from '../../../packages/engine-rs/src/sqlite/index.js'
const q = `select name, narg, flags, builtin, type, enc from pragma_function_list order by name, narg, flags`
const list = async (c: any) => new Set((await c.execute(q)).rows.map((r: any) => Array.from(r).join('|')))
const a = await list(L({ url: ':memory:' })), b = await list(R({ url: ':memory:' }))
console.log('only libsql:', [...a].filter((x) => !b.has(x)).join('  '))
console.log('only rs:', [...b].filter((x) => !a.has(x)).join('  '))
const l = L({ url: ':memory:' })
for (const s of ['select sign(2.5), typeof(sign(2.5)), sign(-3), typeof(sign(-3)), sign(null), sign(\'x\'), typeof(sign(\'x\'))', 'select sqlite_compileoption_used(\'ENABLE_MATH_FUNCTIONS\')']) {console.log(s, JSON.stringify(Array.from((await l.execute(s)).rows[0] as any)))}
