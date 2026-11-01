import { createClient } from '@libsql/client'
const c = createClient({ url: ':memory:' })
for (const s of [
  'select ceil(1e400) is 9223372036854775807, floor(-1e400) = -9223372036854775808, typeof(ceil(1e300))',
  'select typeof(ceil(null)), ceil(null)',
  "select ceil(2), typeof(ceil(2)), ceil('2.5'), typeof(sqrt(null)), sqrt(-1), typeof(sqrt(-1))",
  'select trunc(2.5)',
  "select name, narg, flags from pragma_function_list where name in ('ceil','floor','ln','log','log10','exp','pow','power','mod','atan2','sqrt','pi','acos','radians','degrees','ceiling','sign','sin','trunc','log2') order by name, narg",
  'select ceil(9007199254740993.0), floor(-0.5), typeof(floor(-0.5)), ceil(-0.5)',
  "select pow(2, null), typeof(pow(null,null)), mod(5, 0), typeof(mod(5,0)), atan2('x', 1)",
]) {
  try {
    const r = await c.execute(s)
    console.log(s, JSON.stringify(r.rows.map((x) => Array.from(x))))
  } catch (e) {
    console.log(s, 'ERR', e.message)
  }
}
