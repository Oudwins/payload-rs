import type { DeepPartial } from 'ts-essentials'

import type { CollectionSlug } from '../../index.js'
import type { TransformCollectionWithSelect } from '../../types/index.js'
import type { RequiredDataFromCollectionSlug, SelectFromCollectionSlug } from '../config/types.js'

import { type Arguments as CreateArguments, createOperation } from './create.js'

export type Arguments<TSlug extends CollectionSlug> = {
  data?: DeepPartial<RequiredDataFromCollectionSlug<TSlug>>
  id: number | string
} & Omit<CreateArguments<TSlug>, 'data' | 'duplicateFromID'>

export const duplicateOperationTS = async <
  TSlug extends CollectionSlug,
  TSelect extends SelectFromCollectionSlug<TSlug>,
>(
  incomingArgs: Arguments<TSlug>,
): Promise<TransformCollectionWithSelect<TSlug, TSelect>> => {
  const { id, ...args } = incomingArgs
  return createOperation({
    ...args,
    data: incomingArgs?.data || {},
    duplicateFromID: id,
  })
}

type RustWriteOperations = {
  duplicateOperation: (args: Parameters<typeof duplicateOperationTS>[0]) => Promise<any>
  recordDeferredCall: () => void
}

/**
 * Rust engine (`packages/engine-rs/src/ops-write`), selected once at module load:
 * `PAYLOAD_CORE_ENGINE=rs|ts`, else `PAYLOAD_ENGINE=rs`. See RUST_OPS_DESIGN.md.
 */
const isRustWriteOperations =
  (process.env.PAYLOAD_CORE_ENGINE || process.env.PAYLOAD_ENGINE) === 'rs'
const rustWriteOperationsSpecifier = '../../../../engine-rs/src/ops-write/index.js'
let rustWriteOperations: RustWriteOperations | undefined
const rustWriteOperationsLoad: Promise<RustWriteOperations> | undefined = isRustWriteOperations
  ? import(/* @vite-ignore */ /* webpackIgnore: true */ rustWriteOperationsSpecifier).then(
      (loaded: RustWriteOperations) => (rustWriteOperations = loaded),
    )
  : undefined
void rustWriteOperationsLoad?.catch(() => {})

export const duplicateOperation: typeof duplicateOperationTS = isRustWriteOperations
  ? (args) =>
      rustWriteOperations
        ? rustWriteOperations.duplicateOperation(args)
        : rustWriteOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.duplicateOperation(args)
          })
  : duplicateOperationTS
