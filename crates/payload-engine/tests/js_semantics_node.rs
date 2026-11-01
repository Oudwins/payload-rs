//! Differential fuzz tests of the JS value semantics in `payload_engine::js` against node
//! (`Number.prototype.toString`, `Date.prototype.toString`). Requires `node` on `PATH`.

use std::io::Write;
use std::process::{Command, Stdio};

use payload_engine::js::{date_to_js_string, num_to_js_string};

unsafe extern "C" {
  fn tzset();
}

/// Runs `script` in node with one input value per line on stdin and returns its output lines.
fn node_lines(script: &str, input: &[String], tz: Option<&str>) -> Vec<String> {
  let mut command = Command::new("node");
  command.arg("-e").arg(script).stdin(Stdio::piped()).stdout(Stdio::piped());
  if let Some(tz) = tz {
    command.env("TZ", tz);
  }
  let mut child = command.spawn().expect("these tests compare against node: `node` must be on PATH");
  let mut stdin = child.stdin.take().expect("stdin");
  let text = input.join("\n");
  let writer = std::thread::spawn(move || stdin.write_all(text.as_bytes()).expect("write to node"));
  let output = child.wait_with_output().expect("node output");
  writer.join().expect("writer thread");
  assert!(output.status.success(), "node failed");
  String::from_utf8(output.stdout).expect("utf-8").lines().map(str::to_string).collect()
}

const READ_LINES: &str = "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');";

/// xorshift64*, deterministic so failures reproduce.
struct Rng(u64);

impl Rng {
  fn next(&mut self) -> u64 {
    self.0 ^= self.0 >> 12;
    self.0 ^= self.0 << 25;
    self.0 ^= self.0 >> 27;
    self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
  }

  fn unit(&mut self) -> f64 {
    (self.next() >> 11) as f64 / (1u64 << 53) as f64
  }
}

fn number_cases() -> Vec<f64> {
  let mut cases = vec![
    0.0,
    -0.0,
    f64::NAN,
    f64::INFINITY,
    f64::NEG_INFINITY,
    f64::MIN_POSITIVE,
    f64::MAX,
    f64::MIN,
    f64::EPSILON,
    5e-324,
    1e-7,
    1.5e-7,
    1e-6,
    0.000001234,
    1e20,
    1e21,
    1.5e21,
    123456789012345680000.0,
    9007199254740992.0,
    9007199254740993.0,
    0.1,
    0.2 + 0.1,
    1.0 / 3.0,
    -1e-7,
    -1e21,
    100.0,
    1e100,
    4.35,
    0.5e-6,
  ];
  for exponent in -330..=310 {
    let p = 10f64.powi(exponent);
    cases.extend([p, -p, p * 1.5, f64::from_bits(p.to_bits() + 1), f64::from_bits(p.to_bits().saturating_sub(1))]);
  }
  let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
  for _ in 0..60_000 {
    let bits = rng.next();
    let random_bits = f64::from_bits(bits);
    cases.push(random_bits);
    cases.push((rng.unit() * 1e6).round() / 1e3);
    cases.push(rng.unit() * 10f64.powi((rng.next() % 60) as i32 - 30));
    cases.push(((rng.next() % (1 << 60)) as f64) * if bits & 1 == 0 { 1.0 } else { -1.0 });
    // values with few binary fraction digits, where two shortest candidates can tie
    let fraction = [0.5, 0.25, 0.75, 0.125, 0.375, 0.0625][(rng.next() % 6) as usize];
    cases.push((rng.next() % (1 << (rng.next() % 52 + 1))) as f64 + fraction);
    cases.push(f64::from_bits((rng.next() % 0x7fe + 1) << 52 | (rng.next() % 64) << 46));
  }
  cases
}

#[test]
fn num_to_js_string_matches_node() {
  let cases = number_cases();
  let input: Vec<String> = cases.iter().map(|n| n.to_bits().to_string()).collect();
  let script = format!(
    "{READ_LINES} const view = new DataView(new ArrayBuffer(8)); const out = []; for (const line of lines) {{ if (!line) continue; view.setBigUint64(0, BigInt(line)); out.push(String(view.getFloat64(0))) }} process.stdout.write(out.join('\\n') + '\\n')"
  );
  let expected = node_lines(&script, &input, None);
  assert_eq!(expected.len(), cases.len());
  let mismatches: Vec<_> = cases
    .iter()
    .zip(&expected)
    .filter(|(n, js)| num_to_js_string(**n) != **js)
    .map(|(n, js)| format!("{n:?} (bits {}): rust {} vs node {js}", n.to_bits(), num_to_js_string(*n)))
    .collect();
  assert!(mismatches.is_empty(), "{} of {} differ, e.g. {:?}", mismatches.len(), cases.len(), &mismatches[..mismatches.len().min(10)]);
  eprintln!("num_to_js_string: {} values match node", cases.len());
}

#[test]
fn date_to_js_string_matches_node() {
  let mut rng = Rng(0x2545_f491_4f6c_dd1d);
  let mut total = 0;
  // 1900..2100 for zones with DST rules (libc and ICU agree there), the full range for UTC
  for (tz, min, max) in [
    ("UTC", -8.64e15, 8.64e15),
    ("Etc/UTC", -8.64e15, 8.64e15),
    ("GMT", -8.64e15, 8.64e15),
    ("Europe/Amsterdam", 0.0, 4.1e12),
    ("America/New_York", 0.0, 4.1e12),
    ("Asia/Tokyo", 0.0, 4.1e12),
    ("Australia/Sydney", 1e12, 4.1e12),
  ] {
    let mut cases = vec![f64::NAN, min, max, min + 0.7, max - 1.0];
    for _ in 0..3000 {
      cases.push((min + rng.unit() * (max - min)).trunc());
    }
    let input: Vec<String> = cases.iter().map(|ms| ms.to_string()).collect();
    let script = format!(
      "{READ_LINES} const out = []; for (const line of lines) {{ if (!line) continue; out.push(String(new Date(Number(line)))) }} process.stdout.write(out.join('\\n') + '\\n')"
    );
    let expected = node_lines(&script, &input, Some(tz));
    // SAFETY: this is the only test in this binary that reads or writes the environment / libc
    // time zone state.
    unsafe {
      std::env::set_var("TZ", tz);
      tzset();
    }
    let mismatches: Vec<_> = cases
      .iter()
      .zip(&expected)
      .filter(|(ms, js)| date_to_js_string(**ms) != **js)
      .map(|(ms, js)| format!("{tz} {ms}: rust {} vs node {js}", date_to_js_string(*ms)))
      .collect();
    assert!(mismatches.is_empty(), "{} differ, e.g. {:?}", mismatches.len(), &mismatches[..mismatches.len().min(10)]);
    total += cases.len();
  }
  eprintln!("date_to_js_string: {total} values match node");
}
