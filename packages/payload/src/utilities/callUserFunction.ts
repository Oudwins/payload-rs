/**
 * Calls a user function (access function, hook, validator) like the call expression `expr(...args)`
 * at the call site: same `this`, same arguments, same result, and V8's `TypeError` message when it
 * is not a function.
 *
 * The indirection lets the Rust engine's function compiler verify its compiled version of the
 * function against the real one at the call site (guard mode, engine-rs `compile/guard.ts`)
 * without replacing anything in the user's config. Without a guard installed it only calls.
 */
// oxlint-disable-next-line typescript/no-explicit-any
type AnyFunction = (...args: any[]) => any

export type UserFunctionGuard = (fn: AnyFunction, thisArg: unknown, args: unknown[]) => unknown

let guard: undefined | UserFunctionGuard

/** Installs (or removes, with `undefined`) the guard every user function call goes through. */
export const setUserFunctionGuard = (next: undefined | UserFunctionGuard): void => {
  guard = next
}

export const callUserFunction = <F extends AnyFunction>(
  fn: F,
  thisArg: unknown,
  args: Parameters<F>,
  expr: string,
): ReturnType<F> => {
  if (typeof fn !== 'function') {
    throw new TypeError(`${expr} is not a function`)
  }
  return (guard ? guard(fn, thisArg, args) : Reflect.apply(fn, thisArg, args)) as ReturnType<F>
}
