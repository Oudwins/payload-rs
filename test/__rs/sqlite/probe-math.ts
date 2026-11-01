import { createClient as L } from '@libsql/client'

import { createClient as R } from '../../../packages/engine-rs/src/sqlite/index.js'
const inputs = ['2', '2.5', '-2.5', '0', '-1', 'null', `'abc'`, `'4'`, '9007199254740993', `x'01'`, '1e400', '-0.0', '1', '0.5']
const fns1 = ['ceil', 'ceiling', 'floor', 'trunc', 'ln', 'log', 'log10', 'log2', 'exp', 'acos', 'asin', 'atan', 'cos', 'sin', 'tan', 'cosh', 'sinh', 'tanh', 'acosh', 'asinh', 'atanh', 'sqrt', 'radians', 'degrees', 'sign', 'abs', 'cot', 'coth', 'square', 'log2', 'trunc']
const fns2 = ['pow', 'power', 'mod', 'atan2', 'atn2', 'log']
const pairs = [['2', '3'], ['2.5', '-1'], ['0', '0'], ['null', '1'], ['1', `'x'`], [`'x'`, '2'], ['-8', '1.0/3'], ['10', '100'], ['2', '0'], ['-2', '8'], ['1', '8'], ['0.5', '8']]
const l = L({ url: ':memory:' }); const r = R({ url: ':memory:' })
const run = async (c: any, sql: string) => { try { const x = await c.execute(sql); return JSON.stringify(Array.from(x.rows[0] as any, (v: any) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)) } catch (e: any) { return 'ERR ' + e.message } }
for (const f of fns1) {for (const i of inputs) { const sql = `select ${f}(${i}), typeof(${f}(${i}))`; const a = await run(l, sql), b = await run(r, sql); if (a !== b) console.log(sql, 'libsql', a, 'rs', b) }}
for (const f of fns2) {for (const [x, y] of pairs) { const sql = `select ${f}(${x}, ${y}), typeof(${f}(${x}, ${y}))`; const a = await run(l, sql), b = await run(r, sql); if (a !== b) console.log(sql, 'libsql', a, 'rs', b) }}
console.log('pi', await run(l, 'select pi()'), await run(r, 'select pi()'))
