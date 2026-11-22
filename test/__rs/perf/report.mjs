/**
 * Outputs of the performance suite, all from `results.json`:
 *
 * - `scenarios.csv`  one row per database x shape x size x engine x scenario: every latency
 *                    statistic (min, p25, median, p75, p90, p95, p99, max, mean, stddev, cv, n),
 *                    CPU per iteration, GC count / ms, heap delta, result bytes and documents, and
 *                    for ts / rs pairs the speedup (TS median / Rust median)
 * - `samples.csv`    one row per timed iteration (wall ms and CPU ms), for any external tool
 * - `startup.csv`    one row per fresh startup process (import, buildConfig, getPayload, total)
 * - `seed.csv`       seeding throughput per cell
 * - `report.md`      summaries (by database x surface and database x category) and every table
 * - `report.html`    an interactive report (filters, speedups, latency distributions, scaling with
 *                    the collection size, CPU / GC, startup, a sortable table), rendered in the
 *                    browser from the data embedded in the page
 *
 * Works for one engine as well (`--engines ts` or `rs`): speedups are then absent.
 */
import fs from 'node:fs'
import path from 'node:path'

export const writeReports = ({ outDir, results }) => {
  const model = buildModel(results)
  fs.writeFileSync(path.join(outDir, 'scenarios.csv'), scenariosCsv(model))
  fs.writeFileSync(path.join(outDir, 'samples.csv'), samplesCsv(results))
  fs.writeFileSync(path.join(outDir, 'startup.csv'), startupCsv(results))
  fs.writeFileSync(path.join(outDir, 'seed.csv'), seedCsv(results))
  fs.writeFileSync(path.join(outDir, 'report.md'), markdown({ model, results }))
  fs.writeFileSync(path.join(outDir, 'report.html'), html({ model, results }))
}

const QUANTILES = Array.from({ length: 21 }, (_, index) => index / 20)

const geomean = (values) => {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0)
  return finite.length
    ? Math.exp(finite.reduce((sum, value) => sum + Math.log(value), 0) / finite.length)
    : NaN
}
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN
}
const quantilesOf = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return QUANTILES.map((q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] : NaN,
  )
}
const ms = (value) =>
  Number.isFinite(value)
    ? value >= 100
      ? value.toFixed(0)
      : value >= 10
        ? value.toFixed(1)
        : value.toFixed(3)
    : '-'
const times = (value) => (Number.isFinite(value) ? `${value.toFixed(2)}×` : '-')

/** Rows (one per cell x scenario), ts / rs pairs, summaries, startup. */
function buildModel(results) {
  const rows = []
  for (const cell of results.cells.filter((entry) => entry.kind === 'scenarios')) {
    for (const scenario of cell.scenarios) {
      rows.push({
        bytes: scenario.result?.bytes,
        category: scenario.category ?? 'uncategorized',
        cpu: scenario.cpu,
        database: cell.database,
        docs: scenario.result?.docs,
        engine: cell.engine,
        error: scenario.error?.message,
        gc: scenario.gc,
        heapDeltaBytes: scenario.heapDeltaBytes,
        name: scenario.name,
        quantiles: scenario.samples ? quantilesOf(scenario.samples) : undefined,
        shape: cell.shape,
        size: cell.size,
        stats: scenario.stats,
        surface: scenario.surface,
      })
    }
  }
  const keyOf = (row) => [row.database, row.shape, row.size, row.surface, row.name].join('|')
  const pairs = new Map()
  for (const row of rows) {
    const pair = pairs.get(keyOf(row)) ?? { ...row, engines: {} }
    pair.engines[row.engine] = row
    pairs.set(keyOf(row), pair)
  }
  for (const pair of pairs.values()) {
    const { rs, ts } = pair.engines
    pair.speedup = ts && rs && rs.stats.medianMs > 0 ? ts.stats.medianMs / rs.stats.medianMs : NaN
  }
  const summarize = (field) => {
    const groups = new Map()
    for (const pair of pairs.values()) {
      const key = `${pair.database}|${pair[field]}`
      groups.set(key, [...(groups.get(key) ?? []), pair])
    }
    return [...groups].map(([key, members]) => {
      const [database, value] = key.split('|')
      const speedups = members.map((member) => member.speedup).filter(Number.isFinite)
      return {
        database,
        faster: speedups.filter((value) => value > 1.05).length,
        geomean: geomean(speedups),
        group: value,
        max: speedups.length ? Math.max(...speedups) : NaN,
        min: speedups.length ? Math.min(...speedups) : NaN,
        scenarios: members.length,
        slower: speedups.filter((value) => value < 0.95).length,
      }
    })
  }
  const startup = []
  for (const cell of results.cells.filter((entry) => entry.kind === 'startup')) {
    const phase = (name) => median(cell.runs.map((run) => run[name]))
    startup.push({
      buildConfigMs: phase('buildConfigMs'),
      database: cell.database,
      engine: cell.engine,
      getPayloadMs: phase('getPayloadMs'),
      importMs: phase('importMs'),
      runs: cell.runs.length,
      shape: cell.shape,
      totalMs: phase('totalMs'),
    })
  }
  const engines = [
    ...new Set(rows.map((row) => row.engine).concat(startup.map((row) => row.engine))),
  ]
  return {
    byCategory: summarize('category'),
    bySurface: summarize('surface'),
    engines,
    isPaired: engines.includes('ts') && engines.includes('rs'),
    pairs: [...pairs.values()],
    rows,
    startup,
  }
}

const csv = (header, rows) =>
  [header, ...rows]
    .map((row) =>
      row
        .map((value) => {
          const text =
            value === undefined || value === null || Number.isNaN(value) ? '' : String(value)
          return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
        })
        .join(','),
    )
    .join('\n') + '\n'

function scenariosCsv(model) {
  const statKeys = [
    'minMs',
    'p25Ms',
    'medianMs',
    'p75Ms',
    'p90Ms',
    'p95Ms',
    'p99Ms',
    'maxMs',
    'meanMs',
    'stddevMs',
    'cv',
    'n',
  ]
  const speedupOf = new Map(
    model.pairs.map((pair) => [
      [pair.database, pair.shape, pair.size, pair.surface, pair.name].join('|'),
      pair.speedup,
    ]),
  )
  return csv(
    [
      'database',
      'shape',
      'size',
      'engine',
      'surface',
      'category',
      'scenario',
      ...statKeys,
      'cpuMedianMs',
      'cpuMeanMs',
      'gcCount',
      'gcMs',
      'heapDeltaBytes',
      'resultBytes',
      'resultDocs',
      'speedupTsOverRs',
      'error',
    ],
    model.rows.map((row) => [
      row.database,
      row.shape,
      row.size,
      row.engine,
      row.surface,
      row.category,
      row.name,
      ...statKeys.map((key) => row.stats?.[key]),
      row.cpu?.medianMs,
      row.cpu?.meanMs,
      row.gc?.count,
      row.gc?.ms,
      row.heapDeltaBytes,
      row.bytes,
      row.docs,
      speedupOf.get([row.database, row.shape, row.size, row.surface, row.name].join('|')),
      row.error,
    ]),
  )
}

function samplesCsv(results) {
  const rows = []
  for (const cell of results.cells.filter((entry) => entry.kind === 'scenarios')) {
    for (const scenario of cell.scenarios) {
      ;(scenario.samples ?? []).forEach((value, index) => {
        rows.push([
          cell.database,
          cell.shape,
          cell.size,
          cell.engine,
          scenario.surface,
          scenario.category,
          scenario.name,
          index,
          value,
          scenario.cpuSamples?.[index],
        ])
      })
    }
  }
  return csv(
    [
      'database',
      'shape',
      'size',
      'engine',
      'surface',
      'category',
      'scenario',
      'iteration',
      'wallMs',
      'cpuMs',
    ],
    rows,
  )
}

function startupCsv(results) {
  const rows = []
  for (const cell of results.cells.filter((entry) => entry.kind === 'startup')) {
    cell.runs.forEach((run, index) => {
      rows.push([
        cell.database,
        cell.shape,
        cell.engine,
        index,
        run.importMs,
        run.buildConfigMs,
        run.getPayloadMs,
        run.totalMs,
      ])
    })
  }
  return csv(
    ['database', 'shape', 'engine', 'run', 'importMs', 'buildConfigMs', 'getPayloadMs', 'totalMs'],
    rows,
  )
}

function seedCsv(results) {
  return csv(
    ['database', 'shape', 'size', 'engine', 'postsCreateMs', 'postsPerSecond', 'totalMs'],
    results.cells
      .filter((cell) => cell.kind === 'scenarios' && cell.seed)
      .map((cell) => [
        cell.database,
        cell.shape,
        cell.size,
        cell.engine,
        cell.seed.postsCreateMs,
        cell.seed.postsPerSecond,
        cell.seed.totalMs,
      ]),
  )
}

function markdown({ model, results }) {
  const environment = results.cells.find((cell) => cell.environment)?.environment ?? {}
  const { options } = results
  let md = `# Payload performance: Rust engine vs upstream TypeScript\n\n`
  md += `${results.createdAt}; ${environment.platform ?? ''}, ${environment.cpu ?? ''} (${environment.cpus ?? '?'} cpus), Node ${environment.node ?? ''}; engines ${model.engines.join(', ')}.\n\n`
  md += `Both engines run the packed dist builds (NODE_ENV=production), one fresh process and database per cell, cells one at a time. Per scenario: ${options.warmup} warmup runs, then at least ${options.minIterations} iterations and ${options.minTimeMs} ms (at most ${options.maxIterations} / ${options.maxTimeMs} ms). Speedup = TS median / Rust median (> 1: Rust faster). Raw data: results.json, scenarios.csv, samples.csv, startup.csv, seed.csv; interactive: report.html.\n\n`
  if (results.failures.length > 0) {
    md += `## Failures\n\n${results.failures.map((failure) => `- ${failure}`).join('\n')}\n\n`
  }
  if (model.isPaired) {
    const summaryTable = (title, rows, label) => {
      let table = `## ${title}\n\n| database | ${label} | scenario results | geomean speedup | min | max | Rust faster (>1.05×) | Rust slower (<0.95×) |\n|---|---|---|---|---|---|---|---|\n`
      for (const row of rows) {
        table += `| ${row.database} | ${row.group} | ${row.scenarios} | ${times(row.geomean)} | ${times(row.min)} | ${times(row.max)} | ${row.faster} | ${row.slower} |\n`
      }
      return `${table}\n`
    }
    md += summaryTable('Summary by surface', model.bySurface, 'surface')
    md += summaryTable('Summary by category', model.byCategory, 'category')
  }
  if (model.startup.length > 0) {
    md += `## Startup (median of fresh processes, ms)\n\n| database | shape | engine | runs | import | buildConfig | getPayload | total |\n|---|---|---|---|---|---|---|---|\n`
    for (const row of model.startup) {
      md += `| ${row.database} | ${row.shape} | ${row.engine} | ${row.runs} | ${ms(row.importMs)} | ${ms(row.buildConfigMs)} | ${ms(row.getPayloadMs)} | ${ms(row.totalMs)} |\n`
    }
    md += '\n'
  }
  const cells = new Map()
  for (const pair of model.pairs) {
    const key = `${pair.database} / ${pair.shape} / ${pair.size} posts`
    cells.set(key, [...(cells.get(key) ?? []), pair])
  }
  for (const [title, pairs] of cells) {
    const engines = model.engines
    md += `## ${title}\n\n| surface | category | scenario | ${engines.map((engine) => `${engine} p50 / p95 / p99 ms`).join(' | ')} | ${engines.map((engine) => `${engine} cpu ms`).join(' | ')} | docs | bytes | speedup |\n|---|---|---|${engines.map(() => '---|').join('')}${engines.map(() => '---|').join('')}---|---|---|\n`
    for (const pair of pairs) {
      const cell = (engine) => {
        const row = pair.engines[engine]
        return row
          ? row.error
            ? `error: ${row.error.slice(0, 60)}`
            : `${ms(row.stats.medianMs)} / ${ms(row.stats.p95Ms)} / ${ms(row.stats.p99Ms)}`
          : '-'
      }
      md += `| ${pair.surface} | ${pair.category} | ${pair.name} | ${engines.map(cell).join(' | ')} | ${engines.map((engine) => ms(pair.engines[engine]?.cpu?.medianMs)).join(' | ')} | ${pair.docs ?? '-'} | ${pair.bytes ?? '-'} | ${times(pair.speedup)} |\n`
    }
    md += '\n'
  }
  return md
}

/** Compact data for the page: one entry per pair with per-engine statistics and quantiles. */
function pageData({ model, results }) {
  const round = (value) => (Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null)
  const stat = (row) =>
    row && {
      bytes: row.bytes,
      cpu: round(row.cpu?.medianMs),
      docs: row.docs,
      error: row.error,
      gcCount: row.gc?.count,
      gcMs: round(row.gc?.ms),
      heap: row.heapDeltaBytes,
      max: round(row.stats.maxMs),
      mean: round(row.stats.meanMs),
      median: round(row.stats.medianMs),
      min: round(row.stats.minMs),
      n: row.stats.n,
      p25: round(row.stats.p25Ms),
      p75: round(row.stats.p75Ms),
      p90: round(row.stats.p90Ms),
      p95: round(row.stats.p95Ms),
      p99: round(row.stats.p99Ms),
      q: row.quantiles?.map(round),
      sd: round(row.stats.stddevMs),
    }
  return {
    createdAt: results.createdAt,
    engines: model.engines,
    environment: results.cells.find((cell) => cell.environment)?.environment ?? {},
    failures: results.failures,
    options: results.options,
    pairs: model.pairs.map((pair) => ({
      category: pair.category,
      database: pair.database,
      engines: Object.fromEntries(
        Object.entries(pair.engines).map(([engine, row]) => [engine, stat(row)]),
      ),
      name: pair.name,
      shape: pair.shape,
      size: pair.size,
      surface: pair.surface,
    })),
    startup: results.cells
      .filter((cell) => cell.kind === 'startup')
      .map((cell) => ({
        database: cell.database,
        engine: cell.engine,
        runs: cell.runs,
        shape: cell.shape,
      })),
  }
}

function html({ model, results }) {
  // `<` escaped so the data can never close the script element
  const data = JSON.stringify(pageData({ model, results })).replaceAll('<', '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payload performance: Rust vs TypeScript</title>
<style>${CSS}</style></head><body>
<header><h1>Payload performance: Rust engine vs upstream TypeScript</h1><p id="meta"></p></header>
<div id="failures"></div>
<nav id="filters" aria-label="Filters"></nav>
<section><h2>Summary</h2><p class="hint">Geometric mean of TS median ÷ Rust median over the filtered scenarios (log scale; &gt; 1 means Rust is faster).</p><div id="summary"></div></section>
<section><h2>Speedup per scenario</h2><p class="hint">Sorted; hover or focus a row for both engines' p50 / p95 / p99, CPU, GC and result size.</p><div id="speedups"></div></section>
<section><h2>Latency distribution</h2><p class="hint">Per scenario and engine: whiskers p5–p95, box p25–p75, tick = median (log scale, ms).</p><div id="distributions"></div></section>
<section><h2>Scaling with collection size</h2><p class="hint">Median (line) and p25–p75 (band) per engine across collection sizes, for the chosen scenario.</p><div id="scaling-controls"></div><div id="scaling"></div></section>
<section><h2>CPU and garbage collection</h2><p class="hint">CPU ms per iteration (user + system) and GC ms per 100 iterations, per engine.</p><div id="cpu"></div></section>
<section><h2>Startup</h2><p class="hint">Fresh processes: import, buildConfig and getPayload (median of runs), per engine.</p><div id="startup"></div></section>
<section><h2>Table</h2><p class="hint">Every statistic of the filtered rows; click a header to sort.</p><div id="table" class="scroll"></div></section>
<div id="tooltip" role="status" hidden></div>
<script>const DATA = ${data};</script>
<script>${SCRIPT}</script>
</body></html>`
}

const CSS = `
:root { --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#7a7974; --grid:#e4e3df; --mid:#9a9994;
  --ts:#eb6834; --rs:#2a78d6; --faster:#2a78d6; --slower:#e34948; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --surface:#1a1a19; --page:#0d0d0d; --ink:#f0efec; --ink-2:#c3c2b7; --ink-3:#8f8e88;
  --grid:#2e2e2c; --mid:#6b6a65; --ts:#d95926; --rs:#3987e5; --faster:#3987e5; --slower:#e66767; color-scheme: dark; } }
* { box-sizing: border-box; }
body { background:var(--page); color:var(--ink); font:14px/1.45 system-ui, -apple-system, sans-serif; margin:0; padding:24px; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 4px; }
header p, .hint { color:var(--ink-2); margin:0 0 12px; }
section { background:var(--surface); border-radius:5px; padding:16px; margin:0 0 16px; }
nav { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; margin:0 0 16px; position:sticky; top:0; z-index:2;
  background:var(--page); padding:8px 0; }
nav label { display:flex; flex-direction:column; gap:2px; font-size:12px; color:var(--ink-2); }
select, input { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--grid); border-radius:5px; padding:4px 6px; }
.legend { display:flex; flex-wrap:wrap; gap:16px; color:var(--ink-2); font-size:13px; margin:0 0 8px; }
.legend i { display:inline-block; width:12px; height:12px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
svg { display:block; max-width:100%; } svg text { fill:var(--ink-2); font-size:12px; } svg .label { fill:var(--ink); }
svg .tick { font-size:11px; fill:var(--ink-3); } .grid { stroke:var(--grid); } .mid { stroke:var(--mid); stroke-width:2; }
.hit { fill:transparent; } .row:hover .hit, .row:focus .hit { fill:var(--grid); opacity:.6; } .row:focus { outline:none; }
#tooltip { position:fixed; pointer-events:none; background:var(--surface); color:var(--ink); border:1px solid var(--grid);
  border-radius:5px; padding:8px 10px; font-size:12px; box-shadow:0 4px 16px rgba(0,0,0,.18); max-width:420px; z-index:10; }
#tooltip strong { font-size:13px; } #tooltip .line { display:inline-block; width:12px; height:2px; vertical-align:middle; margin-right:6px; }
table { border-collapse:collapse; font-size:12px; } th, td { padding:3px 8px; text-align:right; border-bottom:1px solid var(--grid); white-space:nowrap; }
th { color:var(--ink-2); font-weight:600; cursor:pointer; position:sticky; top:0; background:var(--surface); } td.t, th.t { text-align:left; }
.scroll { overflow:auto; max-height:640px; } .failures { border-left:4px solid var(--slower); padding-left:12px; }
.empty { color:var(--ink-3); }
`

const SCRIPT = `
(() => {
  const SVG = 'http://www.w3.org/2000/svg'
  const el = (tag, attrs = {}, text) => { const node = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); if (text !== undefined) node.textContent = text; return node }
  const svgEl = (tag, attrs = {}, text) => { const node = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); if (text !== undefined) node.textContent = text; return node }
  const fmt = (v) => v == null || !isFinite(v) ? '-' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3)
  const times = (v) => v == null || !isFinite(v) ? '-' : v.toFixed(2) + '×'
  const geomean = (vs) => { const f = vs.filter((v) => isFinite(v) && v > 0); return f.length ? Math.exp(f.reduce((s, v) => s + Math.log(v), 0) / f.length) : NaN }
  const ENGINE_COLOR = { ts: 'var(--ts)', rs: 'var(--rs)', 'db-rs': 'var(--rs)', 'core-rs': 'var(--rs)' }
  const ENGINE_NAME = { ts: 'TypeScript', rs: 'Rust', 'db-rs': 'Rust db engine only', 'core-rs': 'Rust core only' }
  const engines = DATA.engines
  const isPaired = engines.includes('ts') && engines.includes('rs')
  const speedupOf = (p) => isPaired && p.engines.ts && p.engines.rs && p.engines.rs.median > 0 ? p.engines.ts.median / p.engines.rs.median : NaN

  // ---- header ---------------------------------------------------------------------------
  const env = DATA.environment
  document.getElementById('meta').textContent = DATA.createdAt + ' · ' + (env.platform || '') + ' · ' + (env.cpu || '') + ' (' + (env.cpus || '?') + ' cpus) · Node ' + (env.node || '') + ' · engines: ' + engines.map((e) => ENGINE_NAME[e] || e).join(', ') + ' · ' + DATA.pairs.length + ' scenario cells'
  if (DATA.failures.length) {
    const box = el('section', { class: 'failures' }); box.append(el('strong', {}, DATA.failures.length + ' failure(s)'))
    const list = el('ul'); for (const f of DATA.failures.slice(0, 50)) list.append(el('li', {}, f)); box.append(list)
    document.getElementById('failures').append(box)
  }

  // ---- tooltip --------------------------------------------------------------------------
  const tip = document.getElementById('tooltip')
  const showTip = (event, build) => { tip.replaceChildren(); build(tip); tip.hidden = false; const r = (event.target.getBoundingClientRect ? event.target.getBoundingClientRect() : { left: 0, top: 0 }); const x = event.clientX ?? r.left + 20, y = event.clientY ?? r.top; tip.style.left = Math.min(window.innerWidth - 440, x + 14) + 'px'; tip.style.top = Math.min(window.innerHeight - tip.offsetHeight - 8, y + 14) + 'px' }
  const hideTip = () => { tip.hidden = true }
  const pairTip = (p) => (node) => {
    node.append(el('div', {}, p.surface + ' · ' + p.category), el('strong', {}, p.name), el('div', {}, p.database + ' / ' + p.shape + ' / ' + p.size + ' posts'))
    const s = speedupOf(p); if (isFinite(s)) node.append(el('div', {}, 'speedup ' + times(s)))
    for (const e of engines) { const r = p.engines[e]; if (!r) continue
      const line = el('div'); const key = el('span', { class: 'line' }); key.style.background = ENGINE_COLOR[e]; line.append(key)
      line.append(document.createTextNode((ENGINE_NAME[e] || e) + ': ' + (r.error ? 'error ' + r.error : 'p50 ' + fmt(r.median) + ' · p95 ' + fmt(r.p95) + ' · p99 ' + fmt(r.p99) + ' ms · cpu ' + fmt(r.cpu) + ' ms · gc ' + (r.gcCount ?? 0) + ' (' + fmt(r.gcMs) + ' ms) · n ' + r.n)))
      node.append(line) }
    const any = p.engines.ts || p.engines.rs || Object.values(p.engines)[0]
    if (any) node.append(el('div', {}, 'result: ' + (any.docs ?? '-') + ' docs, ' + (any.bytes ?? '-') + ' bytes'))
  }
  const hover = (target, build) => { target.setAttribute('tabindex', '0'); target.addEventListener('pointermove', (ev) => showTip(ev, build)); target.addEventListener('pointerleave', hideTip); target.addEventListener('focus', (ev) => showTip({ target: ev.target, clientX: ev.target.getBoundingClientRect().right - 200, clientY: ev.target.getBoundingClientRect().top }, build)); target.addEventListener('blur', hideTip) }

  // ---- filters --------------------------------------------------------------------------
  const unique = (key) => [...new Set(DATA.pairs.map((p) => p[key]))]
  const filters = { database: 'all', shape: 'all', size: 'all', surface: 'all', category: 'all', search: '' }
  const nav = document.getElementById('filters')
  for (const [key, label] of [['database', 'Database'], ['shape', 'Config shape'], ['size', 'Collection size'], ['surface', 'Surface'], ['category', 'Category']]) {
    const wrap = el('label', {}, label); const select = el('select', { 'aria-label': label }); select.append(el('option', { value: 'all' }, 'all'))
    for (const v of unique(key)) select.append(el('option', { value: String(v) }, String(v)))
    select.addEventListener('change', () => { filters[key] = select.value; render() }); wrap.append(select); nav.append(wrap)
  }
  const searchWrap = el('label', {}, 'Scenario contains'); const search = el('input', { type: 'search', placeholder: 'e.g. find, PATCH, locale' })
  search.addEventListener('input', () => { filters.search = search.value.toLowerCase(); render() }); searchWrap.append(search); nav.append(searchWrap)
  const legend = el('div', { class: 'legend' })
  for (const e of engines) { const s = el('span'); const i = el('i'); i.style.background = ENGINE_COLOR[e]; s.append(i, document.createTextNode(ENGINE_NAME[e] || e)); legend.append(s) }
  nav.append(legend)
  const filtered = () => DATA.pairs.filter((p) => (filters.database === 'all' || p.database === filters.database) && (filters.shape === 'all' || p.shape === filters.shape) && (filters.size === 'all' || String(p.size) === filters.size) && (filters.surface === 'all' || p.surface === filters.surface) && (filters.category === 'all' || p.category === filters.category) && (!filters.search || p.name.toLowerCase().includes(filters.search)))

  // ---- charts ---------------------------------------------------------------------------
  const W = 760
  const diverging = (container, items, { labelWidth = 330, empty = 'No paired TS / Rust data for this filter.' } = {}) => {
    container.replaceChildren()
    if (!items.length) { container.append(el('p', { class: 'empty' }, empty)); return }
    const rowH = 22, H = items.length * rowH + 26, plot = W - labelWidth - 70, c = labelWidth + plot / 2, dom = 3
    const x = (v) => c + Math.max(-dom, Math.min(dom, Math.log2(v))) / dom * (plot / 2)
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, role: 'img', 'aria-label': 'speedup chart' })
    for (const t of [0.125, 0.25, 0.5, 1, 2, 4, 8]) { svg.append(svgEl('line', { x1: x(t), x2: x(t), y1: 0, y2: H - 20, class: t === 1 ? 'mid' : 'grid' })); svg.append(svgEl('text', { x: x(t), y: H - 6, 'text-anchor': 'middle', class: 'tick' }, (t < 1 ? '1/' + (1 / t) : t) + '×')) }
    items.forEach((item, i) => {
      const y = i * rowH + 3, g = svgEl('g', { class: 'row' })
      g.append(svgEl('rect', { x: 0, y: y - 2, width: W, height: rowH, class: 'hit' }))
      g.append(svgEl('text', { x: labelWidth - 8, y: y + 13, 'text-anchor': 'end', class: 'label' }, item.label.length > 52 ? item.label.slice(0, 51) + '…' : item.label))
      if (isFinite(item.v)) { const e = x(item.v); const bar = svgEl('rect', { x: Math.min(c, e), y: y + 1, width: Math.max(2, Math.abs(e - c)), height: rowH - 6, rx: 4 }); bar.style.fill = item.v >= 1 ? 'var(--faster)' : 'var(--slower)'; g.append(bar) }
      g.append(svgEl('text', { x: labelWidth + plot + 8, y: y + 13, class: 'label' }, times(item.v)))
      hover(g, item.tip); svg.append(g)
    })
    container.append(svg)
  }

  const renderSummary = (pairs) => {
    const node = document.getElementById('summary')
    if (!isPaired) { node.replaceChildren(el('p', { class: 'empty' }, 'One engine measured: see the distributions and the table for absolute numbers.')); return }
    const groups = new Map()
    for (const p of pairs) { for (const key of ['surface', 'category']) { const k = p.database + ' · ' + key + ': ' + p[key]; groups.set(k, [...(groups.get(k) || []), p]) } }
    const items = [...groups].map(([label, ps]) => ({ label: label + ' (' + ps.length + ')', v: geomean(ps.map(speedupOf)), tip: (n) => { n.append(el('strong', {}, label), el('div', {}, 'geomean speedup ' + times(geomean(ps.map(speedupOf)))), el('div', {}, ps.length + ' scenario cells; faster ' + ps.filter((p) => speedupOf(p) > 1.05).length + ', slower ' + ps.filter((p) => speedupOf(p) < 0.95).length)) } })).filter((i) => isFinite(i.v))
    diverging(node, items)
  }

  const renderSpeedups = (pairs) => {
    const items = pairs.map((p) => ({ label: p.surface + ' · ' + p.name + (filters.shape === 'all' || filters.size === 'all' || filters.database === 'all' ? '  [' + p.database[0] + ' ' + p.shape + ' ' + p.size + ']' : ''), v: speedupOf(p), tip: pairTip(p) })).filter((i) => isFinite(i.v)).sort((a, b) => a.v - b.v)
    const shown = items.slice(0, 400)
    diverging(document.getElementById('speedups'), shown)
    if (items.length > shown.length) document.getElementById('speedups').append(el('p', { class: 'empty' }, 'Showing the 400 slowest of ' + items.length + '; narrow the filters to see the rest.'))
  }

  const renderDistributions = (pairs) => {
    const node = document.getElementById('distributions'); node.replaceChildren()
    const list = pairs.slice(0, 150)
    if (!list.length) { node.append(el('p', { class: 'empty' }, 'No data for this filter.')); return }
    const all = list.flatMap((p) => Object.values(p.engines).flatMap((r) => r && !r.error ? [r.q ? r.q[1] : r.min, r.q ? r.q[19] : r.p95] : [])).filter((v) => v > 0)
    const lo = Math.log10(Math.min(...all)), hi = Math.log10(Math.max(...all))
    const labelWidth = 330, plot = W - labelWidth - 20, band = 10, rowH = engines.length * (band + 4) + 8, H = list.length * rowH + 26
    const x = (v) => labelWidth + (Math.log10(Math.max(v, 1e-6)) - lo) / Math.max(1e-9, hi - lo) * plot
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, role: 'img', 'aria-label': 'latency distributions' })
    for (let d = Math.floor(lo); d <= Math.ceil(hi); d++) for (const m of [1, 2, 5]) { const v = m * 10 ** d; if (Math.log10(v) < lo || Math.log10(v) > hi) continue; svg.append(svgEl('line', { x1: x(v), x2: x(v), y1: 0, y2: H - 20, class: 'grid' })); svg.append(svgEl('text', { x: x(v), y: H - 6, 'text-anchor': 'middle', class: 'tick' }, fmt(v) + ' ms')) }
    list.forEach((p, i) => {
      const y0 = i * rowH + 4, g = svgEl('g', { class: 'row' })
      g.append(svgEl('rect', { x: 0, y: y0 - 2, width: W, height: rowH, class: 'hit' }))
      g.append(svgEl('text', { x: labelWidth - 8, y: y0 + rowH / 2, 'text-anchor': 'end', class: 'label' }, (p.surface + ' · ' + p.name).slice(0, 52)))
      engines.forEach((e, k) => { const r = p.engines[e]; if (!r || r.error) return; const y = y0 + k * (band + 4)
        const q5 = r.q ? r.q[1] : r.min, q95 = r.q ? r.q[19] : r.p95, q25 = r.q ? r.q[5] : r.p25, q75 = r.q ? r.q[15] : r.p75
        const whisker = svgEl('line', { x1: x(q5), x2: x(q95), y1: y + band / 2, y2: y + band / 2 }); whisker.style.stroke = ENGINE_COLOR[e]; whisker.style.strokeWidth = 2; g.append(whisker)
        const box = svgEl('rect', { x: x(q25), y, width: Math.max(2, x(q75) - x(q25)), height: band, rx: 2 }); box.style.fill = ENGINE_COLOR[e]; box.style.opacity = 0.55; g.append(box)
        const med = svgEl('line', { x1: x(r.median), x2: x(r.median), y1: y - 1, y2: y + band + 1 }); med.style.stroke = ENGINE_COLOR[e]; med.style.strokeWidth = 3; g.append(med) })
      hover(g, pairTip(p)); svg.append(g)
    })
    node.append(svg)
    if (pairs.length > list.length) node.append(el('p', { class: 'empty' }, 'Showing 150 of ' + pairs.length + '; narrow the filters to see the rest.'))
  }

  const scalingState = { scenario: null }
  const renderScaling = (pairs) => {
    const controls = document.getElementById('scaling-controls'), node = document.getElementById('scaling'); controls.replaceChildren(); node.replaceChildren()
    const names = [...new Set(pairs.map((p) => p.surface + ' · ' + p.name))]
    if (!names.length) { node.append(el('p', { class: 'empty' }, 'No data for this filter.')); return }
    if (!names.includes(scalingState.scenario)) scalingState.scenario = names[0]
    const wrap = el('label', {}, 'Scenario'); const select = el('select', { 'aria-label': 'scenario for the scaling chart' })
    for (const n of names) { const o = el('option', { value: n }, n); if (n === scalingState.scenario) o.selected = true; select.append(o) }
    select.addEventListener('change', () => { scalingState.scenario = select.value; renderScaling(pairs) }); wrap.append(select); controls.append(wrap)
    const chosen = DATA.pairs.filter((p) => p.surface + ' · ' + p.name === scalingState.scenario && (filters.database === 'all' || p.database === filters.database) && (filters.shape === 'all' || p.shape === filters.shape))
    const groups = [...new Set(chosen.map((p) => p.database + ' / ' + p.shape))]
    const sizes = [...new Set(DATA.pairs.map((p) => p.size))].sort((a, b) => a - b)
    const panelW = 360, panelH = 200, grid = el('div'); grid.style.display = 'flex'; grid.style.flexWrap = 'wrap'; grid.style.gap = '12px'
    for (const group of groups) {
      const ps = chosen.filter((p) => p.database + ' / ' + p.shape === group)
      const values = ps.flatMap((p) => Object.values(p.engines).flatMap((r) => r && !r.error ? [r.p25, r.p75, r.median] : [])).filter((v) => v > 0)
      if (!values.length) continue
      const lo = Math.min(...values) * 0.8, hi = Math.max(...values) * 1.2
      const x = (size) => 50 + sizes.indexOf(size) / Math.max(1, sizes.length - 1) * (panelW - 70), y = (v) => panelH - 30 - (Math.log10(v) - Math.log10(lo)) / Math.max(1e-9, Math.log10(hi) - Math.log10(lo)) * (panelH - 50)
      const svg = svgEl('svg', { viewBox: '0 0 ' + panelW + ' ' + panelH, width: panelW, role: 'img', 'aria-label': 'scaling ' + group })
      svg.append(svgEl('text', { x: 4, y: 14, class: 'label' }, group))
      for (const s of sizes) { svg.append(svgEl('line', { x1: x(s), x2: x(s), y1: 20, y2: panelH - 30, class: 'grid' })); svg.append(svgEl('text', { x: x(s), y: panelH - 14, 'text-anchor': 'middle', class: 'tick' }, s + ' posts')) }
      for (const v of [lo, Math.sqrt(lo * hi), hi]) svg.append(svgEl('text', { x: 4, y: y(v) + 4, class: 'tick' }, fmt(v)))
      for (const e of engines) {
        const pts = sizes.map((s) => ps.find((p) => p.size === s)?.engines[e]).map((r, i) => r && !r.error ? { r, s: sizes[i] } : null).filter(Boolean)
        if (!pts.length) continue
        const bandPath = 'M' + pts.map((pt) => x(pt.s) + ',' + y(pt.r.p75)).join('L') + 'L' + pts.slice().reverse().map((pt) => x(pt.s) + ',' + y(pt.r.p25)).join('L') + 'Z'
        const area = svgEl('path', { d: bandPath }); area.style.fill = ENGINE_COLOR[e]; area.style.opacity = 0.18; svg.append(area)
        const line = svgEl('path', { d: 'M' + pts.map((pt) => x(pt.s) + ',' + y(pt.r.median)).join('L') }); line.style.stroke = ENGINE_COLOR[e]; line.style.strokeWidth = 2; line.style.fill = 'none'; svg.append(line)
        for (const pt of pts) { const dot = svgEl('circle', { cx: x(pt.s), cy: y(pt.r.median), r: 4 }); dot.style.fill = ENGINE_COLOR[e]; dot.style.stroke = 'var(--surface)'; dot.style.strokeWidth = 2; const hit = svgEl('circle', { cx: x(pt.s), cy: y(pt.r.median), r: 12, class: 'hit' }); const g = svgEl('g', { class: 'row' }); g.append(hit, dot); hover(g, (n) => { n.append(el('strong', {}, fmt(pt.r.median) + ' ms'), el('div', {}, (ENGINE_NAME[e] || e) + ' · ' + group + ' · ' + pt.s + ' posts'), el('div', {}, 'p25 ' + fmt(pt.r.p25) + ' · p75 ' + fmt(pt.r.p75) + ' · p95 ' + fmt(pt.r.p95) + ' ms'))}); svg.append(g) }
      }
      grid.append(svg)
    }
    node.append(grid.childNodes.length ? grid : el('p', { class: 'empty' }, 'No size series for this scenario.'))
  }

  const renderCpu = (pairs) => {
    const node = document.getElementById('cpu'); node.replaceChildren()
    const list = pairs.slice(0, 120)
    if (!list.length) { node.append(el('p', { class: 'empty' }, 'No data for this filter.')); return }
    const labelWidth = 330, colW = (W - labelWidth - 20) / 2, band = 8, rowH = engines.length * (band + 3) + 8, H = list.length * rowH + 30
    const maxCpu = Math.max(...list.flatMap((p) => Object.values(p.engines).map((r) => r?.cpu || 0)), 1e-6)
    const maxGc = Math.max(...list.flatMap((p) => Object.values(p.engines).map((r) => r && r.n ? (r.gcMs || 0) / r.n * 100 : 0)), 1e-6)
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, role: 'img', 'aria-label': 'cpu and gc' })
    svg.append(svgEl('text', { x: labelWidth, y: 12, class: 'label' }, 'CPU ms / iteration (max ' + fmt(maxCpu) + ')'), svgEl('text', { x: labelWidth + colW + 10, y: 12, class: 'label' }, 'GC ms / 100 iterations (max ' + fmt(maxGc) + ')'))
    list.forEach((p, i) => {
      const y0 = i * rowH + 22, g = svgEl('g', { class: 'row' }); g.append(svgEl('rect', { x: 0, y: y0 - 2, width: W, height: rowH, class: 'hit' }))
      g.append(svgEl('text', { x: labelWidth - 8, y: y0 + rowH / 2, 'text-anchor': 'end', class: 'label' }, (p.surface + ' · ' + p.name).slice(0, 52)))
      engines.forEach((e, k) => { const r = p.engines[e]; if (!r || r.error) return; const y = y0 + k * (band + 3)
        const a = svgEl('rect', { x: labelWidth, y, width: Math.max(1, (r.cpu || 0) / maxCpu * (colW - 10)), height: band, rx: 2 }); a.style.fill = ENGINE_COLOR[e]; g.append(a)
        const gcv = r.n ? (r.gcMs || 0) / r.n * 100 : 0; const b = svgEl('rect', { x: labelWidth + colW + 10, y, width: Math.max(1, gcv / maxGc * (colW - 20)), height: band, rx: 2 }); b.style.fill = ENGINE_COLOR[e]; g.append(b) })
      hover(g, pairTip(p)); svg.append(g)
    })
    node.append(svg)
  }

  const renderStartup = () => {
    const node = document.getElementById('startup'); node.replaceChildren()
    const rows = DATA.startup.filter((s) => filters.database === 'all' || s.database === filters.database)
    if (!rows.length) { node.append(el('p', { class: 'empty' }, 'No startup measurements for this filter.')); return }
    const med = (vs) => { const s = vs.filter(isFinite).sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
    const keys = [...new Set(rows.map((r) => r.database + ' · ' + r.shape))]
    const labelWidth = 200, plot = W - labelWidth - 90, band = 12, rowH = engines.length * (band + 3) + 8, H = keys.length * rowH + 26
    const maxTotal = Math.max(...rows.map((r) => med(r.runs.map((x) => x.totalMs))))
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, role: 'img', 'aria-label': 'startup' })
    keys.forEach((key, i) => {
      const y0 = i * rowH + 4, g = svgEl('g', { class: 'row' }); g.append(svgEl('rect', { x: 0, y: y0 - 2, width: W, height: rowH, class: 'hit' }))
      g.append(svgEl('text', { x: labelWidth - 8, y: y0 + rowH / 2, 'text-anchor': 'end', class: 'label' }, key))
      const phases = {}
      engines.forEach((e, k) => { const r = rows.find((row) => row.database + ' · ' + row.shape === key && row.engine === e); if (!r) return
        const total = med(r.runs.map((x) => x.totalMs)); phases[e] = { buildConfig: med(r.runs.map((x) => x.buildConfigMs)), getPayload: med(r.runs.map((x) => x.getPayloadMs)), import: med(r.runs.map((x) => x.importMs)), total }
        const y = y0 + k * (band + 3), bar = svgEl('rect', { x: labelWidth, y, width: Math.max(1, total / maxTotal * plot), height: band, rx: 3 }); bar.style.fill = ENGINE_COLOR[e]; g.append(bar)
        g.append(svgEl('text', { x: labelWidth + total / maxTotal * plot + 6, y: y + band - 2, class: 'tick' }, fmt(total) + ' ms')) })
      hover(g, (n) => { n.append(el('strong', {}, key)); for (const [e, ph] of Object.entries(phases)) n.append(el('div', {}, (ENGINE_NAME[e] || e) + ': total ' + fmt(ph.total) + ' ms = import ' + fmt(ph.import) + ' + buildConfig ' + fmt(ph.buildConfig) + ' + getPayload ' + fmt(ph.getPayload))) })
      svg.append(g)
    })
    node.append(svg)
  }

  const sortState = { key: 'speedup', dir: 1 }
  const renderTable = (pairs) => {
    const node = document.getElementById('table'); node.replaceChildren()
    const cols = [['database', 't'], ['shape', 't'], ['size', ''], ['surface', 't'], ['category', 't'], ['name', 't']]
    for (const e of engines) for (const k of ['median', 'p95', 'p99', 'cpu', 'gcMs', 'n']) cols.push([e + '.' + k, ''])
    cols.push(['docs', ''], ['bytes', ''], ['speedup', ''])
    const value = (p, key) => { if (key === 'speedup') return speedupOf(p); if (key === 'docs' || key === 'bytes') return (p.engines.ts || p.engines.rs || Object.values(p.engines)[0])?.[key]; if (key.includes('.')) { const [e, k] = key.split('.'); return p.engines[e]?.[k] } return p[key] }
    const sorted = pairs.slice().sort((a, b) => { const x = value(a, sortState.key), y = value(b, sortState.key); return (x > y ? 1 : x < y ? -1 : 0) * sortState.dir })
    const table = el('table'), head = el('tr')
    for (const [key, cls] of cols) { const th = el('th', { class: cls, scope: 'col' }, key + (sortState.key === key ? (sortState.dir > 0 ? ' ▲' : ' ▼') : '')); th.addEventListener('click', () => { sortState.dir = sortState.key === key ? -sortState.dir : 1; sortState.key = key; renderTable(pairs) }); head.append(th) }
    const thead = el('thead'); thead.append(head); table.append(thead)
    const tbody = el('tbody')
    for (const p of sorted.slice(0, 2000)) { const tr = el('tr'); for (const [key, cls] of cols) { const v = value(p, key); tr.append(el('td', { class: cls }, typeof v === 'number' ? (key === 'speedup' ? times(v) : key.endsWith('.n') || key === 'size' || key === 'docs' || key === 'bytes' ? String(v) : fmt(v)) : v ?? '-')) } tbody.append(tr) }
    table.append(tbody); node.append(table)
  }

  const render = () => { const pairs = filtered(); renderSummary(pairs); renderSpeedups(pairs); renderDistributions(pairs); renderScaling(pairs); renderCpu(pairs); renderStartup(); renderTable(pairs) }
  render()
})()
`
