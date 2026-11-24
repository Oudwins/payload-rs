/**
 * Database adapters that can own the transaction of a write operation themselves
 * (RUST_PERF_PLAN.md D4, prototype: `PAYLOAD_MONGO_RUST_TXN=true`, off by default). The MongoDB
 * driver lane registers its adapters here (mongo-driver/rustTxn.ts); the write operations ask
 * before they start. No imports: an install without db-mongodb loads nothing of MongoDB.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- operation arguments are untyped here */
type Any = any

export type TransactionLane = (
  operation: string,
  args: Any,
  run: () => Promise<Any>,
) => Promise<Any> | undefined

export const isAdapterTransactionEnabled = process.env.PAYLOAD_MONGO_RUST_TXN === 'true'

const lanes = new WeakMap<object, TransactionLane>()

export const registerTransactionLane = (adapter: object, lane: TransactionLane) => {
  lanes.set(adapter, lane)
}

/**
 * `run()` inside a transaction the adapter of `args.req` owns, when it accepts the operation;
 * `undefined` otherwise (the operation runs as usual).
 */
export const runInAdapterTransaction = (operation: string, args: Any, run: () => Promise<Any>) => {
  const adapter = args?.req?.payload?.db
  const lane = adapter ? lanes.get(adapter) : undefined
  return lane?.(operation, args, run)
}
