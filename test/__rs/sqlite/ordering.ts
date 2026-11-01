/**
 * Cross-connection ordering scenarios. `@libsql/client` runs every call
 * synchronously on the JS thread, so work on a client connection, its
 * transaction connections and other clients of the same file never overlaps
 * and takes effect in call order. These scenarios issue calls without awaiting
 * them in between and record every outcome; the Rust runtime must produce the
 * same log.
 *
 * `query(target, sql)` is "engine SQL" on the connection of a client or
 * transaction: through the target's `execute` for libsql (what the TS engine
 * does via drizzle) and through `sqliteEngineQuery` (plain rusqlite on the
 * same Rust queue) for the Rust runtime.
 */
import type { AnyClient, CreateClient, Log } from './scenarios.js'

import { describeValue } from './describe.js'

export type EngineQuery = (target: AnyClient, sql: string) => Promise<Array<null | string>>

export type OrderingScenario = {
  name: string
  run: (ctx: {
    createClient: CreateClient
    log: Log
    query: EngineQuery
    url: string
  }) => Promise<void>
}

/** Records the settled outcome of every promise, in the order given. */
const settle = async (log: Log, label: string, entries: Array<[string, Promise<unknown>]>) => {
  const results = await Promise.allSettled(entries.map(([, p]) => p))
  log.push([
    label,
    results.map((r, i) => [
      entries[i]![0],
      r.status,
      describeValue(r.status === 'fulfilled' ? r.value : r.reason),
    ]),
  ])
}

/**
 * A statement that fails with `SQLITE_BUSY` on a separate client that is
 * closed right away. libsql never resets such a statement (only GC finalizes
 * it), which leaves its connection inside a half-open write; reusing that
 * connection depends on GC timing, so busy probes never touch shared clients.
 */
const busyProbe = (createClient: CreateClient, url: string, sql: string) => {
  const probe = createClient({ url })
  const result = probe.execute(sql)
  probe.close()
  return result
}

const seed = async (c: AnyClient, rows: number) => {
  await c.execute('create table u (a)')
  await c.execute('create table big (x)')
  await c.execute(
    `with recursive s(x) as (select 1 union all select x + 1 from s where x < ${rows}) insert into big select x from s`,
  )
}

export const orderingScenarios: OrderingScenario[] = [
  {
    name: 'unawaited commit then read on the client',
    run: async ({ createClient, log, url }) => {
      const c = createClient({ url })
      await seed(c, 1000)
      const tx = await c.transaction('write')
      await tx.execute('insert into u values (1)')
      await settle(log, 'commit, read', [
        ['commit', tx.commit()],
        ['read', c.execute('select count(*) n from u')],
      ])
      c.close()
    },
  },
  {
    name: 'client read racing a commit',
    run: async ({ createClient, log, url }) => {
      const c = createClient({ url })
      await seed(c, 50000)
      for (let i = 0; i < 10; i++) {
        const tx = await c.transaction('write')
        await tx.execute('insert into u values (2)')
        await settle(log, `round ${i}`, [
          ['read', c.execute('select sum(x) s, (select count(*) from u) n from big')],
          ['commit', tx.commit()],
          ['after', c.execute('select count(*) n from u')],
        ])
      }
      c.close()
    },
  },
  {
    name: 'interleaved transaction and client calls',
    run: async ({ createClient, log, url }) => {
      const c = createClient({ url })
      await seed(c, 10)
      const tx = await c.transaction('write')
      await settle(log, 'interleaved', [
        ['tx insert', tx.execute('insert into u values (1)')],
        ['client read (uncommitted)', c.execute('select count(*) n from u')],
        ['other client write (busy)', busyProbe(createClient, url, 'insert into u values (9)')],
        ['tx read', tx.execute('select count(*) n from u')],
        ['commit', tx.commit()],
        ['client read', c.execute('select count(*) n from u')],
        ['client write', c.execute('insert into u values (3)')],
        ['tx after commit', tx.execute('select 1')],
        ['closed', Promise.resolve().then(() => tx.closed)],
      ])
      const tx2 = await c.transaction('deferred')
      await settle(log, 'rollback interleaved', [
        ['tx2 insert', tx2.execute('insert into u values (4)')],
        ['rollback', tx2.rollback()],
        ['client read', c.execute('select count(*) n from u')],
        [
          'client batch',
          c.batch(['insert into u values (5)', 'select count(*) n from u'], 'write'),
        ],
      ])
      c.close()
    },
  },
  {
    name: 'unawaited transaction() followed by client calls',
    run: async ({ createClient, log, url }) => {
      const c = createClient({ url })
      await seed(c, 10)
      const pt = c.transaction('write')
      const pr = c.execute('select count(*) n from u')
      const pw = busyProbe(createClient, url, 'insert into u values (1)')
      await settle(log, 'begin then client', [
        ['transaction', pt],
        ['read', pr],
        ['other client write (busy)', pw],
      ])
      const tx = await pt
      await settle(log, 'end', [
        ['tx insert', tx.execute('insert into u values (2)')],
        ['commit', tx.commit()],
        ['read', c.execute('select a from u order by a')],
      ])
      // Two transactions requested back to back: the second BEGIN IMMEDIATE
      // runs on the client's fresh connection while the first holds the lock.
      await settle(log, 'two transactions', [
        ['tx a', c.transaction('write')],
        ['tx b', c.transaction('write')],
      ])
      c.close()
    },
  },
  {
    name: 'two clients on one file',
    run: async ({ createClient, log, url }) => {
      const a = createClient({ url })
      await seed(a, 10)
      const b = createClient({ url })
      const tx = await a.transaction('write')
      await settle(log, 'locked', [
        ['tx insert', tx.execute('insert into u values (1)')],
        ['other client write (busy)', busyProbe(createClient, url, 'insert into u values (2)')],
        ['b read', b.execute('select count(*) n from u')],
        ['commit', tx.commit()],
        ['b write', b.execute('insert into u values (3)')],
        ['a read', a.execute('select a from u order by a')],
      ])
      const tb = await b.transaction('write')
      await settle(log, 'other client tx', [
        ['tb insert', tb.execute('insert into u values (4)')],
        ['a read', a.execute('select count(*) n from u')],
        ['tb commit', tb.commit()],
        ['a migrate', a.migrate(['insert into u values (6)'])],
        ['b read', b.execute('select a from u order by a')],
      ])
      a.close()
      b.close()
    },
  },
  {
    name: 'client close with pending work',
    run: async ({ createClient, log, url }) => {
      const c = createClient({ url })
      await seed(c, 10)
      const tx = await c.transaction('write')
      const pending: Array<[string, Promise<unknown>]> = [
        ['tx insert', tx.execute('insert into u values (1)')],
        ['client read', c.execute('select count(*) n from u')],
      ]
      c.close()
      pending.push(['tx commit', tx.commit()])
      pending.push(['tx after client close', c.transaction('write')])
      await settle(log, 'close', pending)
      const c2 = createClient({ url })
      await settle(log, 'reopen', [['read', c2.execute('select count(*) n from u')]])
      c2.close()
    },
  },
  {
    name: 'WAL: read racing a commit',
    run: async ({ createClient, log, url }) => {
      const c = createClient({ url })
      await settle(log, 'wal', [['wal', c.execute('PRAGMA journal_mode = WAL')]])
      await seed(c, 20000)
      for (let i = 0; i < 5; i++) {
        const tx = await c.transaction('write')
        await settle(log, `round ${i}`, [
          ['tx insert', tx.execute('insert into u values (1)')],
          ['read', c.execute('select count(*) n from u')],
          ['commit', tx.commit()],
          ['after', c.execute('select count(*) n from u')],
        ])
      }
      c.close()
    },
  },
  {
    name: 'engine SQL on the client and transaction queues',
    run: async ({ createClient, log, query, url }) => {
      const c = createClient({ url })
      await seed(c, 10)
      const tx = await c.transaction('write')
      await settle(log, 'engine in transaction', [
        ['tx insert', tx.execute('insert into u values (1)')],
        ['engine on tx', query(tx, 'select count(*) from u')],
        ['engine on client', query(c, 'select count(*) from u')],
        ['tx insert 2', tx.execute('insert into u values (2)')],
        ['engine on tx 2', query(tx, 'select a from u order by a')],
        ['commit', tx.commit()],
        ['engine on client after', query(c, 'select a from u order by a')],
      ])
      await settle(log, 'engine writes', [
        ['engine insert', query(c, 'insert into u values (7) returning a')],
        ['client read', c.execute('select a from u order by a')],
      ])
      c.close()
    },
  },
]
