/**
 * Rust-backed drop-in for `beforeDuplicate` from
 * `payload/src/fields/hooks/beforeDuplicate/index.ts`
 * (port: crates/payload-core-hooks-after/src/before_duplicate.rs).
 */
import type { beforeDuplicate as BeforeDuplicateTS } from '../../../../payload/src/fields/hooks/beforeDuplicate/index.js'
import type { JsonObject } from '../../../../payload/src/types/index.js'

import { getCoreHooksAfter } from '../afterChange/binding.js'

export type BeforeDuplicateArgs<T extends JsonObject> = Parameters<typeof BeforeDuplicateTS<T>>[0]

export const beforeDuplicate = <T extends JsonObject>(args: BeforeDuplicateArgs<T>): Promise<T> =>
  getCoreHooksAfter().beforeDuplicate(args) as Promise<T>
