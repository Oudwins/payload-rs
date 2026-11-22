/**
 * Reports of the performance suite: `report.md` (every number) and `report.html` (the same tables
 * plus one diverging bar chart per cell: the speedup ts / rs of every scenario on a log scale,
 * blue = the Rust engine is faster, red = slower, gray midline = equal). Speedups are of medians.
 */
import fs from 'node:fs'
import path from 'node:path'

export const writeReports = ({ outDir, results }) => {
  const model = buildModel(results)
  fs.writeFileSync(path.join(outDir, 'report.md'), markdown({ model, results }))
  fs.writeFileSync(path.join(outDir, 'report.html'), html({ model, results }))
}

const speedupOf = (ts, rs) => (Number.isFinite(ts) && Number.isFinite(rs) && rs > 0 ? ts / rs : NaN)
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN
}
const geomean = (values) => {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0)
  return finite.length
    ? Math.exp(finite.reduce((sum, value) => sum + Math.log(value), 0) / finite.length)
    : NaN
}
const ms = (value) =>
  Number.isFinite(value)
    ? value >= 100
      ? value.toFixed(0)
      : value >= 10
        ? value.toFixed(1)
        : value.toFixed(2)
    : '-'
const times = (value) => (Number.isFinite(value) ? `${value.toFixed(2)}×` : '-')

function buildModel(results) {
  const scenarioCells = results.cells.filter((cell) => cell.kind === 'scenarios')
  const groups = new Map()
  for (const cell of scenarioCells) {
    const key = `${cell.database}|${cell.shape}|${cell.size}`
    const group = groups.get(key) ?? {
      database: cell.database,
      shape: cell.shape,
      size: cell.size,
      ts: undefined,
      rs: undefined,
    }
    group[cell.engine] = cell
    groups.set(key, group)
  }
  const cells = [...groups.values()].map((group) => {
    const rows = (group.ts?.scenarios ?? []).map((tsScenario) => {
      const rsScenario = group.rs?.scenarios.find(
        (scenario) => scenario.surface === tsScenario.surface && scenario.name === tsScenario.name,
      )
      return {
        name: tsScenario.name,
        rs: rsScenario?.stats,
        rsError: rsScenario?.error?.message,
        speedup: speedupOf(tsScenario.stats.medianMs, rsScenario?.stats.medianMs),
        surface: tsScenario.surface,
        ts: tsScenario.stats,
        tsError: tsScenario.error?.message,
      }
    })
    return {
      ...group,
      rows,
      seedSpeedup: speedupOf(group.ts?.seed?.postsCreateMs, group.rs?.seed?.postsCreateMs),
    }
  })
  const summary = []
  for (const database of [...new Set(cells.map((cell) => cell.database))]) {
    for (const surface of ['local', 'rest', 'graphql']) {
      const rows = cells
        .filter((cell) => cell.database === database)
        .flatMap((cell) => cell.rows.filter((row) => row.surface === surface))
      if (rows.length === 0) {
        continue
      }
      const speedups = rows.map((row) => row.speedup).filter(Number.isFinite)
      summary.push({
        database,
        faster: speedups.filter((value) => value > 1.05).length,
        geomean: geomean(speedups),
        max: Math.max(...speedups),
        min: Math.min(...speedups),
        scenarios: speedups.length,
        slower: speedups.filter((value) => value < 0.95).length,
        surface,
      })
    }
  }
  const startup = []
  const startupCells = results.cells.filter((cell) => cell.kind === 'startup')
  for (const cell of startupCells.filter((entry) => entry.engine === 'ts')) {
    const rs = startupCells.find(
      (entry) =>
        entry.engine === 'rs' && entry.database === cell.database && entry.shape === cell.shape,
    )
    const phases = (entry) =>
      Object.fromEntries(
        ['importMs', 'buildConfigMs', 'getPayloadMs', 'totalMs'].map((phase) => [
          phase,
          median((entry?.runs ?? []).map((run) => run[phase])),
        ]),
      )
    const tsPhases = phases(cell)
    const rsPhases = phases(rs)
    startup.push({
      database: cell.database,
      rs: rsPhases,
      runs: cell.runs.length,
      shape: cell.shape,
      speedup: speedupOf(tsPhases.totalMs, rsPhases.totalMs),
      ts: tsPhases,
    })
  }
  return { cells, startup, summary }
}

function markdown({ model, results }) {
  const environment = results.cells.find((cell) => cell.environment)?.environment ?? {}
  let md = `# Payload performance: Rust engine vs upstream TypeScript\n\n`
  md += `${results.createdAt}; ${environment.platform ?? ''}, ${environment.cpu ?? ''} (${environment.cpus ?? '?'} cpus), Node ${environment.node ?? ''}. `
  md += `Speedup = TS median / Rust median (> 1: Rust faster). Both engines ran the packed dist builds (NODE_ENV=production), one fresh process and database per cell, cells one at a time. `
  md += `Iterations per scenario: at least ${results.options.minIterations} and ${results.options.minTimeMs} ms (at most ${results.options.maxIterations} / ${results.options.maxTimeMs} ms), after ${results.options.warmup} warmup runs.\n\n`
  if (results.failures.length > 0) {
    md += `## Failures\n\n${results.failures.map((failure) => `- ${failure}`).join('\n')}\n\n`
  }
  md += `## Summary (geometric mean of per-scenario speedups)\n\n| database | surface | scenarios | geomean | min | max | Rust faster (>1.05×) | Rust slower (<0.95×) |\n|---|---|---|---|---|---|---|---|\n`
  for (const row of model.summary) {
    md += `| ${row.database} | ${row.surface} | ${row.scenarios} | ${times(row.geomean)} | ${times(row.min)} | ${times(row.max)} | ${row.faster} | ${row.slower} |\n`
  }
  if (model.startup.length > 0) {
    md += `\n## Startup (median of fresh processes; import / buildConfig / getPayload, ms)\n\n| database | shape | runs | TS import | TS buildConfig | TS getPayload | TS total | Rust import | Rust buildConfig | Rust getPayload | Rust total | speedup |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`
    for (const row of model.startup) {
      md += `| ${row.database} | ${row.shape} | ${row.runs} | ${ms(row.ts.importMs)} | ${ms(row.ts.buildConfigMs)} | ${ms(row.ts.getPayloadMs)} | ${ms(row.ts.totalMs)} | ${ms(row.rs.importMs)} | ${ms(row.rs.buildConfigMs)} | ${ms(row.rs.getPayloadMs)} | ${ms(row.rs.totalMs)} | ${times(row.speedup)} |\n`
    }
  }
  if (model.cells.length > 0) {
    md += `\n## Seeding (posts created by payload.create, 8 concurrent)\n\n| database | shape | size | TS posts/s | Rust posts/s | speedup |\n|---|---|---|---|---|---|\n`
    for (const cell of model.cells) {
      md += `| ${cell.database} | ${cell.shape} | ${cell.size} | ${ms(cell.ts?.seed?.postsPerSecond)} | ${ms(cell.rs?.seed?.postsPerSecond)} | ${times(cell.seedSpeedup)} |\n`
    }
  }
  for (const cell of model.cells) {
    md += `\n## ${cell.database} / ${cell.shape} / ${cell.size} posts\n\n| surface | scenario | TS median ms | Rust median ms | speedup | TS p95 | Rust p95 | n (TS / Rust) |\n|---|---|---|---|---|---|---|---|\n`
    for (const row of cell.rows) {
      const error =
        row.tsError || row.rsError ? ` (error: ${row.tsError ?? ''} / ${row.rsError ?? ''})` : ''
      md += `| ${row.surface} | ${row.name}${error} | ${ms(row.ts?.medianMs)} | ${ms(row.rs?.medianMs)} | ${times(row.speedup)} | ${ms(row.ts?.p95Ms)} | ${ms(row.rs?.p95Ms)} | ${row.ts?.n ?? '-'} / ${row.rs?.n ?? '-'} |\n`
    }
  }
  return md
}

const escape = (value) =>
  String(value).replace(
    /[&<>"]/g,
    (char) => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char],
  )

/** One diverging bar chart: rows of { label, speedup, detail }. */
function divergingChart({ rows, title }) {
  const rowHeight = 22
  const labelWidth = 300
  const valueWidth = 64
  const plotWidth = 420
  const domain = 3 // log2: 1/8x .. 8x
  const height = rows.length * rowHeight + 28
  const width = labelWidth + plotWidth + valueWidth
  const center = labelWidth + plotWidth / 2
  const x = (speedup) =>
    center + (Math.max(-domain, Math.min(domain, Math.log2(speedup))) / domain) * (plotWidth / 2)
  const ticks = [0.125, 0.25, 0.5, 1, 2, 4, 8]
  let svg = `<svg role="img" aria-label="${escape(title)}" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px">`
  for (const tick of ticks) {
    svg += `<line x1="${x(tick)}" x2="${x(tick)}" y1="0" y2="${height - 20}" class="${tick === 1 ? 'mid' : 'grid'}"/>`
    svg += `<text x="${x(tick)}" y="${height - 6}" class="tick" text-anchor="middle">${tick < 1 ? `1/${1 / tick}` : tick}×</text>`
  }
  rows.forEach((row, index) => {
    const y = index * rowHeight + 4
    const barHeight = rowHeight - 8
    svg += `<g class="row" tabindex="0"><title>${escape(row.detail)}</title>`
    svg += `<rect x="0" y="${y - 3}" width="${width}" height="${rowHeight}" class="hit"/>`
    svg += `<text x="${labelWidth - 8}" y="${y + barHeight - 3}" class="label" text-anchor="end">${escape(row.label)}</text>`
    if (Number.isFinite(row.speedup)) {
      const end = x(row.speedup)
      const left = Math.min(center, end)
      const barWidth = Math.max(1, Math.abs(end - center))
      svg += `<rect x="${left}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" class="${row.speedup >= 1 ? 'faster' : 'slower'}"/>`
      svg += `<text x="${labelWidth + plotWidth + 8}" y="${y + barHeight - 3}" class="value">${times(row.speedup)}</text>`
    } else {
      svg += `<text x="${labelWidth + plotWidth + 8}" y="${y + barHeight - 3}" class="value">-</text>`
    }
    svg += `</g>`
  })
  return `${svg}</svg>`
}

function html({ model, results }) {
  const sections = []
  sections.push(
    `<h2>Summary</h2>${table(
      [
        'database',
        'surface',
        'scenarios',
        'geomean speedup',
        'min',
        'max',
        'Rust faster',
        'Rust slower',
      ],
      model.summary.map((row) => [
        row.database,
        row.surface,
        row.scenarios,
        times(row.geomean),
        times(row.min),
        times(row.max),
        row.faster,
        row.slower,
      ]),
    )}`,
  )
  if (model.startup.length > 0) {
    sections.push(
      `<h2>Startup</h2>${divergingChart({
        rows: model.startup.map((row) => ({
          detail: `${row.database} ${row.shape}: TS ${ms(row.ts.totalMs)} ms, Rust ${ms(row.rs.totalMs)} ms`,
          label: `${row.database} ${row.shape}`,
          speedup: row.speedup,
        })),
        title: 'Startup speedup (TS total / Rust total)',
      })}${table(
        [
          'database',
          'shape',
          'TS total ms',
          'Rust total ms',
          'TS getPayload',
          'Rust getPayload',
          'speedup',
        ],
        model.startup.map((row) => [
          row.database,
          row.shape,
          ms(row.ts.totalMs),
          ms(row.rs.totalMs),
          ms(row.ts.getPayloadMs),
          ms(row.rs.getPayloadMs),
          times(row.speedup),
        ]),
      )}`,
    )
  }
  for (const cell of model.cells) {
    sections.push(
      `<h2>${escape(`${cell.database} / ${cell.shape} / ${cell.size} posts`)}</h2>${divergingChart({
        rows: cell.rows.map((row) => ({
          detail: `${row.surface} ${row.name}: TS ${ms(row.ts?.medianMs)} ms (p95 ${ms(row.ts?.p95Ms)}), Rust ${ms(row.rs?.medianMs)} ms (p95 ${ms(row.rs?.p95Ms)})`,
          label: `${row.surface} · ${row.name}`,
          speedup: row.speedup,
        })),
        title: `Speedup per scenario, ${cell.database} ${cell.shape} ${cell.size}`,
      })}<details><summary>Table</summary>${table(
        ['surface', 'scenario', 'TS median ms', 'Rust median ms', 'speedup', 'TS p95', 'Rust p95'],
        cell.rows.map((row) => [
          row.surface,
          row.name,
          ms(row.ts?.medianMs),
          ms(row.rs?.medianMs),
          times(row.speedup),
          ms(row.ts?.p95Ms),
          ms(row.rs?.p95Ms),
        ]),
      )}</details>`,
    )
  }
  const failures = results.failures.length
    ? `<div class="failures"><strong>${results.failures.length} failure(s)</strong><ul>${results.failures.map((failure) => `<li>${escape(failure)}</li>`).join('')}</ul></div>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Payload performance: Rust vs TypeScript</title><style>
:root { --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink-2:#52514e; --grid:#e4e3df; --mid:#9a9994; --faster:#2a78d6; --slower:#e34948; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --surface:#1a1a19; --page:#0d0d0d; --ink:#f0efec; --ink-2:#c3c2b7; --grid:#2e2e2c; --mid:#6b6a65; --faster:#3987e5; --slower:#e66767; } }
body { background:var(--page); color:var(--ink); font:14px/1.45 system-ui, sans-serif; margin:24px; }
section { background:var(--surface); border-radius:5px; padding:16px; margin-bottom:16px; }
.legend span { display:inline-flex; align-items:center; gap:6px; margin-right:16px; color:var(--ink-2); }
.legend i { width:12px; height:12px; border-radius:2px; display:inline-block; }
svg text { fill:var(--ink-2); font-size:12px; } svg .label { fill:var(--ink); } svg .tick { font-size:11px; }
svg .grid { stroke:var(--grid); stroke-width:1; } svg .mid { stroke:var(--mid); stroke-width:2; }
svg .faster { fill:var(--faster); } svg .slower { fill:var(--slower); } svg .hit { fill:transparent; }
svg .row:hover .hit, svg .row:focus .hit { fill:var(--grid); opacity:.5; }
table { border-collapse:collapse; margin-top:8px; } td, th { padding:3px 10px; text-align:left; border-bottom:1px solid var(--grid); } th { color:var(--ink-2); font-weight:600; }
.failures { border-left:4px solid var(--slower); padding-left:12px; }
</style></head><body><h1>Payload performance: Rust engine vs upstream TypeScript</h1>
<p>Speedup = TS median / Rust median, log scale. ${escape(results.createdAt)}. Hover a row for both medians and p95s; every chart has its table.</p>
<p class="legend"><span><i style="background:var(--faster)"></i>Rust faster</span><span><i style="background:var(--slower)"></i>Rust slower</span></p>
${failures}${sections.map((section) => `<section>${section}</section>`).join('\n')}</body></html>`
}

function table(head, rows) {
  return `<table><thead><tr>${head.map((cell) => `<th>${escape(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}
