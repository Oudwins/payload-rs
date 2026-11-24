import { loadedEngineAddonPath, loadEngineAddon } from './addon.js'

/** `crates/payload-node/src/engine.rs` (see ENGINE_CONTRACT.md). */
export type NativeSqliteEngine = {
  attachClient: (clientId: number) => void
  /**
   * `contextJson` = `{ now, allowIDOnCreate, blocksAsJSON, limitedBoundParameters, withMutations }`:
   * the JS clock (`Date.now()`) at the call, for the "now" stamps upstream takes from `new Date()`
   * (so faked clocks apply), and the adapter properties drizzle reads at call time (changed after
   * init). With `withMutations: true` the result is `{ result, mutations: [path, tree][] }`.
   */
  call: (method: string, argsJson: string, connId: number, contextJson: string) => Promise<string>
  rawSchema: () => string
  /** `{ drizzle, rawTables? }`: the schema after the schema hooks, before the first `call`. */
  setLiveSchema: (descriptionJson: string) => void
}

export type NativeSqliteEngineClass = {
  create: (
    graphJson: string,
    optionsJson: string,
    callFunction: (id: number, argJson: string) => string,
  ) => NativeSqliteEngine
}

export type NativeEngine = {
  buildRawSchema: (
    graph: string,
    options: string,
    callFunction: (id: number, arg: string) => string,
  ) => string
  /** Absent until the Rust engine is built into the addon. */
  SqliteEngine?: NativeSqliteEngineClass
  version: () => string
}

/**
 * The addon API this glue is written against: every export of `crates/payload-node` that some
 * engine-rs loader (or payload's `fields/validations.ts`) calls. An addon built from an older tree
 * lacks some of them (e.g. one from before the live MongoDB engine has no `mongoLive*Binding`), and
 * the glue would otherwise notice only when it reaches the missing export, or fall back to an older
 * engine. Each binding additionally checks its own `apiVersion` when it is created.
 */
export const engineAddonExports = [
  'SqliteEngine',
  'buildMongoSchemaDescription',
  'buildRawSchema',
  'coreHooksAfterBinding',
  'coreOpsBinding',
  'coreOpsGlobalBinding',
  'coreOpsWriteBinding',
  'coreQueryBinding',
  'coreRuntimeBinding',
  'fnIrAnalyze',
  'fnIrCompare',
  'fnIrCompile',
  'fnIrDeoptimize',
  'fnIrDescribe',
  'fnIrEvaluate',
  'fnIrInit',
  'fnIrIsActive',
  'fnIrRecord',
  'fnIrReserve',
  'fnIrResultToJs',
  'fnIrSetCallGuard',
  'fnIrSetPolicy',
  'fnIrShouldVerify',
  'fnIrStats',
  'fuseRegisterPlan',
  'fuseRunSqlite',
  'hooksBeforeChangeBinding',
  'hooksBeforeValidateBinding',
  'mongoDriverAggregate',
  'mongoDriverApiVersion',
  'mongoDriverClose',
  'mongoDriverCommand',
  'mongoDriverConnect',
  'mongoDriverCount',
  'mongoDriverFindOne',
  'mongoDriverPaginate',
  'mongoDriverRegisterPlan',
  'mongoDriverStats',
  'mongoDriverTransform',
  'mongoDriverTxnBegin',
  'mongoDriverTxnCommand',
  'mongoDriverTxnEnd',
  'mongoLiveBinding',
  'mongoLiveJoinsBinding',
  'mongoLiveQueryBinding',
  'mongoLiveSchemaBinding',
  'mongoLiveTransformBinding',
  'mongoLiveWriteBinding',
  'sqliteClientClose',
  'sqliteCreateClient',
  'sqliteEngineQuery',
  'sqliteExecute',
  'sqliteExecuteMultiple',
  'sqliteExecuteSync',
  'sqliteGetDbSync',
  'sqliteInTransaction',
  'sqliteParameterNamesSync',
  'sqliteRelease',
  'sqliteStartStatementTrace',
  'sqliteStats',
  'sqliteTakeStatementTrace',
  'sqliteTransaction',
  'sqliteTransactionClose',
  'sqliteTransactionEnd',
  'validateBinding',
  'version',
] as const

/**
 * Throws unless `addon` (loaded from `addonPath`) has every export in `engineAddonExports`: a stale
 * addon fails loudly at load instead of running an older engine.
 */
export const assertEngineAddon = ({
  addon,
  addonPath,
}: {
  addon: unknown
  addonPath: string
}): void => {
  const missing = engineAddonExports.filter(
    (name) => typeof (addon as null | Record<string, unknown>)?.[name] !== 'function',
  )
  if (missing.length > 0) {
    throw new Error(
      `The engine addon at ${addonPath} does not match @payloadcms/engine-rs: it lacks ${missing.join(', ')}. It was built from an older tree; rebuild it (pnpm --filter @payloadcms/engine-rs build:native)`,
    )
  }
}

let native: NativeEngine | undefined

/**
 * Loads the addon (`addon.cjs`: the one instance every loader shares). Throws when the addon is not
 * the one this glue expects (`assertEngineAddon`).
 */
export const getNativeEngine = (): NativeEngine => {
  if (!native) {
    const addon = loadEngineAddon()
    assertEngineAddon({ addon, addonPath: loadedEngineAddonPath() })
    native = addon as NativeEngine
  }
  return native
}
