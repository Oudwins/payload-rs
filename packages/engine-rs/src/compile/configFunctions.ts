/**
 * The user functions of a sanitized config that the compiler targets, with where they sit: access
 * functions (collection, global, field), collection / global / field hooks and field validators.
 */

import type { AnyFunction } from './snapshot.js'
export type FunctionKind =
  | 'access'
  | 'collectionHook'
  | 'fieldAccess'
  | 'fieldHook'
  | 'globalHook'
  | 'validate'

export type ConfigFunction = {
  fn: AnyFunction
  kind: FunctionKind
  /** `collections.posts.access.read`, `collections.posts.fields.title.hooks.beforeChange.0`. */
  label: string
  /** Replaces the function in the config (guard mode). */
  replace: (next: AnyFunction) => void
}

type AnyRecord = Record<string, any>

const pushIfFunction = (
  out: ConfigFunction[],
  holder: AnyRecord,
  key: number | string,
  kind: FunctionKind,
  label: string,
) => {
  const fn = holder?.[key]
  if (typeof fn === 'function') {
    out.push({
      fn,
      kind,
      label,
      replace: (next) => {
        holder[key] = next
      },
    })
  }
}

const hookLists = (
  out: ConfigFunction[],
  hooks: AnyRecord | undefined,
  kind: FunctionKind,
  label: string,
) => {
  if (!hooks || typeof hooks !== 'object') {
    return
  }
  for (const [name, list] of Object.entries(hooks)) {
    if (Array.isArray(list)) {
      list.forEach((_, i) => pushIfFunction(out, list, i, kind, `${label}.hooks.${name}.${i}`))
    }
  }
}

const accessFunctions = (
  out: ConfigFunction[],
  access: AnyRecord | undefined,
  kind: FunctionKind,
  label: string,
) => {
  if (!access || typeof access !== 'object') {
    return
  }
  for (const key of Object.keys(access)) {
    pushIfFunction(out, access, key, kind, `${label}.access.${key}`)
  }
}

const fields = (
  out: ConfigFunction[],
  list: AnyRecord[] | undefined,
  label: string,
  seen: Set<object>,
) => {
  if (!Array.isArray(list) || seen.has(list)) {
    return
  }
  seen.add(list)
  list.forEach((field, i) => {
    if (!field || typeof field !== 'object') {
      return
    }
    const name = typeof field.name === 'string' ? field.name : `${field.type ?? 'field'}#${i}`
    const fieldLabel = `${label}.${name}`
    accessFunctions(out, field.access, 'fieldAccess', fieldLabel)
    hookLists(out, field.hooks, 'fieldHook', fieldLabel)
    pushIfFunction(out, field, 'validate', 'validate', `${fieldLabel}.validate`)
    fields(out, field.fields, fieldLabel, seen)
    if (Array.isArray(field.tabs)) {
      field.tabs.forEach((tab: AnyRecord, t: number) => {
        const tabLabel = `${fieldLabel}.${typeof tab.name === 'string' ? tab.name : `tab#${t}`}`
        accessFunctions(out, tab.access, 'fieldAccess', tabLabel)
        hookLists(out, tab.hooks, 'fieldHook', tabLabel)
        fields(out, tab.fields, tabLabel, seen)
      })
    }
    if (Array.isArray(field.blocks)) {
      for (const block of field.blocks) {
        if (block && typeof block === 'object') {
          fields(out, block.fields, `${fieldLabel}.${block.slug}`, seen)
        }
      }
    }
  })
}

/** Every targeted function of `config`, collections first, in config order. */
export const configFunctions = (config: AnyRecord): ConfigFunction[] => {
  const out: ConfigFunction[] = []
  const seen = new Set<object>()
  for (const collection of config.collections ?? []) {
    const label = `collections.${collection.slug}`
    accessFunctions(out, collection.access, 'access', label)
    hookLists(out, collection.hooks, 'collectionHook', label)
    fields(out, collection.fields, `${label}.fields`, seen)
  }
  for (const global of config.globals ?? []) {
    const label = `globals.${global.slug}`
    accessFunctions(out, global.access, 'access', label)
    hookLists(out, global.hooks, 'globalHook', label)
    fields(out, global.fields, `${label}.fields`, seen)
  }
  for (const block of config.blocks ?? []) {
    fields(out, block.fields, `blocks.${block.slug}.fields`, seen)
  }
  return out
}
