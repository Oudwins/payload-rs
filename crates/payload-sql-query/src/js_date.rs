//! `new Date(string)` / `new Date(number).toISOString()` with V8 semantics: a port of V8's
//! `DateParser` (ES5 ISO format plus the legacy fallback) and of `DateCache::ToUTC` for
//! date-times without an offset, which are local time in the process time zone (`TZ`).

use payload_engine::error::{EngineError, Result};

use crate::js_ops::is_js_whitespace;

const MS_PER_DAY: f64 = 86_400_000.0;
/// `kMaxTimeInMs`
const MAX_TIME_IN_MS: f64 = 8.64e15;
/// `kMaxTimeBeforeUTCInMs`
const MAX_TIME_BEFORE_UTC_IN_MS: f64 = MAX_TIME_IN_MS + 864e6;

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
  // Howard Hinnant's algorithm; months may overflow like JS MakeDay.
  let y = y + (m - 1).div_euclid(12);
  let m = (m - 1).rem_euclid(12) + 1;
  let y = if m <= 2 { y - 1 } else { y };
  let era = y.div_euclid(400);
  let yoe = y - era * 400;
  let mp = (m + 9) % 12;
  let doy = (153 * mp + 2) / 5;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  era * 146_097 + doe - 719_468 + (d - 1)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
  let z = z + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `TimeClip`
pub fn time_clip(t: f64) -> f64 {
  if !t.is_finite() || t.abs() > MAX_TIME_IN_MS { f64::NAN } else { t.trunc() + 0.0 }
}

/// Offset of local time from UTC in milliseconds at the UTC time `t` (process `TZ`).
#[cfg(unix)]
fn local_offset_ms(t: f64) -> f64 {
  let secs = (t / 1000.0).floor() as libc::time_t;
  // SAFETY: `localtime_r` only writes into the provided `tm`.
  unsafe {
    let mut tm: libc::tm = std::mem::zeroed();
    if libc::localtime_r(&secs, &mut tm).is_null() {
      return 0.0;
    }
    tm.tm_gmtoff as f64 * 1000.0
  }
}

#[cfg(not(unix))]
fn local_offset_ms(_t: f64) -> f64 {
  0.0
}

/// `DateCache::ToUTC(local)`: ICU `getOffsetFromLocal(UCAL_TZ_LOCAL_FORMER, UCAL_TZ_LOCAL_FORMER)`.
/// A repeated wall-clock time uses the earlier instant (the larger, former offset); a skipped
/// one uses the offset in effect before the transition.
fn local_to_utc(local: f64) -> f64 {
  let before = local_offset_ms(local - MS_PER_DAY);
  let mut candidates = vec![before, local_offset_ms(local), local_offset_ms(local + MS_PER_DAY)];
  candidates.dedup();
  let valid = candidates
    .into_iter()
    .filter(|o| local_offset_ms(local - o) == *o)
    .fold(None, |acc: Option<f64>, o| Some(acc.map_or(o, |a| a.max(o))));
  local - valid.unwrap_or(before)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kw {
  Invalid,
  MonthName,
  TimeZoneName,
  TimeSeparator,
  AmPm,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Tok {
  Number { value: i64, len: usize },
  Symbol(char),
  Word { kind: Kw, value: i64, len: usize },
  WhiteSpace,
  Unknown,
  End,
  Invalid,
}

impl Tok {
  fn is_number(&self) -> bool {
    matches!(self, Tok::Number { .. })
  }
  fn number(&self) -> i64 {
    if let Tok::Number { value, .. } = self { *value } else { 0 }
  }
  fn is_fixed(&self, n: usize) -> bool {
    matches!(self, Tok::Number { len, .. } if *len == n)
  }
  fn is_symbol(&self, c: char) -> bool {
    *self == Tok::Symbol(c)
  }
  fn is_sign(&self) -> bool {
    self.is_symbol('+') || self.is_symbol('-')
  }
  fn is_keyword_type(&self, k: Kw) -> bool {
    matches!(self, Tok::Word { kind, .. } if *kind == k)
  }
  fn is_keyword_z(&self) -> bool {
    matches!(self, Tok::Word { kind: Kw::TimeZoneName, value: 0, len: 1 })
  }
}

const KEYWORDS: &[(&str, Kw, i64)] = &[
  ("jan", Kw::MonthName, 1),
  ("feb", Kw::MonthName, 2),
  ("mar", Kw::MonthName, 3),
  ("apr", Kw::MonthName, 4),
  ("may", Kw::MonthName, 5),
  ("jun", Kw::MonthName, 6),
  ("jul", Kw::MonthName, 7),
  ("aug", Kw::MonthName, 8),
  ("sep", Kw::MonthName, 9),
  ("oct", Kw::MonthName, 10),
  ("nov", Kw::MonthName, 11),
  ("dec", Kw::MonthName, 12),
  ("am", Kw::AmPm, 0),
  ("pm", Kw::AmPm, 12),
  ("ut", Kw::TimeZoneName, 0),
  ("utc", Kw::TimeZoneName, 0),
  ("z", Kw::TimeZoneName, 0),
  ("gmt", Kw::TimeZoneName, 0),
  ("cdt", Kw::TimeZoneName, -5),
  ("cst", Kw::TimeZoneName, -6),
  ("edt", Kw::TimeZoneName, -4),
  ("est", Kw::TimeZoneName, -5),
  ("mdt", Kw::TimeZoneName, -6),
  ("mst", Kw::TimeZoneName, -7),
  ("pdt", Kw::TimeZoneName, -7),
  ("pst", Kw::TimeZoneName, -8),
  ("t", Kw::TimeSeparator, 0),
];

/// V8 `DateStringTokenizer` over the whole input.
fn tokenize(s: &str) -> Vec<Tok> {
  let chars: Vec<char> = s.chars().collect();
  let mut i = 0;
  let mut out = Vec::new();
  while i < chars.len() {
    let c = chars[i];
    if c.is_ascii_digit() {
      let start = i;
      while i < chars.len() && chars[i] == '0' {
        i += 1;
      }
      let mut value: i64 = 0;
      let mut digits = 0;
      while i < chars.len() && chars[i].is_ascii_digit() {
        if digits < 9 {
          value = value * 10 + i64::from(chars[i] as u8 - b'0');
        }
        digits += 1;
        i += 1;
      }
      out.push(Tok::Number { value, len: i - start });
    } else if matches!(c, ':' | '-' | '+' | '.' | ')') {
      out.push(Tok::Symbol(c));
      i += 1;
    } else if c as u32 >= 'A' as u32 && !is_js_whitespace(c) {
      let mut prefix = String::new();
      let mut len = 0;
      while i < chars.len() && chars[i] as u32 >= 'A' as u32 && !is_js_whitespace(chars[i]) {
        if len < 3 {
          prefix.extend(chars[i].to_lowercase().take(1));
        }
        len += 1;
        i += 1;
      }
      let found = KEYWORDS.iter().find(|(k, kind, _)| {
        let full = if len <= 3 { prefix == *k } else { prefix.len() == 3 && &prefix == k };
        full && (len <= 3 || *kind == Kw::MonthName)
      });
      out.push(match found {
        Some((_, kind, value)) => Tok::Word { kind: *kind, value: *value, len },
        None => Tok::Word { kind: Kw::Invalid, value: 0, len },
      });
    } else if is_js_whitespace(c) {
      while i < chars.len() && is_js_whitespace(chars[i]) {
        i += 1;
      }
      out.push(Tok::WhiteSpace);
    } else if c == '(' {
      let mut depth = 0;
      while i < chars.len() {
        if chars[i] == ')' {
          depth -= 1;
        } else if chars[i] == '(' {
          depth += 1;
        }
        i += 1;
        if depth == 0 {
          break;
        }
      }
      out.push(Tok::Unknown);
    } else {
      out.push(Tok::Unknown);
      i += 1;
    }
  }
  out
}

struct Scanner {
  toks: Vec<Tok>,
  pos: usize,
}

impl Scanner {
  fn peek(&self) -> Tok {
    self.toks.get(self.pos).copied().unwrap_or(Tok::End)
  }
  fn next(&mut self) -> Tok {
    let t = self.peek();
    if self.pos < self.toks.len() {
      self.pos += 1;
    }
    t
  }
  fn skip_symbol(&mut self, c: char) -> bool {
    if self.peek().is_symbol(c) {
      self.pos += 1;
      true
    } else {
      false
    }
  }
}

const NONE: i64 = i64::MIN;

#[derive(Default)]
struct DayComposer {
  comp: Vec<i64>,
  named_month: Option<i64>,
  iso: bool,
}

impl DayComposer {
  fn add(&mut self, n: i64) -> bool {
    if self.comp.len() < 3 {
      self.comp.push(n);
      true
    } else {
      false
    }
  }
  fn write(&mut self) -> Option<(i64, i64, i64)> {
    if self.comp.is_empty() {
      return None;
    }
    while self.comp.len() < 3 {
      self.comp.push(1);
    }
    let is_day = |x: i64| (1..=31).contains(&x);
    let c = &self.comp;
    let (mut year, month, day) = match self.named_month {
      None => {
        if self.iso || !is_day(c[0]) { (c[0], c[1], c[2]) } else { (c[2], c[0], c[1]) }
      }
      Some(m) => {
        // `index_` is 3 after the defaults are filled in, so the single-component case never applies.
        if !is_day(c[0]) { (c[0], m, c[1]) } else { (c[1], m, c[0]) }
      }
    };
    if !self.iso {
      if (0..=49).contains(&year) {
        year += 2000;
      } else if (50..=99).contains(&year) {
        year += 1900;
      }
    }
    if !(1..=12).contains(&month) || !is_day(day) {
      return None;
    }
    Some((year, month, day))
  }
}

#[derive(Default)]
struct TimeComposer {
  comp: Vec<i64>,
  hour_offset: Option<i64>,
}

impl TimeComposer {
  fn is_empty(&self) -> bool {
    self.comp.is_empty()
  }
  fn is_expecting(&self, n: i64) -> bool {
    match self.comp.len() {
      1 | 2 => (0..=59).contains(&n),
      3 => (0..=999).contains(&n),
      _ => false,
    }
  }
  fn add(&mut self, n: i64) -> bool {
    if self.comp.len() < 4 {
      self.comp.push(n);
      true
    } else {
      false
    }
  }
  fn add_final(&mut self, n: i64) -> bool {
    if !self.add(n) {
      return false;
    }
    while self.comp.len() < 4 {
      self.comp.push(0);
    }
    true
  }
  fn write(&mut self) -> Option<(i64, i64, i64, i64)> {
    while self.comp.len() < 4 {
      self.comp.push(0);
    }
    let (mut h, m, s, ms) = (self.comp[0], self.comp[1], self.comp[2], self.comp[3]);
    if let Some(offset) = self.hour_offset {
      if !(0..=12).contains(&h) {
        return None;
      }
      h = h % 12 + offset;
    }
    if !((0..=23).contains(&h) && (0..=59).contains(&m) && (0..=59).contains(&s) && (0..=999).contains(&ms))
      && (h != 24 || m != 0 || s != 0 || ms != 0)
    {
      return None;
    }
    Some((h, m, s, ms))
  }
}

struct TzComposer {
  sign: i64,
  hour: i64,
  minute: i64,
}

impl TzComposer {
  fn set(&mut self, offset_hours: i64) {
    self.sign = if offset_hours < 0 { -1 } else { 1 };
    self.hour = offset_hours * self.sign;
    self.minute = 0;
  }
  fn is_expecting(&self, n: i64) -> bool {
    self.hour != NONE && self.minute == NONE && (0..=59).contains(&n)
  }
  fn is_utc(&self) -> bool {
    self.hour == 0 && self.minute == 0
  }
  /// Offset in seconds; `None` means local time.
  fn write(&mut self) -> Option<Option<i64>> {
    if self.sign == NONE {
      return Some(None);
    }
    let hour = if self.hour == NONE { 0 } else { self.hour };
    let minute = if self.minute == NONE { 0 } else { self.minute };
    let total = hour * 3600 + minute * 60;
    if !(0..=1_073_741_823).contains(&total) {
      return None;
    }
    Some(Some(if self.sign < 0 { -total } else { total }))
  }
}

fn read_milliseconds(t: Tok) -> i64 {
  let (mut value, mut len) = match t {
    Tok::Number { value, len } => (value, len),
    _ => (0, 0),
  };
  if len == 1 {
    value *= 100;
  } else if len == 2 {
    value *= 10;
  } else if len > 3 {
    len = len.min(9);
    let mut factor = 1;
    while len > 3 {
      factor *= 10;
      len -= 1;
    }
    value /= factor;
  }
  value
}

/// V8 `ParseES5DateTime`
fn parse_es5(sc: &mut Scanner, day: &mut DayComposer, time: &mut TimeComposer, tz: &mut TzComposer) -> Tok {
  if sc.peek().is_sign() {
    let sign_token = sc.next();
    if !sc.peek().is_fixed(6) {
      return sign_token;
    }
    let sign = if sign_token.is_symbol('-') { -1 } else { 1 };
    let year = sc.next().number();
    if sign < 0 && year == 0 {
      return sign_token;
    }
    day.add(sign * year);
  } else if sc.peek().is_fixed(4) {
    day.add(sc.next().number());
  } else {
    return sc.next();
  }
  if sc.skip_symbol('-') {
    if !sc.peek().is_fixed(2) || !(1..=12).contains(&sc.peek().number()) {
      return sc.next();
    }
    day.add(sc.next().number());
    if sc.skip_symbol('-') {
      if !sc.peek().is_fixed(2) || !(1..=31).contains(&sc.peek().number()) {
        return sc.next();
      }
      day.add(sc.next().number());
    }
  }
  if !sc.peek().is_keyword_type(Kw::TimeSeparator) {
    if sc.peek() != Tok::End {
      return sc.next();
    }
  } else {
    sc.next();
    if !sc.peek().is_fixed(2) || !(0..=24).contains(&sc.peek().number()) {
      return Tok::Invalid;
    }
    let hour_is_24 = sc.peek().number() == 24;
    time.add(sc.next().number());
    if !sc.skip_symbol(':') {
      return Tok::Invalid;
    }
    if !sc.peek().is_fixed(2) || !(0..=59).contains(&sc.peek().number()) || (hour_is_24 && sc.peek().number() > 0) {
      return Tok::Invalid;
    }
    time.add(sc.next().number());
    if sc.skip_symbol(':') {
      if !sc.peek().is_fixed(2) || !(0..=59).contains(&sc.peek().number()) || (hour_is_24 && sc.peek().number() > 0) {
        return Tok::Invalid;
      }
      time.add(sc.next().number());
      if sc.skip_symbol('.') {
        if !sc.peek().is_number() || (hour_is_24 && sc.peek().number() > 0) {
          return Tok::Invalid;
        }
        let t = sc.next();
        time.add(read_milliseconds(t));
      }
    }
    if sc.peek().is_keyword_z() {
      sc.next();
      tz.set(0);
    } else if sc.peek().is_sign() {
      tz.sign = if sc.next().is_symbol('+') { 1 } else { -1 };
      if sc.peek().is_fixed(4) {
        let hm = sc.next().number();
        let (h, m) = (hm / 100, hm % 100);
        if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
          return Tok::Invalid;
        }
        tz.hour = h;
        tz.minute = m;
      } else {
        if !sc.peek().is_fixed(2) || !(0..=23).contains(&sc.peek().number()) {
          return Tok::Invalid;
        }
        tz.hour = sc.next().number();
        if !sc.skip_symbol(':') {
          return Tok::Invalid;
        }
        if !sc.peek().is_fixed(2) || !(0..=59).contains(&sc.peek().number()) {
          return Tok::Invalid;
        }
        tz.minute = sc.next().number();
      }
    }
    if sc.peek() != Tok::End {
      return Tok::Invalid;
    }
  }
  if tz.hour == NONE && time.is_empty() {
    tz.set(0);
  }
  day.iso = true;
  Tok::End
}

type Fields = ((i64, i64, i64), (i64, i64, i64, i64), Option<i64>);

/// V8 `DateParser::Parse`: the broken-down fields, `None` when invalid.
fn parse_fields(s: &str) -> Option<Fields> {
  let mut sc = Scanner { toks: tokenize(s), pos: 0 };
  let mut day = DayComposer::default();
  let mut time = TimeComposer::default();
  let mut tz = TzComposer { sign: NONE, hour: NONE, minute: NONE };

  let mut token = parse_es5(&mut sc, &mut day, &mut time, &mut tz);
  if token == Tok::Invalid {
    return None;
  }
  let mut has_read_number = !day.comp.is_empty();
  while token != Tok::End {
    match token {
      Tok::Number { value: n, .. } => {
        has_read_number = true;
        if sc.skip_symbol(':') {
          if sc.skip_symbol(':') {
            if !time.is_empty() {
              return None;
            }
            time.add(n);
            time.add(0);
          } else {
            if !time.add(n) {
              return None;
            }
            if sc.peek().is_symbol('.') {
              sc.next();
            }
          }
        } else if sc.skip_symbol('.') && time.is_expecting(n) {
          time.add(n);
          if !sc.peek().is_number() {
            return None;
          }
          let t = sc.next();
          let ms = read_milliseconds(t);
          if ms < 0 {
            return None;
          }
          time.add_final(ms);
        } else if tz.is_expecting(n) {
          tz.minute = n;
        } else if time.is_expecting(n) {
          time.add_final(n);
          let peek = sc.peek();
          if !(peek == Tok::End || peek == Tok::WhiteSpace || peek.is_keyword_z() || peek.is_sign()) {
            return None;
          }
        } else {
          if !day.add(n) {
            return None;
          }
          sc.skip_symbol('-');
        }
      }
      Tok::Word { kind, value, .. } => {
        if kind == Kw::AmPm && !time.is_empty() {
          time.hour_offset = Some(value);
        } else if kind == Kw::MonthName {
          day.named_month = Some(value);
          sc.skip_symbol('-');
        } else if kind == Kw::TimeZoneName && has_read_number {
          tz.set(value);
        } else {
          if has_read_number {
            return None;
          }
          if sc.peek().is_number() {
            return None;
          }
        }
      }
      t if t.is_sign() && (tz.is_utc() || !time.is_empty()) => {
        tz.sign = if t.is_symbol('-') { -1 } else { 1 };
        let mut n = 0;
        let mut length = 0;
        if sc.peek().is_number() {
          if let Tok::Number { value, len } = sc.next() {
            n = value;
            length = len;
          }
        }
        has_read_number = true;
        if sc.peek().is_symbol(':') {
          tz.hour = n;
          tz.minute = NONE;
        } else if length == 1 || length == 2 {
          tz.hour = n;
          tz.minute = 0;
        } else if length == 3 || length == 4 {
          tz.hour = n / 100;
          tz.minute = n % 100;
        } else {
          return None;
        }
      }
      t if (t.is_sign() || t.is_symbol(')')) && has_read_number => return None,
      _ => {}
    }
    token = sc.next();
  }

  Some((day.write()?, time.write()?, tz.write()?))
}

/// `new Date(string).getTime()` (`Date.parse`), `None` for an invalid date.
pub fn date_parse(s: &str) -> Option<f64> {
  let ((year, month, d), (h, m, sec, ms), offset) = parse_fields(s)?;
  let days = days_from_civil(year, month, d) as f64;
  let date = days * MS_PER_DAY + (((h * 60 + m) * 60 + sec) * 1000 + ms) as f64;
  let utc = match offset {
    None => {
      if date.abs() > MAX_TIME_BEFORE_UTC_IN_MS {
        return None;
      }
      local_to_utc(date)
    }
    Some(offset) => date - offset as f64 * 1000.0,
  };
  let t = time_clip(utc);
  (!t.is_nan()).then_some(t)
}

/// `new Date(ms).toISOString()`; throws `RangeError: Invalid time value` for invalid times.
pub fn to_iso_string(ms: f64) -> Result<String> {
  let t = time_clip(ms);
  if t.is_nan() {
    return Err(EngineError::new("RangeError", "Invalid time value"));
  }
  let t = t as i64;
  let days = t.div_euclid(86_400_000);
  let ms_of_day = t.rem_euclid(86_400_000);
  let (y, m, d) = civil_from_days(days);
  let year = if (0..=9999).contains(&y) {
    format!("{y:04}")
  } else if y < 0 {
    format!("-{:06}", -y)
  } else {
    format!("+{y:06}")
  };
  Ok(format!(
    "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
    ms_of_day / 3_600_000,
    ms_of_day / 60_000 % 60,
    ms_of_day / 1000 % 60,
    ms_of_day % 1000
  ))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn iso_strings() {
    assert_eq!(to_iso_string(-1.7).unwrap(), "1969-12-31T23:59:59.999Z");
    assert_eq!(to_iso_string(8.64e15).unwrap(), "+275760-09-13T00:00:00.000Z");
    assert!(to_iso_string(8.64e15 + 1.0).is_err());
    assert!(to_iso_string(f64::NAN).is_err());
  }

  /// Differential against V8 in several process time zones: `test/__rs/query/fixtures/dates.json`
  /// (from `gen-dates.mjs`). The only test in this binary that reads local time or `TZ`.
  #[test]
  fn dates_match_v8() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/query/fixtures/dates.json");
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let fixture: serde_json::Value = serde_json::from_str(&text).unwrap();
    let inputs = fixture["inputs"].as_array().unwrap();
    let previous = std::env::var("TZ").ok();
    let mut failures = Vec::new();
    let mut total = 0;
    for zone in fixture["zones"].as_array().unwrap() {
      let tz = zone["tz"].as_str().unwrap();
      // SAFETY: no other test in this binary reads the environment or local time.
      unsafe {
        std::env::set_var("TZ", tz);
        tzset();
      }
      for (input, expected) in inputs.iter().zip(zone["times"].as_array().unwrap()) {
        total += 1;
        let input = input.as_str().unwrap();
        let actual = date_parse(input);
        if actual != expected.as_f64() {
          failures.push(format!("[{tz}] {input:?}: v8={expected} rs={actual:?}"));
        }
      }
    }
    // SAFETY: as above.
    unsafe {
      match previous {
        Some(tz) => std::env::set_var("TZ", tz),
        None => std::env::remove_var("TZ"),
      }
      tzset();
    }
    assert!(failures.is_empty(), "{}/{total} date mismatches:\n{}", failures.len(), failures.join("\n"));
    println!("{total} V8 date cases matched");
  }

  unsafe extern "C" {
    fn tzset();
  }
}
