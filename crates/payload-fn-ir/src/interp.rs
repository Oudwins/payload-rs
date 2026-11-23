//! The IR interpreter. Every operation either computes exactly what JS computes for the same
//! inputs, or bails (the caller then runs the real JS function).

use std::sync::Arc;

use crate::builtins;
use crate::ir::{Arg, Body, Builtin, Closure, Expr, FnDef, Key, LogicalOp, Param, Pattern, Prop, Stmt, UnaryOp};
use crate::value::{Callable, Object, OpaqueKind, Value, array_index};
use crate::{Bail, FnId, registry};

const MAX_DEPTH: usize = 64;

type R<T> = Result<T, Bail>;

pub(crate) struct Interp {
  frames: Vec<Frame>,
  /// The slots of every frame, one contiguous stack (a frame's start is `Frame::base`).
  stack: Vec<Option<Value>>,
  next_frame: u64,
}

struct Frame {
  id: u64,
  def: &'static registry::Installed,
  base: usize,
}

enum Flow {
  Normal,
  Return(Value),
  Break,
}

impl Interp {
  pub(crate) fn new() -> Self {
    Interp { frames: Vec::with_capacity(8), stack: Vec::with_capacity(64), next_frame: 0 }
  }

  /// Calls compiled function `id` with `args`; a promise result (an async helper's, or an async
  /// function's own) is unwrapped: every Payload call site awaits the result.
  pub(crate) fn call_top(&mut self, installed: &'static registry::Installed, args: &[Value]) -> R<Value> {
    let v = self.call_installed(installed, args)?;
    Ok(match v {
      Value::Promise(inner) => (*inner).clone(),
      other => other,
    })
  }

  fn call_fn(&mut self, id: FnId, args: &[Value]) -> R<Value> {
    if self.frames.len() >= MAX_DEPTH {
      return Err(Bail::Limit);
    }
    let installed = registry::installed(id).ok_or(Bail::NotCompiled)?;
    self.call_installed(installed, args)
  }

  fn call_installed(&mut self, installed: &'static registry::Installed, args: &[Value]) -> R<Value> {
    if self.frames.len() >= MAX_DEPTH {
      return Err(Bail::Limit);
    }
    let def: &FnDef = &installed.def;
    let base = self.stack.len();
    self.stack.resize(base + def.slots as usize, None);
    let frame = Frame { id: self.next_frame, base, def: installed };
    self.next_frame += 1;
    self.frames.push(frame);
    let result = self.run_function(args);
    self.frames.pop();
    self.stack.truncate(base);
    let value = result?;
    if installed.def.is_async {
      if let Value::Promise(_) = value {
        // `return promise` from an async function adopts it.
        return Ok(value);
      }
      return Ok(Value::Promise(Arc::new(value)));
    }
    Ok(value)
  }

  fn def(&self) -> &'static registry::Installed {
    self.frames.last().expect("frame").def
  }

  fn run_function(&mut self, args: &[Value]) -> R<Value> {
    let installed = self.def();
    let def = &installed.def;
    self.bind_params(&def.params, args)?;
    self.run_body(&def.body)
  }

  fn bind_params(&mut self, params: &[Param], args: &[Value]) -> R<()> {
    for (i, p) in params.iter().enumerate() {
      let v = args.get(i).cloned().unwrap_or(Value::Undefined);
      self.bind(&p.pattern, v)?;
    }
    Ok(())
  }

  fn run_body(&mut self, body: &Body) -> R<Value> {
    match body {
      Body::Expr(e) => self.eval(e),
      Body::Block(stmts) => match self.stmts(stmts)? {
        Flow::Return(v) => Ok(v),
        Flow::Normal => Ok(Value::Undefined),
        Flow::Break => Err(Bail::Unsupported("break outside switch")),
      },
    }
  }

  fn slot(&mut self, slot: u32) -> &mut Option<Value> {
    let base = self.frames.last().expect("frame").base;
    &mut self.stack[base + slot as usize]
  }

  /// Ready for the next top-level evaluation (a reused interpreter).
  pub(crate) fn reset(&mut self) {
    self.frames.clear();
    self.stack.clear();
  }

  fn bind(&mut self, pattern: &Pattern, value: Value) -> R<()> {
    match pattern {
      Pattern::Slot(s) => {
        *self.slot(*s) = Some(value);
        Ok(())
      }
      Pattern::Default(inner, default) => {
        let v = if matches!(value, Value::Undefined) { self.eval(default)? } else { value };
        self.bind(inner, v)
      }
      Pattern::Object { props, rest } => {
        if value.is_nullish() {
          return Err(Bail::Throw);
        }
        // The keys read are only kept when a rest element needs them.
        let mut used = if rest.is_some() { Some(vec![]) } else { None };
        for (key, p) in props {
          let v = match key {
            Key::Static(k) => {
              let v = builtins::get(&value, k)?;
              if let Some(used) = &mut used {
                used.push(k.clone());
              }
              v
            }
            Key::Computed(_) => {
              let k = self.key(key)?;
              let v = builtins::get(&value, &k)?;
              if let Some(used) = &mut used {
                used.push(k);
              }
              v
            }
          };
          self.bind(p, v)?;
        }
        let used = used.unwrap_or_default();
        if let Some(rest) = rest {
          let Value::Object(o) = &value else { return Err(Bail::Unsupported("object rest of a non-object")) };
          if !o.closed {
            return Err(Bail::Unknown);
          }
          let mut out = Object::closed();
          for (k, v) in &o.props {
            if !used.iter().any(|u| u == k) {
              out.set(k.clone(), v.clone());
            }
          }
          *self.slot(*rest) = Some(Value::Object(Arc::new(out)));
        }
        Ok(())
      }
      Pattern::Array { items, rest } => {
        let Value::Array(a) = &value else { return Err(Bail::Unsupported("array pattern of a non-array")) };
        for (i, item) in items.iter().enumerate() {
          if let Some(p) = item {
            self.bind(p, a.get(i).cloned().unwrap_or(Value::Undefined))?;
          }
        }
        if let Some(rest) = rest {
          let tail = a.iter().skip(items.len()).cloned().collect();
          *self.slot(*rest) = Some(Value::Array(Arc::new(tail)));
        }
        Ok(())
      }
    }
  }

  fn key(&mut self, key: &Key) -> R<Arc<str>> {
    match key {
      Key::Static(k) => Ok(k.clone()),
      Key::Computed(e) => {
        let v = self.eval(e)?;
        builtins::to_property_key(&v)
      }
    }
  }

  fn stmts(&mut self, stmts: &[Stmt]) -> R<Flow> {
    for s in stmts {
      match self.stmt(s)? {
        Flow::Normal => {}
        other => return Ok(other),
      }
    }
    Ok(Flow::Normal)
  }

  fn stmt(&mut self, stmt: &Stmt) -> R<Flow> {
    match stmt {
      Stmt::Expr(e) => {
        self.eval(e)?;
        Ok(Flow::Normal)
      }
      Stmt::Decl(pattern, init) => {
        let v = match init {
          Some(e) => self.eval(e)?,
          None => Value::Undefined,
        };
        self.bind(pattern, v)?;
        Ok(Flow::Normal)
      }
      Stmt::If(test, consequent, alternate) => {
        if self.eval(test)?.truthy()? { self.stmts(consequent) } else { self.stmts(alternate) }
      }
      Stmt::Block(b) => self.stmts(b),
      Stmt::Return(e) => Ok(Flow::Return(match e {
        Some(e) => self.eval(e)?,
        None => Value::Undefined,
      })),
      Stmt::Throw => Err(Bail::Throw),
      Stmt::Break => Ok(Flow::Break),
      Stmt::Switch(discriminant, cases) => {
        let d = self.eval(discriminant)?;
        let mut start = None;
        for (i, (test, _)) in cases.iter().enumerate() {
          if let Some(t) = test {
            let v = self.eval(t)?;
            if builtins::strict_equals(&d, &v)? {
              start = Some(i);
              break;
            }
          }
        }
        if start.is_none() {
          start = cases.iter().position(|(t, _)| t.is_none());
        }
        if let Some(start) = start {
          for (_, body) in &cases[start..] {
            match self.stmts(body)? {
              Flow::Normal => {}
              Flow::Break => return Ok(Flow::Normal),
              ret @ Flow::Return(_) => return Ok(ret),
            }
          }
        }
        Ok(Flow::Normal)
      }
    }
  }

  pub(crate) fn eval(&mut self, e: &Expr) -> R<Value> {
    match e {
      Expr::Const(v) => Ok(v.clone()),
      Expr::Local(s) => self.slot(*s).clone().ok_or(Bail::Throw),
      Expr::Member { object, key, optional } => {
        let o = self.eval(object)?;
        if *optional && o.is_nullish() {
          return Err(Bail::ShortCircuit);
        }
        match key {
          Key::Static(k) => builtins::get(&o, k),
          Key::Computed(_) => {
            let k = self.key(key)?;
            builtins::get(&o, &k)
          }
        }
      }
      Expr::Chain(inner) => match self.eval(inner) {
        Err(Bail::ShortCircuit) => Ok(Value::Undefined),
        other => other,
      },
      Expr::Call { callee, args, optional } => {
        let f = self.eval(callee)?;
        if *optional && f.is_nullish() {
          return Err(Bail::ShortCircuit);
        }
        let args = self.args(args)?;
        self.call_value(&f, &args)
      }
      Expr::MethodCall { receiver, name, args, optional_member, optional_call } => {
        let r = self.eval(receiver)?;
        if *optional_member && r.is_nullish() {
          return Err(Bail::ShortCircuit);
        }
        if *optional_call && !builtins::has_method(&r, name)? {
          return Err(Bail::ShortCircuit);
        }
        let args = self.args(args)?;
        self.method(&r, name, &args)
      }
      Expr::BuiltinCall { builtin, args } => {
        let args = self.args(args)?;
        builtins::call_builtin(*builtin, &args)
      }
      Expr::Unary(op, arg) => {
        let v = self.eval(arg)?;
        Ok(match op {
          UnaryOp::Not => Value::Bool(!v.truthy()?),
          UnaryOp::Neg => Value::Number(-builtins::to_number(&v)?),
          UnaryOp::Plus => Value::Number(builtins::to_number(&v)?),
          UnaryOp::TypeOf => Value::str(v.type_of()?),
          UnaryOp::Void => Value::Undefined,
        })
      }
      Expr::Binary(op, l, r) => {
        let l = self.eval(l)?;
        let r = self.eval(r)?;
        builtins::binary(*op, &l, &r)
      }
      Expr::Logical(op, l, r) => {
        let lv = self.eval(l)?;
        let take_left = match op {
          LogicalOp::And => !lv.truthy()?,
          LogicalOp::Or => lv.truthy()?,
          LogicalOp::Coalesce => !lv.is_nullish(),
        };
        if take_left { Ok(lv) } else { self.eval(r) }
      }
      Expr::Conditional(t, c, a) => {
        if self.eval(t)?.truthy()? {
          self.eval(c)
        } else {
          self.eval(a)
        }
      }
      Expr::Template { quasis, exprs } => {
        let mut out = String::from(&*quasis[0]);
        for (i, e) in exprs.iter().enumerate() {
          let v = self.eval(e)?;
          out.push_str(&builtins::to_string(&v)?);
          out.push_str(&quasis[i + 1]);
        }
        Ok(Value::String(Arc::from(out.as_str())))
      }
      Expr::Object(props) => {
        let mut o = Object::closed();
        for p in props {
          match p {
            Prop::Value(key, value) => {
              let k = self.key(key)?;
              let v = self.eval(value)?;
              o.set(k, v);
            }
            Prop::Spread(e) => {
              let v = self.eval(e)?;
              builtins::spread_into_object(&mut o, &v)?;
            }
          }
        }
        Ok(Value::Object(Arc::new(o)))
      }
      Expr::Array(items) => Ok(Value::Array(Arc::new(self.args(items)?))),
      Expr::Closure(id) => {
        let frame = self.frames.last().expect("frame").id;
        Ok(Value::Func(Callable::Closure { frame, closure: *id }))
      }
      Expr::Assign(slot, value) => {
        let v = self.eval(value)?;
        let s = self.slot(*slot);
        if s.is_none() {
          // A `let` assigned before its declaration ran (TDZ).
          return Err(Bail::Throw);
        }
        *s = Some(v.clone());
        Ok(v)
      }
      Expr::Sequence(items) => {
        let mut last = Value::Undefined;
        for i in items {
          last = self.eval(i)?;
        }
        Ok(last)
      }
      Expr::RegExp { source, flags } => builtins::regexp(source, flags),
      Expr::Await(inner) => {
        let v = self.eval(inner)?;
        match v {
          Value::Promise(inner) => Ok((*inner).clone()),
          Value::Object(o) if o.has("then") || !o.closed => Err(Bail::Unsupported("await of a thenable")),
          Value::Opaque(OpaqueKind::Object | OpaqueKind::Function) | Value::Func(_) => {
            Err(Bail::Unsupported("await of an opaque object"))
          }
          other => Ok(other),
        }
      }
    }
  }

  fn args(&mut self, args: &[Arg]) -> R<Vec<Value>> {
    let mut out = Vec::with_capacity(args.len());
    for a in args {
      match a {
        Arg::Value(e) => out.push(self.eval(e)?),
        Arg::Spread(e) => {
          let v = self.eval(e)?;
          builtins::spread_into_list(&mut out, &v)?;
        }
      }
    }
    Ok(out)
  }

  pub(crate) fn call_value(&mut self, f: &Value, args: &[Value]) -> R<Value> {
    match f {
      Value::Func(c) => self.call_callable(c, args),
      Value::Opaque(_) => Err(Bail::Opaque),
      // Calling a non-function throws a TypeError.
      _ => Err(Bail::Throw),
    }
  }

  pub(crate) fn call_callable(&mut self, c: &Callable, args: &[Value]) -> R<Value> {
    match c {
      Callable::Fn(id) => self.call_fn(*id, args),
      Callable::Builtin(b) => builtins::call_builtin(*b, args),
      Callable::Closure { frame, closure } => {
        let current = self.frames.last().expect("frame");
        if current.id != *frame {
          return Err(Bail::Unsupported("closure called outside its frame"));
        }
        let installed = current.def;
        let Closure { params, body } = &installed.def.closures[*closure as usize];
        self.bind_params(params, args)?;
        self.run_body(body)
      }
    }
  }

  fn method(&mut self, receiver: &Value, name: &str, args: &[Value]) -> R<Value> {
    if let Value::Object(o) = receiver
      && let Some(f) = o.get(name)
    {
      let f = f.clone();
      return self.call_value(&f, args);
    }
    builtins::method(self, receiver, name, args)
  }
}

/// Calls `callback(element, index, array)` the way array methods do.
pub(crate) fn call_callback(interp: &mut Interp, callback: &Value, args: &[Value]) -> R<Value> {
  match callback {
    Value::Func(c) => interp.call_callable(c, args),
    Value::Opaque(_) => Err(Bail::Opaque),
    _ => Err(Bail::Throw),
  }
}

pub(crate) fn builtin_of(v: &Value) -> Option<Builtin> {
  match v {
    Value::Func(Callable::Builtin(b)) => Some(*b),
    _ => None,
  }
}

pub(crate) fn index_key(k: &str) -> Option<usize> {
  array_index(k).map(|i| i as usize)
}
