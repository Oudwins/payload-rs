/**
 * The compiled-function hook of the fused lanes (FUSE_CONTRACT.md section 2): work package D
 * (crates/payload-fn-ir, packages/engine-rs/src/compile) provides which user functions are
 * compiled and how to evaluate them from Rust. Until then every user function keeps its
 * operation on the exact lane.
 */
export const isCompiledAccess = (_access: unknown): boolean => false
