# Compiled user functions: contract for the fused lanes

Work package D (RUST_PERF_PLAN.md S6): users' access functions, hooks and validators compiled to an
IR evaluated in Rust, so a fused lane (FUSE_CONTRACT.md, work package A) can run an operation whose
only user JS is such functions.

| part                                   | where                                                               |
| -------------------------------------- | ------------------------------------------------------------------- |
| parser, IR, interpreter, registry      | `crates/payload-fn-ir` (`compile.rs`, `ir.rs`, `interp.rs`)         |
| lane helpers (inputs, argument shapes) | `crates/payload-fn-ir/src/lanes.rs`                                 |
| guard counters / policy                | `crates/payload-fn-ir/src/guard.rs`                                 |
| napi binding                           | `crates/payload-node/src/fn_ir.rs` (`fnIr*` exports)                |
| JS side: compile, scopes, snapshots    | `packages/engine-rs/src/compile/` (`@payloadcms/engine-rs/compile`) |
| opt-out argument                       | `packages/payload/src/utilities/skipCompilation.ts`                 |
| differential corpus, reports           | `test/__rs/fn-compile/`                                             |

## 1. Compiling (JS, at config init or on demand)

```ts
import { compileFunction, getCompiledFunction, isCompiled } from '@payloadcms/engine-rs/compile'

const compiled = compileFunction(collection.config.access.read, 'collections.posts.access.read')
// { ok: true, id, isAsync, argKeys } | { ok: false, reason }
```

- Memoized per function object (`WeakMap`); `getCompiledFunction(fn)` looks up without compiling,
  `isCompiled(fn)` also checks the function was not de-optimised.
- Identity is the guard: a lane must look the function up from the config **at call time**
  (`collection.config.access.read`). A spy or a replaced function is a different object and is not
  compiled (until compiled itself). Guard mode never touches the config (section 3).
- `id` is the `FnId` Rust evaluates. `argKeys[i]`: the top-level keys the function reads of
  argument `i` (`['req']` for `({ req: { user } }) => ...`), `null` when it may read any.
- Collection / global access in a sanitized config is Payload's `withBaseAccess` wrapper (async,
  reads `req.payload.config.baseAccess`); it compiles together with the user's function it wraps.
  Inherited `readVersions` wrappers (`createInheritedReadVersionsAccess`) do not compile (`delete`
  of a symbol key).
- Cost: about 0.1-1 ms per function (parse + inspector scope reads), paid once.

## 2. Evaluating (Rust, no JS)

```rust
use payload_fn_ir::{evaluate, guard, lanes, registry, Value};

let req = lanes::request(&lanes::RequestSnapshot {
  user: Value::from_js_val(&user),          // the authenticated user document (or Value::Null)
  locale: Value::str("en"),
  fallback_locale: Value::str("en"),
  base_access: Value::Undefined,            // req.payload.config.baseAccess (constant)
  ..Default::default()
});
let args = lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req);
if registry::is_active(id) && !guard::lane_should_verify(id) {
  match evaluate(id, &[args]) {
    Ok(result) => { /* see below */ }
    Err(_bail) => { /* run the exact lane */ }
  }
}
```

- `evaluate(id, args) -> Result<Value, Bail>`: `args` are the JS arguments (`[accessArgs]`,
  `[hookArgs]`, `[value, validateOptions]`). For an async function (and `withBaseAccess` is one) the
  value is the promise's resolution; the exact lane awaits these calls, the lane may take the value.
- A `Bail` is never a wrong answer, only "ask JS": the JS function throws here (`Bail::Throw`), an
  input outside the snapshot was read (`Unknown`), an opaque value was looked into (`Opaque`),
  unsupported semantics for these inputs (`Unsupported`), limits, or a de-optimised / missing id
  (`NotCompiled`). Errors are always produced by the exact lane.
- Results: `Value::truthy()` for access booleans; an object (`Value::Object`) is a where constraint
  in upstream's key order (`to_js_val()` / `to_json()` give `JsVal` / JSON; `None` when it holds
  something JSON / `JsVal` cannot carry, which is a bail). Access result handling stays upstream's:
  falsy -> the exact lane throws `Forbidden` (bail), `true` -> no constraint, object -> where.
- Inputs: documents and `req.user` as closed values (`Value::from_js_val` / `from_json`); `req` only
  through `lanes::request` (a partial object: reading any property other than `user`, `locale`,
  `fallbackLocale`, `context`, `query`, `headers`, `method`, `operation`,
  `payload.config.baseAccess`, `payload.config.admin.user` bails). Typed `JsVal`s (dates, bigints,
  BSON) are opaque: comparing or reading them bails. From JS (`snapshotRequest`) these properties
  are read as own data properties, the pristine Fetch `Request` getters, or through Payload's own
  `isolateObjectProperty` proxies (the GraphQL resolvers' `req`: isolated keys from the
  delegate, the rest from the target); anything else is left out (reading it bails).
- `req.headers` is a read-only snapshot (`lanes::headers(pairs)`: lower-case names, values of one
  name combined with `, ` like the Fetch `Headers` iterator): only `get(name)` (string or `null`)
  and `has(name)`, case-insensitive; an invalid header name throws in JS (bail), any other member
  bails.
- Argument shapes (`lanes.rs`) are upstream's object literals in key order, including
  `skipCompilation` (an opaque function): `collection_access_args` (`executeAccess`),
  `field_read_access_args` (afterRead field `access.read`, collection fields). The IR never sees
  `this`.
- Thread safety: `evaluate` can run on any thread (the IR is immutable in a lock-free,
  append-only registry; values are `Arc`ed; each thread reuses its own interpreter).
- Speed (release, `cargo run --release -p payload-fn-ir --example bench`, one shared core):
  `() => true` 48 ns, `({ req: { user } }) => Boolean(user)` 188 ns, `authenticatedOrPublished`
  204 ns, an inline role check plus owner constraint 1.1 us. Build the argument values once per
  request (`req` is shared by every access call of the request).

## 3. Guard mode

The real function is the authority. Two places verify:

- **Call sites** (`installCompileGuards(config)`, `compile/guard.ts`): the config is not modified.
  Payload calls every access function, hook and validator through `callUserFunction(fn, this,
  args, expr)` (payload `utilities/callUserFunction.ts`, the JS call sites of both engines), and the
  Rust core calls every JS function through `js::call`. With guards installed
  (`setUserFunctionGuard` / `fnIrSetCallGuard`) both route through `guardCall(fn, this, args)`,
  which looks `fn` up by identity: for a compiled function and the calls `fnIrShouldVerify`
  selects it evaluates the IR on a snapshot of the arguments taken before the call, calls the real
  function (same `this`, arguments, returned value / promise, errors) and compares (structural,
  key order, `-0`, `NaN`). A mismatch de-optimises the id permanently (`registry::is_active`
  becomes false) and is logged; bails are counted per function with their reason. Without guards,
  `callUserFunction` is `Reflect.apply` (with V8's `x is not a function` message for a
  non-function) and `js::call` checks one thread-local. Installed by payload's `init` when
  `PAYLOAD_FN_COMPILE_GUARD=all` (every call) or `=sample` (first 32 calls, then 1 in 256);
  counters to `PAYLOAD_FN_COMPILE_STATS=<dir>`.
- **Lanes**: `guard::lane_should_verify(id)` is true until the function has had `Policy::first`
  verified (or bailed) calls, then for one lane call in `Policy::sample_every`. On true, run the
  exact lane for this call (where the call-site guard verifies). A lane may only use a compiled
  function when guards are installed and `lane_should_verify` says false.
- On the exact lane compiled functions are only verified, never substituted: tick counts there stay
  upstream's.

## 4. Opt-out

Payload passes a no-op `skipCompilation` in the arguments of every access function (collection,
global, field), collection / global / field hook (`args.skipCompilation`) and validator
(`options.skipCompilation`). A function whose source mentions the name is never compiled. The
property is optional in the types (`skipCompilation?: () => void`): `args.skipCompilation?.()`.

## 5. Open points

- `new Date()` / `Date.now()` are rejected (the guard cannot compare a clock); hooks stamping dates
  stay JS.
- Captured `let` bindings that are reassigned later, and captured objects mutated later, are the
  stated assumption (D5); the guard catches them only on verified calls.
