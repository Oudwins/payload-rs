use crate::{Bail, Value, compile_standalone, evaluate};

fn run(src: &str, args: &[Value]) -> Result<Value, Bail> {
  let id = compile_standalone(src).unwrap_or_else(|e| panic!("{src}: {e:?}"));
  evaluate(id, args)
}

fn json(s: &str) -> Value {
  Value::from_json(&serde_json::from_str(s).unwrap())
}

fn req(user: Value) -> Value {
  Value::partial_object(vec![("user", user)])
}

fn access_args(user: Value) -> Value {
  Value::object(vec![("req", req(user))])
}

fn assert_json(v: Result<Value, Bail>, expected: &str) {
  let v = v.expect("evaluates");
  assert!(v.same_structure(&json(expected)), "{v:?} != {expected}");
}

#[test]
fn template_shapes() {
  assert_json(run("() => true", &[]), "true");
  let authed = "({ req: { user } }) => Boolean(user)";
  assert_json(run(authed, &[access_args(Value::Null)]), "false");
  assert_json(run(authed, &[access_args(json(r#"{"id":1}"#))]), "true");
  let published = "({ req: { user } }) => { if (user) { return true } return { _status: { equals: 'published' } } }";
  assert_json(run(published, &[access_args(Value::Null)]), r#"{"_status":{"equals":"published"}}"#);
  let owner = "({ req }) => { if (req.user?.id) { return { customer: { equals: req.user.id } } } return false }";
  assert_json(run(owner, &[access_args(json(r#"{"id":"abc"}"#))]), r#"{"customer":{"equals":"abc"}}"#);
  assert_json(run(owner, &[access_args(Value::Undefined)]), "false");
}

#[test]
fn nested_callbacks() {
  let check = "(allRoles = [], user) => { if (user && allRoles) { return allRoles.some((role) => { return user?.roles?.some((individualRole) => { return individualRole === role }) }) } return false }";
  assert_json(run(check, &[json(r#"["admin"]"#), json(r#"{"roles":["admin"]}"#)]), "true");
  assert_json(run(check, &[json(r#"["admin"]"#), json(r#"{"roles":["user"]}"#)]), "false");
  assert_json(run(check, &[Value::Undefined, json(r#"{"roles":["user"]}"#)]), "false");
  assert_json(run(check, &[json(r#"["admin"]"#), json(r#"{}"#)]), "false");
}

#[test]
fn partial_req_bails() {
  let f = "(args) => { const r = args.req; return r.payload.find({ collection: 'x' }) }";
  assert_eq!(run(f, &[access_args(Value::Null)]).unwrap_err(), Bail::Unknown);
}

#[test]
fn throws_bail() {
  assert_eq!(run("({ req: { user } }) => user.id", &[access_args(Value::Null)]).unwrap_err(), Bail::Throw);
  assert_eq!(run("() => { throw new Error('x') }", &[]).unwrap_err(), Bail::Throw);
}

#[test]
fn strings() {
  assert_json(
    run("({ value }) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')", &[json(r#"{"value":"  Hello World! "}"#)]),
    r#""hello-world-""#,
  );
  assert_json(run("({ value }) => `${value.length}:${value.slice(0, 2)}`", &[json(r#"{"value":"aé😀b"}"#)]), r#""5:aé""#);
}

#[test]
fn utf16_slicing() {
  // "a😀b".slice(1, 2) is a lone surrogate: JS produces it, Rust cannot represent it -> bail.
  assert!(run("(s) => s.slice(1, 2)", &[Value::str("a😀b")]).is_err());
  assert_json(run("(s) => s.slice(1, 3)", &[Value::str("a😀b")]), "\"😀\"");
  assert_json(run("(s) => s.length", &[Value::str("a😀b")]), "4");
}

#[test]
fn numbers() {
  assert_json(run("(a) => `${a / 3}`", &[Value::Number(1.0)]), "\"0.3333333333333333\"");
  assert_json(run("(a) => String(a * 1e21)", &[Value::Number(1.0)]), "\"1e+21\"");
  assert_json(run("(a) => Number(' 12 ') + a", &[Value::Number(1.0)]), "13");
  assert_json(run("() => Number('0x1f')", &[]), "31");
  assert!(matches!(run("() => Number('1e')", &[]).unwrap(), Value::Number(n) if n.is_nan()));
  assert!(matches!(run("() => Number('inf')", &[]).unwrap(), Value::Number(n) if n.is_nan()));
  assert_json(run("() => Math.round(-2.5)", &[]), "-2");
  assert!(matches!(run("() => Math.round(-0.4)", &[]).unwrap(), Value::Number(n) if n == 0.0 && n.is_sign_negative()));
}

#[test]
fn key_order() {
  assert_json(run("() => ({ b: 1, 2: 'x', a: 2, 1: 'y' })", &[]), r#"{"1":"y","2":"x","b":1,"a":2}"#);
  let v = run("() => ({ b: 1, 2: 'x', a: 2, 1: 'y' })", &[]).unwrap();
  let Value::Object(o) = v else { panic!() };
  assert_eq!(o.props.keys().map(|k| k.to_string()).collect::<Vec<_>>(), vec!["1", "2", "b", "a"]);
}

#[test]
fn switch_and_let() {
  let f = "(op) => { let r = 0; switch (op) { case 'a': r = 1; case 'b': r += 2; break; default: r = 9 } return r }";
  assert_json(run(f, &[Value::str("a")]), "3");
  assert_json(run(f, &[Value::str("b")]), "2");
  assert_json(run(f, &[Value::str("c")]), "9");
}

#[test]
fn rejects() {
  for (src, reason) in [
    ("function () { return this.x }", "this"),
    ("(a) => { for (const x of a) {} }", "loop"),
    ("({ req }) => { req.x = 1 }", "assignment to a property or pattern"),
    ("(a) => args.skipCompilation()", "opted out (skipCompilation)"),
    ("(a) => new Date()", "new expression"),
    ("({ req }) => req.payload.find({})", "reads req.payload.find"),
    ("({ req }) => req.t('x')", "reads req.t"),
    ("({ req: { i18n } }) => i18n.t('x')", "reads req.i18n"),
    ("(args) => { const { transactionID } = args.req; return transactionID }", "reads req.transactionID"),
  ] {
    assert_eq!(compile_standalone(src).unwrap_err().0, reason, "{src}");
  }
}

#[test]
fn methods_and_bundled_calls() {
  // `(0, x.y)(...)` callee form.
  let f = "(a) => (0, Object.keys)(a).length";
  assert_json(run(f, &[json(r#"{"x":1,"y":2}"#)]), "2");
  // Method shorthand source.
  assert_json(run("read({ req }) { return !!req.user }", &[access_args(json("{}"))]), "true");
  assert_json(run("async read({ req }) { return !!req.user }", &[access_args(Value::Null)]), "false");
}

#[test]
fn async_await() {
  assert_json(run("async ({ req }) => { const u = await req.user; return Boolean(u) }", &[access_args(json("{}"))]), "true");
}

#[test]
fn closures_do_not_escape() {
  // A closure returned to the caller cannot be represented: the result is a function value.
  let v = run("() => (x) => x", &[]).unwrap();
  assert!(v.to_json().is_none());
}

#[test]
fn lanes_access_args() {
  use crate::lanes::{self, RequestSnapshot};
  use payload_engine::js::JsVal;
  let id = compile_standalone("({ req: { user } }) => user ? { owner: { equals: user.id } } : false").unwrap();
  let user = Value::from_js_val(&JsVal::from_json(&serde_json::json!({ "id": 7 })));
  let req = lanes::request(&RequestSnapshot { user, ..Default::default() });
  let args = lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req.clone());
  let v = evaluate(id, &[args]).unwrap();
  assert_eq!(v.to_js_val().unwrap().to_json(), serde_json::json!({ "owner": { "equals": 7 } }));
  // Anything outside the captured request bails.
  let id = compile_standalone("(args) => { const r = args.req; return r.transactionID }").unwrap();
  let args = lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req);
  assert_eq!(evaluate(id, &[args]).unwrap_err(), Bail::Unknown);
}

#[test]
fn request_headers() {
  use crate::lanes::{self, RequestSnapshot};
  let f = "({ req }) => req.headers.get('X-Tenant') === 'a' && req.headers.has('authorization') && req.headers.get('missing') === null && req.method === 'GET'";
  let id = compile_standalone(f).unwrap();
  let headers = lanes::headers([("x-tenant", "a"), ("Authorization", "JWT x")]);
  let req = lanes::request(&RequestSnapshot { headers, method: Value::str("GET"), ..Default::default() });
  let args = lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req.clone());
  assert_json(evaluate(id, &[args]), "true");
  // Combined values, invalid names throw (bail), other members bail.
  let id = compile_standalone("({ req }) => req.headers.get('accept')").unwrap();
  let headers = lanes::headers([("Accept", "a"), ("accept", "b")]);
  let req2 = lanes::request(&RequestSnapshot { headers, ..Default::default() });
  let args = lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req2);
  assert_json(evaluate(id, &[args]), r#""a, b""#);
  let id = compile_standalone("({ req }) => req.headers.get('bad name')").unwrap();
  let args = lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req.clone());
  assert_eq!(evaluate(id, &[args]).unwrap_err(), Bail::Throw);
  let id = compile_standalone("({ req }) => req.headers.forEach").unwrap();
  let args = lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req);
  assert!(evaluate(id, &[args]).is_err());
}
