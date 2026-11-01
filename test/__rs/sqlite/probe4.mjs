import { createClient } from '@libsql/client'
const c = createClient({ url: ':memory:' })
const r = await c.execute('PRAGMA compile_options')
console.log(r.rows.map((x) => x[0]).join('\n'))
for (const p of [
  'foreign_keys',
  'cache_size',
  'page_size',
  'synchronous',
  'temp_store',
  'secure_delete',
  'auto_vacuum',
  'legacy_alter_table',
  'trusted_schema',
  'case_sensitive_like',
  'automatic_index',
  'recursive_triggers',
  'cell_size_check',
  'query_only',
  'reverse_unordered_selects',
  'defer_foreign_keys',
  'ignore_check_constraints',
  'busy_timeout',
  'encoding',
  'locking_mode',
  'mmap_size',
  'threads',
  'hard_heap_limit',
  'soft_heap_limit',
  'wal_autocheckpoint',
  'journal_size_limit',
  'max_page_count',
  'analysis_limit',
  'automatic_index',
  'full_fsync',
  'checkpoint_fullfsync',
]) {
  try {
    const x = await c.execute(`PRAGMA ${p}`)
    console.log(p, JSON.stringify(x.rows))
  } catch (e) {
    console.log(p, 'ERR', e.message)
  }
}
for (const s of [
  `create table x (a default "abc")`,
  `select "nope"`,
  `create index i on x("zz")`,
]) {
  try {
    await c.execute(s)
    console.log(s, 'ok')
  } catch (e) {
    console.log(s, 'ERR', e.message)
  }
}
