/**
 * Passed to every access function, hook and validator as `skipCompilation` (access functions and
 * hooks: `args.skipCompilation`; validators: `options.skipCompilation`).
 *
 * The Rust engine compiles simple, pure access functions, hooks and validators to an IR it
 * evaluates without calling into JS (guarded: the real function stays the authority while
 * compiled results are verified). A function that mentions `skipCompilation` anywhere in its
 * source, typically by calling `args.skipCompilation?.()`, is never compiled and always runs as
 * the JS function. At run time it does nothing.
 */
export const skipCompilation = (): void => {}

/** The `skipCompilation` property of the arguments of access functions, hooks and validators. */
export type SkipCompilationArg = {
  /**
   * Opts this function out of compilation by the Rust engine: calling it (or mentioning it
   * anywhere in the function) keeps the function in JS. Does nothing at run time.
   *
   * @example
   * const read: Access = (args) => {
   *   args.skipCompilation?.()
   *   return Boolean(args.req.user)
   * }
   */
  skipCompilation?: () => void
}
