/**
 * Rust-backed drop-in for `afterChange` from `payload/src/fields/hooks/afterChange/index.ts`
 * (port: crates/payload-core-hooks-after/src/after_change.rs).
 */
import type { afterChange as AfterChangeTS } from '../../../../payload/src/fields/hooks/afterChange/index.js'
import type { JsonObject } from '../../../../payload/src/types/index.js'

import { getCoreHooksAfter } from './binding.js'

export type AfterChangeArgs<T extends JsonObject> = Parameters<typeof AfterChangeTS<T>>[0]

export const afterChange = <T extends JsonObject>(args: AfterChangeArgs<T>): Promise<T> =>
  getCoreHooksAfter().afterChange(args) as Promise<T>
