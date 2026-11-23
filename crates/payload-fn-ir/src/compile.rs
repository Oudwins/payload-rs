//! `Function.prototype.toString()` text -> [`FnDef`].
//!
//! The same walker runs twice: [`analyze`] collects the free identifiers (with the static member
//! paths read through them) so the JS side can resolve them in the function's scopes, then
//! [`compile`] builds the IR with those resolutions. Anything outside the accepted subset is a
//! [`Reject`] with a reason; the function then simply stays JS.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_parser::Parser;
use oxc_span::SourceType;
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator, LogicalOperator, UnaryOperator};

use crate::FnId;
use crate::ir::{self, Arg, Body, Builtin, Closure, Expr, FnDef, Key, Param, Pattern, Prop, Stmt};
use crate::value::{Value, number_to_string};

/// Why a function does not compile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reject(pub String);

impl Reject {
  fn new(reason: impl Into<String>) -> Reject {
    Reject(reason.into())
  }
}

type R<T> = Result<T, Reject>;

/// The opt-out: a function whose source mentions this name is never compiled.
pub const OPT_OUT_NAME: &str = "skipCompilation";

/// What compiled code can read of `req` (the snapshot of
/// `packages/engine-rs/src/compile/snapshot.ts` `capturedRequest`): a static read of anything
/// else rejects the function (it would bail on every call).
pub enum Captured {
  Leaf,
  Node(&'static [(&'static str, Captured)]),
}

pub const CAPTURED_REQUEST: Captured = Captured::Node(&[
  ("context", Captured::Leaf),
  ("fallbackLocale", Captured::Leaf),
  ("locale", Captured::Leaf),
  (
    "payload",
    Captured::Node(&[(
      "config",
      Captured::Node(&[("admin", Captured::Node(&[("user", Captured::Leaf)])), ("baseAccess", Captured::Leaf)]),
    )]),
  ),
  ("query", Captured::Leaf),
  ("user", Captured::Leaf),
]);

fn captured_member(cap: &'static Captured, key: &str) -> Option<&'static Captured> {
  match cap {
    Captured::Leaf => Some(&Captured::Leaf),
    Captured::Node(list) => list.iter().find(|(k, _)| *k == key).map(|(_, c)| c),
  }
}

/// `req.a.b` (also `args.req.a.b`): the path after `req`.
fn req_path<'e>(e: &'e Expression) -> Option<Vec<&'e str>> {
  match e {
    Expression::Identifier(id) if id.name.as_str() == "req" => Some(vec![]),
    Expression::StaticMemberExpression(m) if m.property.name.as_str() == "req" => Some(vec![]),
    Expression::StaticMemberExpression(m) => {
      let mut p = req_path(&m.object)?;
      p.push(m.property.name.as_str());
      Some(p)
    }
    Expression::ParenthesizedExpression(p) => req_path(&p.expression),
    _ => None,
  }
}

fn check_req_read(path: &[&str]) -> R<()> {
  let mut cap = &CAPTURED_REQUEST;
  for (i, key) in path.iter().enumerate() {
    match captured_member(cap, key) {
      Some(Captured::Leaf) => return Ok(()),
      Some(next) => cap = next,
      None => return Err(Reject::new(format!("reads req.{}", path[..=i].join(".")))),
    }
  }
  Ok(())
}

/// Destructuring of `req` (`({ req: { payload } })`) checked like member reads.
fn check_pattern_req(pattern: &BindingPattern, cap: Option<&'static Captured>, path: &mut Vec<String>) -> R<()> {
  match pattern {
    BindingPattern::ObjectPattern(o) => {
      for p in &o.properties {
        let Some(key) = (if p.computed { None } else { p.key.static_name() }) else { continue };
        let sub = match cap {
          None if key == "req" => Some(&CAPTURED_REQUEST),
          None => None,
          Some(Captured::Leaf) => None,
          Some(c) => match captured_member(c, &key) {
            Some(Captured::Leaf) => None,
            Some(next) => Some(next),
            None => {
              path.push(key.to_string());
              return Err(Reject::new(format!("reads req.{}", path.join("."))));
            }
          },
        };
        if cap.is_some() {
          path.push(key.to_string());
        }
        check_pattern_req(&p.value, sub, path)?;
        if cap.is_some() {
          path.pop();
        }
      }
      if o.rest.is_some() && cap.is_some() {
        return Err(Reject::new("rest pattern of req"));
      }
      Ok(())
    }
    BindingPattern::AssignmentPattern(a) => check_pattern_req(&a.left, cap, path),
    BindingPattern::ArrayPattern(a) => {
      for p in a.elements.iter().flatten() {
        check_pattern_req(p, None, path)?;
      }
      Ok(())
    }
    BindingPattern::BindingIdentifier(_) => Ok(()),
  }
}

/// The member paths read through one free identifier.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PathTrie {
  /// The binding (or this member) is used as a value, not only as a base of further static
  /// member reads.
  pub used_as_value: bool,
  /// Static members read through it.
  pub members: BTreeMap<String, PathTrie>,
}

/// Result of [`analyze`].
#[derive(Clone, Debug, Default)]
pub struct Analysis {
  pub free: BTreeMap<String, PathTrie>,
  pub is_async: bool,
  /// Number of declared parameters (for the JS side to sanity-check against `fn.length`).
  pub params: usize,
  /// Top-level keys of the first parameter's object pattern, when it is one without a rest
  /// element: the only properties of the args object the function reads. `None`: it may read any.
  pub arg_keys: Vec<Option<Vec<String>>>,
}

/// How the JS side resolved a free identifier (or a member of a resolved namespace).
#[derive(Clone, Debug)]
pub enum Resolution {
  /// A primitive or a plain-data snapshot.
  Value(Value),
  /// A compiled helper.
  Function(FnId),
  /// A pristine intrinsic (`Boolean`, `Object.keys`).
  Builtin(Builtin),
  /// An object only read through static members (a module namespace, an options object).
  Namespace(HashMap<String, Resolution>),
  Unresolved(String),
}

/// Parses `source` (the text of one function) and collects its free identifiers.
pub fn analyze(source: &str) -> R<Analysis> {
  with_function(source, |func| {
    let mut walker = Walker::new(Mode::Analyze);
    walker.function(func)?;
    let arg_keys = func.params().items.iter().map(|p| top_level_keys(&p.pattern)).collect();
    Ok(Analysis {
      free: walker.free,
      is_async: func.is_async(),
      params: func.params().items.len(),
      arg_keys,
    })
  })
}

/// Compiles `source` with the resolutions of its free identifiers.
pub fn compile(source: &str, resolutions: &HashMap<String, Resolution>) -> R<FnDef> {
  with_function(source, |func| {
    let mut walker = Walker::new(Mode::Compile(resolutions));
    walker.function(func)
  })
}

fn top_level_keys(pattern: &BindingPattern) -> Option<Vec<String>> {
  match pattern {
    BindingPattern::ObjectPattern(o) if o.rest.is_none() => {
      o.properties.iter().map(|p| if p.computed { None } else { p.key.static_name().map(|s| s.to_string()) }).collect()
    }
    BindingPattern::AssignmentPattern(a) => top_level_keys(&a.left),
    _ => None,
  }
}

enum FuncRef<'s, 'a> {
  Arrow(&'s ArrowFunctionExpression<'a>),
  Function(&'s Function<'a>),
}

impl<'a> FuncRef<'_, 'a> {
  fn is_async(&self) -> bool {
    match self {
      FuncRef::Arrow(a) => a.r#async,
      FuncRef::Function(f) => f.r#async,
    }
  }
  fn params(&self) -> &FormalParameters<'a> {
    match self {
      FuncRef::Arrow(a) => &a.params,
      FuncRef::Function(f) => &f.params,
    }
  }
}

fn with_function<T>(source: &str, f: impl FnOnce(&FuncRef) -> R<T>) -> R<T> {
  if source.contains(OPT_OUT_NAME) {
    return Err(Reject::new("opted out (skipCompilation)"));
  }
  if source.contains("[native code]") {
    return Err(Reject::new("native function"));
  }
  let allocator = Allocator::default();
  // A function expression or arrow (`(...) => ...`, `function f() {}`, `async () => ...`).
  let wrapped = format!("({source}\n)");
  if let Ok(expr) = Parser::new(&allocator, &wrapped, SourceType::mjs()).parse_expression() {
    match expr.without_parentheses() {
      Expression::ArrowFunctionExpression(a) => return f(&FuncRef::Arrow(a)),
      Expression::FunctionExpression(func) => return f(&FuncRef::Function(func)),
      _ => {}
    }
  }
  // A method (`read({ req }) { ... }`, `async read() {}`, `[key]() {}`): parse it inside an
  // object literal.
  let allocator = Allocator::default();
  let wrapped = format!("({{{source}\n}})");
  let expr = Parser::new(&allocator, &wrapped, SourceType::mjs())
    .parse_expression()
    .map_err(|_| Reject::new("source does not parse as a function"))?;
  if let Expression::ObjectExpression(o) = expr.without_parentheses()
    && o.properties.len() == 1
    && let ObjectPropertyKind::ObjectProperty(p) = &o.properties[0]
  {
    if p.kind != PropertyKind::Init {
      return Err(Reject::new("accessor"));
    }
    if let Expression::FunctionExpression(func) = &p.value {
      return f(&FuncRef::Function(func));
    }
  }
  Err(Reject::new("source does not parse as a function"))
}

enum Mode<'r> {
  Analyze,
  Compile(&'r HashMap<String, Resolution>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BindingKind {
  Const,
  Mutable,
}

struct Walker<'r> {
  mode: Mode<'r>,
  free: BTreeMap<String, PathTrie>,
  scopes: Vec<HashMap<String, (u32, BindingKind)>>,
  slots: u32,
  closures: Vec<Option<Closure>>,
  /// Nesting of closure literals being compiled (they cannot `await`).
  closure_depth: u32,
  /// Inside a `switch` (where `break` is accepted).
  switch_depth: u32,
  is_async: bool,
}

/// An expression whose value is still a compile-time resolution (a namespace being read through
/// static members), or IR.
enum Compiled<'r> {
  Expr(Expr),
  Resolved(&'r Resolution),
}

impl<'r> Walker<'r> {
  fn new(mode: Mode<'r>) -> Self {
    Walker {
      mode,
      free: BTreeMap::new(),
      scopes: vec![],
      slots: 0,
      closures: vec![],
      closure_depth: 0,
      switch_depth: 0,
      is_async: false,
    }
  }

  fn function(&mut self, func: &FuncRef) -> R<FnDef> {
    let (params, body, is_async, generator) = match func {
      FuncRef::Arrow(a) => (&a.params, ArrowOrFn::Arrow(a), a.r#async, false),
      FuncRef::Function(f) => (&f.params, ArrowOrFn::Function(f), f.r#async, f.generator),
    };
    if generator {
      return Err(Reject::new("generator"));
    }
    self.is_async = is_async;
    self.scopes.push(HashMap::new());
    let params = self.params(params)?;
    let body = self.body(&body)?;
    self.scopes.pop();
    let closures = self.closures.drain(..).map(|c| c.expect("closure compiled")).collect();
    Ok(FnDef { slots: self.slots, params, body, closures, is_async })
  }

  fn params(&mut self, params: &FormalParameters) -> R<Vec<Param>> {
    if params.rest.is_some() {
      return Err(Reject::new("rest parameter"));
    }
    let mut out = vec![];
    for p in &params.items {
      check_pattern_req(&p.pattern, None, &mut vec![])?;
      let mut pattern = self.pattern(&p.pattern, BindingKind::Mutable)?;
      if let Some(init) = &p.initializer {
        let default = self.expr(init)?;
        pattern = Pattern::Default(Box::new(pattern), Box::new(default));
      }
      out.push(Param { pattern });
    }
    Ok(out)
  }

  fn body(&mut self, body: &ArrowOrFn) -> R<Body> {
    match body {
      ArrowOrFn::Arrow(a) => {
        if let Some(e) = a.get_expression() {
          Ok(Body::Expr(self.expr(e)?))
        } else {
          let b = a.get_function_body().ok_or_else(|| Reject::new("arrow body"))?;
          Ok(Body::Block(self.statements(&b.statements)?))
        }
      }
      ArrowOrFn::Function(f) => {
        let b = f.body.as_ref().ok_or_else(|| Reject::new("function without body"))?;
        Ok(Body::Block(self.statements(&b.statements)?))
      }
    }
  }

  fn declare(&mut self, name: &str, kind: BindingKind) -> R<u32> {
    if name == "arguments" || name == "eval" {
      return Err(Reject::new(format!("binding named {name}")));
    }
    let slot = self.slots;
    self.slots += 1;
    let scope = self.scopes.last_mut().expect("scope");
    if scope.contains_key(name) {
      // A redeclaration in one scope only parses for parameters / `var`: keep it simple.
      return Err(Reject::new(format!("duplicate binding {name}")));
    }
    scope.insert(name.to_string(), (slot, kind));
    Ok(slot)
  }

  fn lookup(&self, name: &str) -> Option<(u32, BindingKind)> {
    self.scopes.iter().rev().find_map(|s| s.get(name).copied())
  }

  fn pattern(&mut self, pattern: &BindingPattern, kind: BindingKind) -> R<Pattern> {
    Ok(match pattern {
      BindingPattern::BindingIdentifier(id) => Pattern::Slot(self.declare(id.name.as_str(), kind)?),
      BindingPattern::ObjectPattern(o) => {
        let mut props = vec![];
        for p in &o.properties {
          let key = self.property_key(&p.key, p.computed)?;
          let value = self.pattern(&p.value, kind)?;
          props.push((key, value));
        }
        let rest = match &o.rest {
          Some(r) => match &r.argument {
            BindingPattern::BindingIdentifier(id) => Some(self.declare(id.name.as_str(), kind)?),
            _ => return Err(Reject::new("nested rest pattern")),
          },
          None => None,
        };
        Pattern::Object { props, rest }
      }
      BindingPattern::ArrayPattern(a) => {
        let mut items = vec![];
        for item in &a.elements {
          items.push(match item {
            Some(p) => Some(self.pattern(p, kind)?),
            None => None,
          });
        }
        let rest = match &a.rest {
          Some(r) => match &r.argument {
            BindingPattern::BindingIdentifier(id) => Some(self.declare(id.name.as_str(), kind)?),
            _ => return Err(Reject::new("nested rest pattern")),
          },
          None => None,
        };
        Pattern::Array { items, rest }
      }
      BindingPattern::AssignmentPattern(a) => {
        // The default is evaluated before the binding exists (it cannot see it).
        let default = self.expr(&a.right)?;
        let inner = self.pattern(&a.left, kind)?;
        Pattern::Default(Box::new(inner), Box::new(default))
      }
    })
  }

  fn property_key(&mut self, key: &PropertyKey, computed: bool) -> R<Key> {
    if !computed {
      if let PropertyKey::PrivateIdentifier(_) = key {
        return Err(Reject::new("private name"));
      }
      if let PropertyKey::NumericLiteral(n) = key {
        return Ok(Key::Static(Arc::from(number_to_string(n.value).as_str())));
      }
      if let PropertyKey::BigIntLiteral(_) = key {
        return Err(Reject::new("bigint key"));
      }
      if let Some(name) = key.static_name() {
        return Ok(Key::Static(Arc::from(name.as_ref())));
      }
    }
    let e = key.as_expression().ok_or_else(|| Reject::new("property key"))?;
    if let Expression::StringLiteral(s) = e {
      return Ok(Key::Static(Arc::from(s.value.as_str())));
    }
    Ok(Key::Computed(Box::new(self.expr(e)?)))
  }

  fn statements(&mut self, stmts: &[Statement]) -> R<Vec<Stmt>> {
    let mut out = vec![];
    for s in stmts {
      if let Some(s) = self.statement(s)? {
        out.push(s);
      }
    }
    Ok(out)
  }

  fn block(&mut self, stmt: &Statement) -> R<Vec<Stmt>> {
    self.scopes.push(HashMap::new());
    let out = match stmt {
      Statement::BlockStatement(b) => self.statements(&b.body),
      other => Ok(self.statement(other)?.into_iter().collect()),
    };
    self.scopes.pop();
    out
  }

  fn statement(&mut self, stmt: &Statement) -> R<Option<Stmt>> {
    Ok(Some(match stmt {
      Statement::EmptyStatement(_) => return Ok(None),
      Statement::ExpressionStatement(e) => {
        // Expression statements are only useful for their side effects; the accepted ones are
        // assignments to locals (others are rejected inside `expr`).
        Stmt::Expr(self.expr(&e.expression)?)
      }
      Statement::BlockStatement(b) => {
        self.scopes.push(HashMap::new());
        let body = self.statements(&b.body)?;
        self.scopes.pop();
        Stmt::Block(body)
      }
      Statement::IfStatement(i) => {
        let test = self.expr(&i.test)?;
        let consequent = self.block(&i.consequent)?;
        let alternate = match &i.alternate {
          Some(a) => self.block(a)?,
          None => vec![],
        };
        Stmt::If(test, consequent, alternate)
      }
      Statement::ReturnStatement(r) => Stmt::Return(match &r.argument {
        Some(a) => Some(self.expr(a)?),
        None => None,
      }),
      // The real function throws: hand the call back to JS. The argument is not compiled.
      Statement::ThrowStatement(_) => Stmt::Throw,
      Statement::VariableDeclaration(d) => {
        let kind = match d.kind {
          VariableDeclarationKind::Const => BindingKind::Const,
          VariableDeclarationKind::Let => BindingKind::Mutable,
          _ => return Err(Reject::new("var / using declaration")),
        };
        let mut decls = vec![];
        for decl in &d.declarations {
          // `const x = ...x` sees the uninitialised binding (TDZ): declare first, like JS.
          check_pattern_req(&decl.id, None, &mut vec![])?;
          if let Some(init) = &decl.init
            && let Some(path) = req_path(init)
            && let BindingPattern::ObjectPattern(_) = &decl.id
          {
            // `const { a } = req.payload.config`
            let mut cap = &CAPTURED_REQUEST;
            let mut leaf = false;
            for (i, key) in path.iter().enumerate() {
              match captured_member(cap, key) {
                Some(Captured::Leaf) => {
                  leaf = true;
                  break;
                }
                Some(next) => cap = next,
                None => return Err(Reject::new(format!("reads req.{}", path[..=i].join(".")))),
              }
            }
            if !leaf {
              let mut p: Vec<String> = path.iter().map(|s| s.to_string()).collect();
              check_pattern_req(&decl.id, Some(cap), &mut p)?;
            }
          }
          let pattern = self.pattern(&decl.id, kind)?;
          let init = match &decl.init {
            Some(e) => Some(self.expr(e)?),
            None => None,
          };
          decls.push(Stmt::Decl(pattern, init));
        }
        if decls.len() == 1 { decls.pop().unwrap() } else { Stmt::Block(decls) }
      }
      Statement::SwitchStatement(s) => {
        let discriminant = self.expr(&s.discriminant)?;
        self.scopes.push(HashMap::new());
        self.switch_depth += 1;
        let mut cases = vec![];
        for c in &s.cases {
          let test = match &c.test {
            Some(t) => Some(self.expr(t)?),
            None => None,
          };
          cases.push((test, self.statements(&c.consequent)?));
        }
        self.switch_depth -= 1;
        self.scopes.pop();
        Stmt::Switch(discriminant, cases)
      }
      Statement::BreakStatement(b) if b.label.is_none() && self.switch_depth > 0 => Stmt::Break,
      Statement::ForStatement(_)
      | Statement::ForInStatement(_)
      | Statement::ForOfStatement(_)
      | Statement::WhileStatement(_)
      | Statement::DoWhileStatement(_) => return Err(Reject::new("loop")),
      Statement::TryStatement(_) => return Err(Reject::new("try statement")),
      Statement::FunctionDeclaration(_) => return Err(Reject::new("nested function declaration")),
      Statement::ClassDeclaration(_) => return Err(Reject::new("class")),
      _ => return Err(Reject::new("unsupported statement")),
    }))
  }

  fn expr(&mut self, e: &Expression) -> R<Expr> {
    match self.compiled(e)? {
      Compiled::Expr(e) => Ok(e),
      Compiled::Resolved(r) => resolution_value(r),
    }
  }

  fn free_reference(&mut self, name: &str, path: &[&str], used_as_value: bool) -> R<Compiled<'r>> {
    match &self.mode {
      Mode::Analyze => {
        let mut node = self.free.entry(name.to_string()).or_default();
        for key in path {
          node = node.members.entry(key.to_string()).or_default();
        }
        if used_as_value {
          node.used_as_value = true;
        }
        Ok(Compiled::Expr(Expr::Const(Value::Undefined)))
      }
      Mode::Compile(resolutions) => {
        let resolutions: &'r HashMap<String, Resolution> = resolutions;
        let Some(mut r) = resolutions.get(name) else {
          return Err(Reject::new(format!("unresolved identifier {name}")));
        };
        for (i, key) in path.iter().enumerate() {
          match r {
            Resolution::Namespace(members) => match members.get(*key) {
              Some(m) => r = m,
              None => return Err(Reject::new(format!("unresolved member {name}.{key}"))),
            },
            Resolution::Unresolved(reason) => return Err(Reject::new(format!("{name}: {reason}"))),
            _ => {
              // A snapshot value: the rest of the path is read at run time.
              let mut e = resolution_value(r)?;
              for k in &path[i..] {
                e = Expr::Member { object: Box::new(e), key: Key::Static(Arc::from(*k)), optional: false };
              }
              return Ok(Compiled::Expr(e));
            }
          }
        }
        if let Resolution::Unresolved(reason) = r {
          return Err(Reject::new(format!("{name}: {reason}")));
        }
        Ok(Compiled::Resolved(r))
      }
    }
  }

  /// `a.b.c` where `a` is a free identifier: the static path, if the whole chain is static.
  fn static_free_path<'e>(&self, e: &'e Expression) -> Option<(&'e str, Vec<&'e str>)> {
    let mut keys = vec![];
    let mut cur = e;
    loop {
      match cur {
        Expression::StaticMemberExpression(m) if !m.optional => {
          keys.push(m.property.name.as_str());
          cur = &m.object;
        }
        Expression::ComputedMemberExpression(m) if !m.optional => match &m.expression {
          Expression::StringLiteral(s) => {
            keys.push(s.value.as_str());
            cur = &m.object;
          }
          _ => return None,
        },
        Expression::ParenthesizedExpression(p) => cur = &p.expression,
        Expression::Identifier(id) => {
          if self.lookup(id.name.as_str()).is_some() {
            return None;
          }
          keys.reverse();
          return Some((id.name.as_str(), keys));
        }
        _ => return None,
      }
    }
  }

  fn compiled(&mut self, e: &Expression) -> R<Compiled<'r>> {
    Ok(Compiled::Expr(match e {
      Expression::BooleanLiteral(b) => Expr::Const(Value::Bool(b.value)),
      Expression::NullLiteral(_) => Expr::Const(Value::Null),
      Expression::NumericLiteral(n) => Expr::Const(Value::Number(n.value)),
      Expression::StringLiteral(s) => Expr::Const(Value::String(Arc::from(s.value.as_str()))),
      Expression::BigIntLiteral(_) => return Err(Reject::new("bigint")),
      Expression::RegExpLiteral(r) => {
        let source = r.regex.pattern.text.as_str();
        let flags = r.regex.flags.to_string();
        if flags.contains('g') || flags.contains('y') {
          // Global / sticky regexps carry `lastIndex` state; accepted only in `replace` /
          // `replaceAll` / `split`, where JS resets it (checked at run time).
        }
        if regress::Regex::with_flags(source, flags.as_str()).is_err() {
          return Err(Reject::new("regexp the engine does not support"));
        }
        Expr::RegExp { source: Arc::from(source), flags: Arc::from(flags.as_str()) }
      }
      Expression::TemplateLiteral(t) => {
        let mut quasis = vec![];
        for q in &t.quasis {
          let cooked = q.value.cooked.as_ref().ok_or_else(|| Reject::new("template escape"))?;
          if q.lone_surrogates {
            return Err(Reject::new("lone surrogate in template"));
          }
          quasis.push(Arc::from(cooked.as_str()));
        }
        let exprs = t.expressions.iter().map(|e| self.expr(e)).collect::<R<Vec<_>>>()?;
        Expr::Template { quasis, exprs }
      }
      Expression::Identifier(id) => {
        let name = id.name.as_str();
        match self.lookup(name) {
          Some((slot, _)) => Expr::Local(slot),
          None => {
            if name == "arguments" {
              return Err(Reject::new("arguments"));
            }
            return self.free_reference(name, &[], true);
          }
        }
      }
      Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_)
        if self.static_free_path(e).is_some() =>
      {
        let (name, path) = self.static_free_path(e).unwrap();
        return self.free_reference(name, &path, true);
      }
      Expression::StaticMemberExpression(m) => {
        if let Some(path) = req_path(e) {
          check_req_read(&path)?;
        }
        Expr::Member {
        object: Box::new(self.expr(&m.object)?),
        key: Key::Static(Arc::from(m.property.name.as_str())),
        optional: m.optional,
      }
      }
      Expression::ComputedMemberExpression(m) => {
        let object = Box::new(self.expr(&m.object)?);
        let key = match &m.expression {
          Expression::StringLiteral(s) => Key::Static(Arc::from(s.value.as_str())),
          other => Key::Computed(Box::new(self.expr(other)?)),
        };
        Expr::Member { object, key, optional: m.optional }
      }
      Expression::PrivateFieldExpression(_) => return Err(Reject::new("private field")),
      Expression::ChainExpression(c) => {
        let inner = match &c.expression {
          ChainElement::CallExpression(call) => self.call(call)?,
          ChainElement::TSNonNullExpression(_) => return Err(Reject::new("ts syntax")),
          other => {
            let m = other.as_member_expression().ok_or_else(|| Reject::new("chain element"))?;
            self.expr(m.as_expression_ref())?
          }
        };
        Expr::Chain(Box::new(inner))
      }
      Expression::CallExpression(call) => self.call(call)?,
      Expression::ParenthesizedExpression(p) => return self.compiled(&p.expression),
      Expression::UnaryExpression(u) => {
        let op = match u.operator {
          UnaryOperator::LogicalNot => ir::UnaryOp::Not,
          UnaryOperator::UnaryNegation => ir::UnaryOp::Neg,
          UnaryOperator::UnaryPlus => ir::UnaryOp::Plus,
          UnaryOperator::Typeof => ir::UnaryOp::TypeOf,
          UnaryOperator::Void => ir::UnaryOp::Void,
          UnaryOperator::Delete => return Err(Reject::new("delete")),
          UnaryOperator::BitwiseNot => return Err(Reject::new("bitwise operator")),
        };
        Expr::Unary(op, Box::new(self.expr(&u.argument)?))
      }
      Expression::BinaryExpression(b) => {
        let op = match b.operator {
          BinaryOperator::StrictEquality => ir::BinaryOp::StrictEq,
          BinaryOperator::StrictInequality => ir::BinaryOp::StrictNe,
          BinaryOperator::Equality => ir::BinaryOp::LooseEq,
          BinaryOperator::Inequality => ir::BinaryOp::LooseNe,
          BinaryOperator::LessThan => ir::BinaryOp::Lt,
          BinaryOperator::LessEqualThan => ir::BinaryOp::Le,
          BinaryOperator::GreaterThan => ir::BinaryOp::Gt,
          BinaryOperator::GreaterEqualThan => ir::BinaryOp::Ge,
          BinaryOperator::Addition => ir::BinaryOp::Add,
          BinaryOperator::Subtraction => ir::BinaryOp::Sub,
          BinaryOperator::Multiplication => ir::BinaryOp::Mul,
          BinaryOperator::Division => ir::BinaryOp::Div,
          BinaryOperator::Remainder => ir::BinaryOp::Rem,
          BinaryOperator::In => ir::BinaryOp::In,
          BinaryOperator::Instanceof => return Err(Reject::new("instanceof")),
          _ => return Err(Reject::new("bitwise / exponent operator")),
        };
        Expr::Binary(op, Box::new(self.expr(&b.left)?), Box::new(self.expr(&b.right)?))
      }
      Expression::LogicalExpression(l) => {
        let op = match l.operator {
          LogicalOperator::And => ir::LogicalOp::And,
          LogicalOperator::Or => ir::LogicalOp::Or,
          LogicalOperator::Coalesce => ir::LogicalOp::Coalesce,
        };
        Expr::Logical(op, Box::new(self.expr(&l.left)?), Box::new(self.expr(&l.right)?))
      }
      Expression::ConditionalExpression(c) => Expr::Conditional(
        Box::new(self.expr(&c.test)?),
        Box::new(self.expr(&c.consequent)?),
        Box::new(self.expr(&c.alternate)?),
      ),
      Expression::ObjectExpression(o) => {
        let mut props = vec![];
        for p in &o.properties {
          match p {
            ObjectPropertyKind::ObjectProperty(p) => {
              if p.kind != PropertyKind::Init || p.method {
                return Err(Reject::new("method / accessor in object literal"));
              }
              let key = self.property_key(&p.key, p.computed)?;
              if let Key::Static(k) = &key
                && &**k == "__proto__"
                && !p.computed
                && !p.shorthand
              {
                return Err(Reject::new("__proto__ in object literal"));
              }
              props.push(Prop::Value(key, self.expr(&p.value)?));
            }
            ObjectPropertyKind::SpreadProperty(s) => props.push(Prop::Spread(self.expr(&s.argument)?)),
          }
        }
        Expr::Object(props)
      }
      Expression::ArrayExpression(a) => {
        let mut items = vec![];
        for el in &a.elements {
          match el {
            ArrayExpressionElement::SpreadElement(s) => items.push(Arg::Spread(self.expr(&s.argument)?)),
            ArrayExpressionElement::Elision(_) => return Err(Reject::new("array hole")),
            other => items.push(Arg::Value(self.expr(other.as_expression().expect("expression"))?)),
          }
        }
        Expr::Array(items)
      }
      Expression::ArrowFunctionExpression(a) => self.closure(&a.params, ArrowOrFn::Arrow(a), a.r#async)?,
      Expression::FunctionExpression(f) => {
        if f.generator {
          return Err(Reject::new("generator"));
        }
        if f.id.is_some() {
          return Err(Reject::new("named function expression"));
        }
        self.closure(&f.params, ArrowOrFn::Function(f), f.r#async)?
      }
      Expression::AssignmentExpression(a) => self.assignment(a)?,
      Expression::SequenceExpression(s) => Expr::Sequence(s.expressions.iter().map(|e| self.expr(e)).collect::<R<_>>()?),
      Expression::AwaitExpression(a) => {
        if !self.is_async || self.closure_depth > 0 {
          return Err(Reject::new("await outside the function's own body"));
        }
        Expr::Await(Box::new(self.expr(&a.argument)?))
      }
      Expression::ThisExpression(_) => return Err(Reject::new("this")),
      Expression::NewExpression(_) => return Err(Reject::new("new expression")),
      Expression::UpdateExpression(_) => return Err(Reject::new("update expression")),
      Expression::TaggedTemplateExpression(_) => return Err(Reject::new("tagged template")),
      Expression::ClassExpression(_) => return Err(Reject::new("class")),
      Expression::ImportExpression(_) | Expression::ImportMeta(_) => return Err(Reject::new("import")),
      Expression::YieldExpression(_) => return Err(Reject::new("yield")),
      Expression::Super(_) | Expression::NewTarget(_) => return Err(Reject::new("super / new.target")),
      _ => return Err(Reject::new("unsupported expression")),
    }))
  }

  fn closure(&mut self, params: &FormalParameters, body: ArrowOrFn, is_async: bool) -> R<Expr> {
    if is_async {
      return Err(Reject::new("async callback"));
    }
    let id = self.closures.len() as u32;
    self.closures.push(None);
    self.scopes.push(HashMap::new());
    self.closure_depth += 1;
    let switch_depth = std::mem::replace(&mut self.switch_depth, 0);
    let params = self.params(params);
    let body = params.and_then(|p| Ok((p, self.body(&body)?)));
    self.switch_depth = switch_depth;
    self.closure_depth -= 1;
    self.scopes.pop();
    let (params, body) = body?;
    self.closures[id as usize] = Some(Closure { params, body });
    Ok(Expr::Closure(id))
  }

  fn assignment(&mut self, a: &AssignmentExpression) -> R<Expr> {
    let AssignmentTarget::AssignmentTargetIdentifier(id) = &a.left else {
      return Err(Reject::new("assignment to a property or pattern"));
    };
    let name = id.name.as_str();
    let Some((slot, kind)) = self.lookup(name) else {
      return Err(Reject::new(format!("assignment to captured binding {name}")));
    };
    if kind == BindingKind::Const {
      return Err(Reject::new("assignment to const"));
    }
    let right = self.expr(&a.right)?;
    let binary = |op, right| Expr::Assign(slot, Box::new(Expr::Binary(op, Box::new(Expr::Local(slot)), Box::new(right))));
    let logical =
      |op, right| Expr::Logical(op, Box::new(Expr::Local(slot)), Box::new(Expr::Assign(slot, Box::new(right))));
    Ok(match a.operator {
      AssignmentOperator::Assign => Expr::Assign(slot, Box::new(right)),
      AssignmentOperator::Addition => binary(ir::BinaryOp::Add, right),
      AssignmentOperator::Subtraction => binary(ir::BinaryOp::Sub, right),
      AssignmentOperator::Multiplication => binary(ir::BinaryOp::Mul, right),
      AssignmentOperator::Division => binary(ir::BinaryOp::Div, right),
      AssignmentOperator::Remainder => binary(ir::BinaryOp::Rem, right),
      AssignmentOperator::LogicalOr => logical(ir::LogicalOp::Or, right),
      AssignmentOperator::LogicalAnd => logical(ir::LogicalOp::And, right),
      AssignmentOperator::LogicalNullish => logical(ir::LogicalOp::Coalesce, right),
      _ => return Err(Reject::new("bitwise assignment")),
    })
  }

  fn args(&mut self, args: &[Argument]) -> R<Vec<Arg>> {
    args
      .iter()
      .map(|a| match a {
        Argument::SpreadElement(s) => Ok(Arg::Spread(self.expr(&s.argument)?)),
        other => Ok(Arg::Value(self.expr(other.as_expression().expect("expression"))?)),
      })
      .collect()
  }

  fn call(&mut self, call: &CallExpression) -> R<Expr> {
    let callee = call.callee.without_parentheses();
    // `(0, ns.fn)(...)`: the bundler / vite SSR form of an imported call.
    let callee = match callee {
      Expression::SequenceExpression(s)
        if s.expressions.len() == 2 && matches!(s.expressions[0], Expression::NumericLiteral(_)) =>
      {
        s.expressions[1].without_parentheses()
      }
      other => other,
    };
    // `free.a.b(...)`: resolve the callee statically (a namespace member, an intrinsic) when the
    // JS side resolved it as one; a method call on a snapshot value otherwise.
    if let Some((name, path)) = self.static_free_path(callee) {
      if let Mode::Analyze = self.mode {
        // Record the callee path as a value use; the JS side decides whether it is a function
        // (namespace member) or a method of a snapshot value.
        self.free_reference(name, &path, true)?;
        let args = self.args(&call.arguments)?;
        return Ok(Expr::Call { callee: Box::new(Expr::Const(Value::Undefined)), args, optional: call.optional });
      }
      if let Some((last, base)) = path.split_last() {
        // Resolve the receiver; if it stays a namespace, the member is the function itself.
        let receiver = self.free_reference(name, base, false)?;
        match receiver {
          Compiled::Resolved(Resolution::Namespace(members)) => {
            let member = members.get(*last).ok_or_else(|| Reject::new(format!("unresolved member {last}")))?;
            let args = self.args(&call.arguments)?;
            return self.call_resolved(member, args, call.optional);
          }
          Compiled::Resolved(r) => {
            let receiver = resolution_value(r)?;
            // A captured receiver whose method is known not to compile would bail on every call.
            match &receiver {
              Expr::Const(Value::Opaque(_)) => {
                return Err(Reject::new(format!("calls {name}.{last}: an opaque value")));
              }
              Expr::Const(Value::Object(o))
                if matches!(o.props.get(*last), Some(Value::Opaque(_))) =>
              {
                return Err(Reject::new(format!("calls {name}.{last}, which does not compile")));
              }
              _ => {}
            }
            let args = self.args(&call.arguments)?;
            return Ok(Expr::MethodCall {
              receiver: Box::new(receiver),
              name: Arc::from(*last),
              args,
              optional_member: false,
              optional_call: call.optional,
            });
          }
          Compiled::Expr(receiver) => {
            let args = self.args(&call.arguments)?;
            return Ok(Expr::MethodCall {
              receiver: Box::new(receiver),
              name: Arc::from(*last),
              args,
              optional_member: false,
              optional_call: call.optional,
            });
          }
        }
      }
      let resolved = self.free_reference(name, &[], true)?;
      let args = self.args(&call.arguments)?;
      return match resolved {
        Compiled::Resolved(r) => self.call_resolved(r, args, call.optional),
        Compiled::Expr(e) => Ok(Expr::Call { callee: Box::new(e), args, optional: call.optional }),
      };
    }
    match callee {
      Expression::StaticMemberExpression(m) => {
        if let Some(path) = req_path(callee) {
          check_req_read(&path)?;
        }
        let receiver = self.expr(&m.object)?;
        let args = self.args(&call.arguments)?;
        Ok(Expr::MethodCall {
          receiver: Box::new(receiver),
          name: Arc::from(m.property.name.as_str()),
          args,
          optional_member: m.optional,
          optional_call: call.optional,
        })
      }
      Expression::ComputedMemberExpression(_) => Err(Reject::new("computed method call")),
      _ => {
        let callee = self.expr(callee)?;
        let args = self.args(&call.arguments)?;
        Ok(Expr::Call { callee: Box::new(callee), args, optional: call.optional })
      }
    }
  }

  fn call_resolved(&mut self, r: &Resolution, args: Vec<Arg>, optional: bool) -> R<Expr> {
    match r {
      Resolution::Value(Value::Opaque(_)) => Err(Reject::new("calls a captured function that does not compile")),
      Resolution::Builtin(b) => {
        if args.iter().any(|a| matches!(a, Arg::Spread(_))) {
          return Err(Reject::new("spread into an intrinsic"));
        }
        Ok(Expr::BuiltinCall { builtin: *b, args })
      }
      other => Ok(Expr::Call { callee: Box::new(resolution_value(other)?), args, optional }),
    }
  }
}

enum ArrowOrFn<'s, 'a> {
  Arrow(&'s ArrowFunctionExpression<'a>),
  Function(&'s Function<'a>),
}

fn resolution_value(r: &Resolution) -> R<Expr> {
  Ok(match r {
    Resolution::Value(v) => Expr::Const(v.clone()),
    Resolution::Function(id) => Expr::Const(Value::Func(crate::value::Callable::Fn(*id))),
    Resolution::Builtin(b) => Expr::Const(Value::Func(crate::value::Callable::Builtin(*b))),
    Resolution::Namespace(_) => return Err(Reject::new("namespace used as a value")),
    Resolution::Unresolved(reason) => return Err(Reject::new(reason.clone())),
  })
}

/// Names of every free identifier, for diagnostics.
pub fn free_names(a: &Analysis) -> BTreeSet<String> {
  a.free.keys().cloned().collect()
}

trait AsExpressionRef<'a> {
  fn as_expression_ref(&self) -> &Expression<'a>;
}

impl<'a> AsExpressionRef<'a> for MemberExpression<'a> {
  fn as_expression_ref(&self) -> &Expression<'a> {
    self.as_expression()
  }
}
