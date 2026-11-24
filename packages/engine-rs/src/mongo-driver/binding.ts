/**
 * The driver lane exports of the engine addon (crates/payload-mongo-driver/node/mod.rs), from the
 * one addon instance of the process (`loadCoreRuntimeAddon`).
 */
import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../addon.js'

/** crates/payload-mongo-driver/node/mod.rs `API_VERSION`. */
const MONGO_DRIVER_API_VERSION = 1

export type DriverBinding = {
  aggregate: (client: number, plan: number, args: Uint8Array) => Promise<string>
  close: (client: number) => Promise<void>
  command: (client: number, database: null | string, command: Uint8Array) => Promise<Uint8Array>
  connect: (url: string, specJson: string) => Promise<string>
  count: (client: number, args: Uint8Array) => Promise<string>
  findOne: (client: number, plan: number, args: Uint8Array) => Promise<string>
  paginate: (client: number, plan: number, args: Uint8Array) => Promise<string>
  registerPlan: (planJson: string) => number
  stats: () => number[]
  /** The read transform of `raw: true` documents (concatenated BSON): JSON documents or `!reason`. */
  transform: (
    plan: number,
    docs: Uint8Array,
    isLeanWithId: boolean,
    allowAdditionalKeys: boolean,
  ) => string
  /** Rust-owned transactions (RUST_PERF_PLAN.md D4 prototype, rustTxn.ts). */
  txnBegin: (client: number) => number
  txnCommand: (txn: number, database: null | string, command: Uint8Array) => Promise<Uint8Array>
  txnEnd: (txn: number, shouldCommit: boolean) => Promise<string>
}

type DriverAddon = {
  mongoDriverAggregate?: DriverBinding['aggregate']
  mongoDriverApiVersion?: () => number
  mongoDriverClose?: DriverBinding['close']
  mongoDriverCommand?: DriverBinding['command']
  mongoDriverConnect?: DriverBinding['connect']
  mongoDriverCount?: DriverBinding['count']
  mongoDriverFindOne?: DriverBinding['findOne']
  mongoDriverPaginate?: DriverBinding['paginate']
  mongoDriverRegisterPlan?: DriverBinding['registerPlan']
  mongoDriverStats?: DriverBinding['stats']
  mongoDriverTransform?: DriverBinding['transform']
  mongoDriverTxnBegin?: DriverBinding['txnBegin']
  mongoDriverTxnCommand?: DriverBinding['txnCommand']
  mongoDriverTxnEnd?: DriverBinding['txnEnd']
}

let binding: DriverBinding | null | undefined

/** The driver binding, or `null` when the addon has none (the adapter stays on the mongoose lane). */
export const getDriverBinding = (): DriverBinding | null => {
  if (binding !== undefined) {
    return binding
  }
  const addon = loadCoreRuntimeAddon() as DriverAddon
  if (typeof addon.mongoDriverApiVersion !== 'function') {
    binding = null
    return binding
  }
  const version = addon.mongoDriverApiVersion()
  if (version !== MONGO_DRIVER_API_VERSION) {
    throw new Error(
      `The engine addon at ${coreRuntimeAddonPath()} has mongo driver API version ${version}, expected ${MONGO_DRIVER_API_VERSION}; rebuild it`,
    )
  }
  binding = {
    aggregate: addon.mongoDriverAggregate!,
    close: addon.mongoDriverClose!,
    command: addon.mongoDriverCommand!,
    connect: addon.mongoDriverConnect!,
    count: addon.mongoDriverCount!,
    findOne: addon.mongoDriverFindOne!,
    paginate: addon.mongoDriverPaginate!,
    registerPlan: addon.mongoDriverRegisterPlan!,
    stats: addon.mongoDriverStats!,
    transform: addon.mongoDriverTransform!,
    txnBegin: addon.mongoDriverTxnBegin!,
    txnCommand: addon.mongoDriverTxnCommand!,
    txnEnd: addon.mongoDriverTxnEnd!,
  }
  return binding
}
