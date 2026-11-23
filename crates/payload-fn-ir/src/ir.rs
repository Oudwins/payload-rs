//! The IR: a JS function body after scope resolution. Locals are frame slots, captured bindings
//! are constants (snapshots taken when the function was compiled), helpers are [`FnId`]s.

use std::sync::Arc;

use crate::value::Value;

#[derive(Debug)]
pub struct FnDef {
  /// Slots of the frame: parameters, `const` / `let` bindings and closure parameters.
  pub slots: u32,
  pub params: Vec<Param>,
  pub body: Body,
  /// Arrow function literals of this function (callbacks), sharing its frame.
  pub closures: Vec<Closure>,
  /// `async function` / `async () =>`: JS returns a promise of the result.
  pub is_async: bool,
}

#[derive(Debug)]
pub struct Closure {
  pub params: Vec<Param>,
  pub body: Body,
}

#[derive(Debug)]
pub enum Body {
  Expr(Expr),
  Block(Vec<Stmt>),
}

#[derive(Debug)]
pub struct Param {
  pub pattern: Pattern,
}

#[derive(Debug)]
pub enum Pattern {
  Slot(u32),
  Object { props: Vec<(Key, Pattern)>, rest: Option<u32> },
  Array { items: Vec<Option<Pattern>>, rest: Option<u32> },
  Default(Box<Pattern>, Box<Expr>),
}

#[derive(Debug)]
pub enum Key {
  Static(Arc<str>),
  Computed(Box<Expr>),
}

#[derive(Debug)]
pub enum Stmt {
  Expr(Expr),
  /// `const` / `let` declarations (slots start uninitialised: reading them before bails).
  Decl(Pattern, Option<Expr>),
  If(Expr, Vec<Stmt>, Vec<Stmt>),
  Block(Vec<Stmt>),
  Return(Option<Expr>),
  /// `throw ...`: the real function throws; the interpreter hands the call back to JS.
  Throw,
  Switch(Expr, Vec<(Option<Expr>, Vec<Stmt>)>),
  Break,
}

#[derive(Debug)]
pub enum Expr {
  Const(Value),
  Local(u32),
  Member { object: Box<Expr>, key: Key, optional: bool },
  Call { callee: Box<Expr>, args: Vec<Arg>, optional: bool },
  /// `receiver.name(args)` on a value (array / string / number / regexp methods).
  MethodCall { receiver: Box<Expr>, name: Arc<str>, args: Vec<Arg>, optional_member: bool, optional_call: bool },
  /// A call of an intrinsic resolved at compile time (`Boolean(x)`, `Object.keys(x)`).
  BuiltinCall { builtin: Builtin, args: Vec<Arg> },
  /// The boundary of an optional chain: a short-circuit inside yields `undefined` here.
  Chain(Box<Expr>),
  Unary(UnaryOp, Box<Expr>),
  Binary(BinaryOp, Box<Expr>, Box<Expr>),
  Logical(LogicalOp, Box<Expr>, Box<Expr>),
  Conditional(Box<Expr>, Box<Expr>, Box<Expr>),
  Template { quasis: Vec<Arc<str>>, exprs: Vec<Expr> },
  Object(Vec<Prop>),
  Array(Vec<Arg>),
  Closure(u32),
  Assign(u32, Box<Expr>),
  Sequence(Vec<Expr>),
  RegExp { source: Arc<str>, flags: Arc<str> },
  Await(Box<Expr>),
}

#[derive(Debug)]
pub enum Arg {
  Value(Expr),
  Spread(Expr),
}

#[derive(Debug)]
pub enum Prop {
  Value(Key, Expr),
  Spread(Expr),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnaryOp {
  Not,
  Neg,
  Plus,
  TypeOf,
  Void,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryOp {
  StrictEq,
  StrictNe,
  LooseEq,
  LooseNe,
  Lt,
  Le,
  Gt,
  Ge,
  Add,
  Sub,
  Mul,
  Div,
  Rem,
  In,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogicalOp {
  And,
  Or,
  Coalesce,
}

/// Intrinsics the compiler resolves free identifiers to, after the JS side checked that the
/// global (and its member) is the pristine one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Builtin {
  Boolean,
  String,
  Number,
  ArrayIsArray,
  ObjectKeys,
  ObjectValues,
  ObjectEntries,
  ObjectHasOwn,
  ObjectFreeze,
  MathMax,
  MathMin,
  MathFloor,
  MathCeil,
  MathRound,
  MathAbs,
  NumberIsInteger,
  NumberIsFinite,
  NumberIsNaN,
  IsNaN,
}

impl Builtin {
  /// The dotted global path of the intrinsic (what the JS side checks for pristineness).
  pub fn from_path(path: &str) -> Option<Builtin> {
    Some(match path {
      "Boolean" => Builtin::Boolean,
      "String" => Builtin::String,
      "Number" => Builtin::Number,
      "Array.isArray" => Builtin::ArrayIsArray,
      "Object.keys" => Builtin::ObjectKeys,
      "Object.values" => Builtin::ObjectValues,
      "Object.entries" => Builtin::ObjectEntries,
      "Object.hasOwn" => Builtin::ObjectHasOwn,
      "Object.freeze" => Builtin::ObjectFreeze,
      "Math.max" => Builtin::MathMax,
      "Math.min" => Builtin::MathMin,
      "Math.floor" => Builtin::MathFloor,
      "Math.ceil" => Builtin::MathCeil,
      "Math.round" => Builtin::MathRound,
      "Math.abs" => Builtin::MathAbs,
      "Number.isInteger" => Builtin::NumberIsInteger,
      "Number.isFinite" => Builtin::NumberIsFinite,
      "Number.isNaN" => Builtin::NumberIsNaN,
      "isNaN" => Builtin::IsNaN,
      _ => return None,
    })
  }
}

/// Global names with a constant value.
pub fn global_constant(name: &str) -> Option<Value> {
  Some(match name {
    "undefined" => Value::Undefined,
    "NaN" => Value::Number(f64::NAN),
    "Infinity" => Value::Number(f64::INFINITY),
    _ => return None,
  })
}

/// Every global path the compiler can resolve (`Boolean`, `Object.keys`, ...).
pub const BUILTIN_PATHS: &[&str] = &[
  "Boolean",
  "String",
  "Number",
  "Array.isArray",
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Object.hasOwn",
  "Object.freeze",
  "Math.max",
  "Math.min",
  "Math.floor",
  "Math.ceil",
  "Math.round",
  "Math.abs",
  "Number.isInteger",
  "Number.isFinite",
  "Number.isNaN",
  "isNaN",
];

/// Prototype methods the interpreter implements on values; the JS side checks them for
/// pristineness before anything compiles.
pub const PROTOTYPE_METHODS: &[(&str, &[&str])] = &[
  (
    "Array",
    &[
      "some", "every", "includes", "indexOf", "find", "findIndex", "filter", "map", "join", "slice", "at", "concat", "flat",
    ],
  ),
  (
    "String",
    &[
      "trim",
      "trimStart",
      "trimEnd",
      "toLowerCase",
      "toUpperCase",
      "slice",
      "substring",
      "startsWith",
      "endsWith",
      "includes",
      "indexOf",
      "replace",
      "replaceAll",
      "split",
      "charAt",
      "at",
      "padStart",
      "padEnd",
      "toString",
      "concat",
      "repeat",
    ],
  ),
  ("Number", &["toString"]),
  ("RegExp", &["test", "exec"]),
  ("Object", &["hasOwnProperty"]),
];
