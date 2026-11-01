/**
 * Loads the afterChange/beforeDuplicate binding (crates/payload-core-hooks-after, exported by the
 * main addon as `coreHooksAfterBinding()`) and installs its JS helpers. It runs on the core
 * runtime's executor and host, so the core runtime is initialized first, from the same addon file.
 */
import { createRequire } from 'node:module'

import { getCoreRuntime } from '../index.js'

export type CoreHooksAfterBinding = {
  afterChange: (args: unknown) => Promise<unknown>
  beforeDuplicate: (args: unknown) => Promise<unknown>
  init: (host: Record<string, unknown>) => void
}

let binding: CoreHooksAfterBinding | undefined

export const getCoreHooksAfter = (): CoreHooksAfterBinding => {
  if (binding) {
    return binding
  }
  getCoreRuntime()
  const require = createRequire(import.meta.url)
  // Same resolution as `getCoreRuntime()`: both bindings must come from one addon instance.
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../../payload-engine.node'
  const addon = require(addonPath) as { coreHooksAfterBinding?: () => CoreHooksAfterBinding }
  if (typeof addon.coreHooksAfterBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no coreHooksAfterBinding export`)
  }
  const created = addon.coreHooksAfterBinding()

  created.init({
    // The field afterChange hook args literal of afterChange/promise.ts (same key order).
    afterChangeHookArgs: (
      blockData: unknown,
      collection: unknown,
      context: unknown,
      data: unknown,
      field: unknown,
      global: unknown,
      indexPath: unknown,
      operation: unknown,
      originalDoc: unknown,
      path: unknown,
      previousDoc: unknown,
      previousSiblingDoc: unknown,
      previousValue: unknown,
      req: unknown,
      schemaPath: unknown,
      siblingData: unknown,
      siblingFields: unknown,
      value: unknown,
    ) => ({
      blockData,
      collection,
      context,
      data,
      field,
      global,
      indexPath,
      operation,
      originalDoc,
      path,
      previousDoc,
      previousSiblingDoc,
      previousValue,
      req,
      schemaPath,
      siblingData,
      siblingFields,
      value,
    }),
    // The beforeDuplicateArgs literal of beforeDuplicate/promise.ts (same key order).
    beforeDuplicateHookArgs: (
      blockData: unknown,
      collection: unknown,
      context: unknown,
      data: unknown,
      field: unknown,
      indexPath: unknown,
      path: unknown,
      siblingDoc: unknown,
      previousValue: unknown,
      req: unknown,
      schemaPath: unknown,
      siblingFields: unknown,
      value: unknown,
    ) => ({
      blockData,
      collection,
      context,
      data,
      field,
      global: undefined,
      indexPath,
      path,
      previousSiblingDoc: siblingDoc,
      previousValue,
      req,
      schemaPath,
      siblingData: siblingDoc,
      siblingDocWithLocales: siblingDoc,
      siblingFields,
      value,
    }),
    callHook: (hook: any, args: unknown) => hook(args),
    // The rich text editor afterChange hook args literal of afterChange/promise.ts.
    editorAfterChangeHookArgs: (
      collection: unknown,
      context: unknown,
      data: unknown,
      field: unknown,
      global: unknown,
      indexPath: unknown,
      operation: unknown,
      originalDoc: unknown,
      parentIsLocalized: unknown,
      path: unknown,
      previousDoc: unknown,
      previousSiblingDoc: unknown,
      previousValue: unknown,
      req: unknown,
      schemaPath: unknown,
      siblingData: unknown,
      value: unknown,
    ) => ({
      collection,
      context,
      data,
      field,
      global,
      indexPath,
      operation,
      originalDoc,
      parentIsLocalized,
      path,
      previousDoc,
      previousSiblingDoc,
      previousValue,
      req,
      schemaPath,
      siblingData,
      value,
    }),
    // `for...of` over non-array iterables: same source text, so V8 raises the same TypeError.
    editorAfterChangeHooks: (editor: any) => {
      const hooks: unknown[] = []
      for (const hook of editor.hooks.afterChange) {
        hooks.push(hook)
      }
      return hooks
    },
    fieldAfterChangeHooks: (field: any) => {
      const hooks: unknown[] = []
      for (const hook of field.hooks.afterChange) {
        hooks.push(hook)
      }
      return hooks
    },
    fieldBeforeDuplicateHooks: (field: any) => {
      const hooks: unknown[] = []
      for (const hook of field.hooks.beforeDuplicate) {
        hooks.push(hook)
      }
      return hooks
    },
    keysLength: (value: any) => Object.keys(value).length,
    localeCodes: (localization: any) => {
      const codes: unknown[] = []
      for (const locale of localization.localeCodes) {
        codes.push(locale)
      }
      return codes
    },
    localeCodesForEach: (localization: any) => localization.localeCodes.forEach(() => {}),
    spread: (value: any) => ({ ...value }),
  })
  binding = created
  return created
}
