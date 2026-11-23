import { getNativeEngine } from '../native.js'
import {
  createNullProto,
  FnRef,
  HeadersSnapshot,
  opaqueFunction,
  opaqueObject,
  opaquePrimitive,
  Partial,
} from './snapshot.js'

/** A free identifier's member paths (`crates/payload-fn-ir` `PathTrie`). */
export type PathTrie = { members: Record<string, PathTrie>; value: boolean }

export type Analysis =
  | {
      argKeys: (null | string[])[]
      free: Record<string, PathTrie>
      isAsync: boolean
      params: number
    }
  | { reject: string }

export type Resolution =
  | { id: number; kind: 'function' }
  | { kind: 'builtin'; path: string }
  | { kind: 'namespace'; members: Record<string, Resolution> }
  | { kind: 'unresolved'; reason: string }
  | { kind: 'value'; value: unknown }

/** An evaluation result held in Rust. */
export type CompiledResult = { readonly __compiledResult: unique symbol }

/** `crates/payload-node/src/fn_ir.rs`. */
export type FnIrBinding = {
  fnIrAnalyze: (source: string) => Analysis
  fnIrCompare: (result: CompiledResult, jsResult: unknown) => 0 | 1 | 2
  fnIrCompile: (
    id: number,
    source: string,
    resolutions: Record<string, Resolution>,
    label: string,
  ) => null | string
  fnIrDeoptimize: (id: number) => void
  fnIrDescribe: (id: number) => null | string
  /** The result, or the reason the evaluation handed the call back to JS. */
  fnIrEvaluate: (id: number, args: unknown[]) => CompiledResult | string
  fnIrInit: (deps: Record<string, unknown>) => void
  fnIrIsActive: (id: number) => boolean
  fnIrRecord: (id: number, outcome: 0 | 1 | 2) => void
  fnIrReserve: () => number
  fnIrResultToJs: (result: CompiledResult) => unknown
  /** The Rust core's call guard (`js::call`), or `undefined` to remove it. */
  fnIrSetCallGuard: (
    guard: ((fn: never, thisArg: unknown, args: unknown[]) => unknown) | undefined,
  ) => void
  fnIrSetPolicy: (first: number, sampleEvery: number) => void
  fnIrShouldVerify: (id: number) => boolean
  fnIrStats: (id: number) => {
    bails: number
    calls: number
    deoptimized: boolean
    mismatches: number
    verified: number
  }
}

let binding: FnIrBinding | undefined

export const getFnIr = (): FnIrBinding => {
  if (!binding) {
    const native = getNativeEngine() as unknown as FnIrBinding
    native.fnIrInit({
      createNullProto,
      FnRef,
      HeadersSnapshot,
      opaqueFunction,
      opaqueObject,
      opaquePrimitive,
      Partial,
    })
    binding = native
  }
  return binding
}
