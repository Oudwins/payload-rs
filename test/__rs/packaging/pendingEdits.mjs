/**
 * The packaging edits other owners still have to make in the monorepo (RUST_PORT.md
 * "Packaging"), expressed on the packed tarball contents. `run.mjs` applies an edit to the
 * extracted tarball only when the packed package does not contain it yet and reports it as
 * "simulated"; once the source change lands the edit reports "upstream" and changes nothing.
 * With `--no-simulate` (`isDryRun`) a missing edit is only reported ("missing") and the tarball is
 * left as packed, so the run shows what breaks without it.
 *
 * Every edit fails loudly when it finds neither the old nor the new shape, so a refactor of the
 * dispatch can not silently skip it.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Relative specifier into the monorepo's engine-rs sources, as payload's dispatch modules use. */
const relativeEngineSource = /(['"])((?:\.\.\/)+)engine-rs\/src\/([^'"]+)\.js\1/g
const relativeEngineAddon = /(['"])((?:\.\.\/)+)engine-rs\/payload-engine\.node\1/g

/**
 * @param {{ engineExports: Record<string, any>, engineVersion: string }} context
 * @returns {Record<string, Array<{ id: string, description: string, apply: (dir: string, options: { isDryRun: boolean }) => 'missing' | 'simulated' | 'upstream' }>>}
 */
export const getPendingEdits = ({ engineExports, engineVersion }) => {
  const subpathForSource = (source) => {
    const entry = Object.entries(engineExports).find(([, target]) => {
      const file = typeof target === 'string' ? target : target.import
      return file === `./src/${source}.ts`
    })
    if (!entry) {
      throw new Error(`engine-rs has no export for src/${source}.ts`)
    }
    return `@payloadcms/engine-rs${entry[0].slice(1)}`
  }

  const dispatchEdit = (id) => ({
    id,
    description:
      "dispatch imports '@payloadcms/engine-rs/<subpath>' (and the addon '@payloadcms/engine-rs/payload-engine.node') instead of '../../engine-rs/src/...'",
    apply: (dir, { isDryRun }) => {
      let relative = 0
      let named = 0
      for (const file of listFiles(path.join(dir, 'dist')).filter((name) => name.endsWith('.js'))) {
        const code = fs.readFileSync(file, 'utf8')
        named += (code.match(/(['"])@payloadcms\/engine-rs(\/[^'"]*)?\1/g) ?? []).length
        const next = code
          .replace(relativeEngineSource, (_match, quote, _up, source) => {
            relative++
            return `${quote}${subpathForSource(source)}${quote}`
          })
          .replace(relativeEngineAddon, (_match, quote) => {
            relative++
            return `${quote}@payloadcms/engine-rs/payload-engine.node${quote}`
          })
        if (next !== code && !isDryRun) {
          fs.writeFileSync(file, next)
        }
      }
      if (relative === 0 && named === 0) {
        throw new Error(`${id}: found no engine-rs dispatch in ${dir}/dist`)
      }
      return relative === 0 ? 'upstream' : isDryRun ? 'missing' : 'simulated'
    },
  })

  const manifestEdit = (id, description, isApplied, apply) => ({
    id,
    description,
    apply: (dir, { isDryRun }) => {
      const file = path.join(dir, 'package.json')
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (isApplied(manifest)) {
        return 'upstream'
      }
      if (isDryRun) {
        return 'missing'
      }
      apply(manifest)
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
      return 'simulated'
    },
  })

  const internalExport = { default: './dist/*', import: './dist/*' }
  const internalExportEdit = (id) =>
    manifestEdit(
      id,
      `publishConfig.exports['./internal/*'] = ${JSON.stringify(internalExport)}`,
      (manifest) => manifest.exports?.['./internal/*'] !== undefined,
      (manifest) => {
        manifest.exports['./internal/*'] = internalExport
      },
    )
  const engineDependencyEdit = (id) =>
    manifestEdit(
      id,
      `dependencies['@payloadcms/engine-rs'] = 'workspace:*'`,
      (manifest) => manifest.dependencies?.['@payloadcms/engine-rs'] !== undefined,
      (manifest) => {
        manifest.dependencies['@payloadcms/engine-rs'] = engineVersion
      },
    )

  return {
    '@payloadcms/drizzle': [internalExportEdit('drizzle: internal exports')],
    '@payloadcms/richtext-lexical': [
      engineDependencyEdit('richtext-lexical: engine-rs dependency'),
      dispatchEdit('richtext-lexical: dispatch by package name'),
    ],
    payload: [
      internalExportEdit('payload: internal exports'),
      engineDependencyEdit('payload: engine-rs dependency'),
      dispatchEdit('payload: dispatch by package name'),
    ],
  }
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []))
}
