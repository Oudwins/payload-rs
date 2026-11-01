//! `Date.parse(string)`: a port of V8's `DateParser` (src/date/dateparser*.{h,cc}) and
//! `ParseDateTimeString` (src/date/date.cc), including the legacy (non-ISO) fallback parser.
//!
//! Strings are read as UTF-16 code units like V8. Local-time results are converted with
//! [`LocalTz`], which only matters for the result value and at the ±8.64e15 ms range boundary.

const K_NONE: i32 = i32::MAX;
const K_MAX_SIGNIFICANT_DIGITS: i32 = 9;
const SMI_MAX: u32 = i32::MAX as u32;
const MS_PER_DAY: f64 = 86_400_000.0;
const MAX_TIME_IN_MS: f64 = 864_000_000.0 * 10_000_000.0;
const MAX_TIME_BEFORE_UTC_IN_MS: f64 = MAX_TIME_IN_MS + MS_PER_DAY * 30.0;

/// Converts a local wall-clock time value to UTC (V8 `DateCache::ToUTC`).
pub trait LocalTz {
  fn local_to_utc(&self, local_ms: i64) -> f64;
}

/// The `TZ=UTC` process time zone.
pub struct Utc;

impl LocalTz for Utc {
  fn local_to_utc(&self, local_ms: i64) -> f64 {
    local_ms as f64
  }
}

/// `Date.parse(s)`; `NaN` when invalid.
pub fn date_parse(s: &str, tz: &dyn LocalTz) -> f64 {
  let units: Vec<u16> = s.encode_utf16().collect();
  let Some(out) = parse(&units) else { return f64::NAN };
  let day = make_day(out[YEAR], out[MONTH], out[DAY]);
  let time = make_time(out[HOUR], out[MINUTE], out[SECOND], out[MILLISECOND]);
  let mut date = make_date(day, time);
  if out[UTC_OFFSET].is_nan() {
    if (-MAX_TIME_BEFORE_UTC_IN_MS..=MAX_TIME_BEFORE_UTC_IN_MS).contains(&date) {
      date = tz.local_to_utc(date as i64);
    } else {
      return f64::NAN;
    }
  } else {
    date -= out[UTC_OFFSET] * 1000.0;
  }
  if (-MAX_TIME_IN_MS..=MAX_TIME_IN_MS).contains(&date) {
    (if date > 0.0 { date.floor() } else { date.ceil() }) + 0.0
  } else {
    f64::NAN
  }
}

const YEAR: usize = 0;
const MONTH: usize = 1;
const DAY: usize = 2;
const HOUR: usize = 3;
const MINUTE: usize = 4;
const SECOND: usize = 5;
const MILLISECOND: usize = 6;
const UTC_OFFSET: usize = 7;

fn make_day(year: f64, month: f64, date: f64) -> f64 {
  if !((-1_000_000.0..=1_000_000.0).contains(&year) && (-10_000_000.0..=10_000_000.0).contains(&month) && date.is_finite())
  {
    return f64::NAN;
  }
  let mut y = year as i64;
  let mut m = month as i64;
  y += m / 12;
  m %= 12;
  if m < 0 {
    m += 12;
    y -= 1;
  }
  const YEAR_DELTA: i64 = 399_999;
  let base = |y: i64| 365 * (y + YEAR_DELTA) + (y + YEAR_DELTA) / 4 - (y + YEAR_DELTA) / 100 + (y + YEAR_DELTA) / 400;
  let mut day_from_year = base(y) - base(1970);
  let is_leap = !((y % 4 != 0) || (y % 100 == 0 && y % 400 != 0));
  const COMMON: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const LEAP: [i64; 12] = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  day_from_year += if is_leap { LEAP[m as usize] } else { COMMON[m as usize] };
  (day_from_year - 1) as f64 + date.trunc()
}

fn make_time(h: f64, m: f64, s: f64, ms: f64) -> f64 {
  if h.is_finite() && m.is_finite() && s.is_finite() && ms.is_finite() {
    h.trunc() * 3_600_000.0 + m.trunc() * 60_000.0 + s.trunc() * 1000.0 + ms.trunc()
  } else {
    f64::NAN
  }
}

fn make_date(day: f64, time: f64) -> f64 {
  if day.is_finite() && time.is_finite() { time + day * MS_PER_DAY } else { f64::NAN }
}

fn between(x: i32, lo: i32, hi: i32) -> bool {
  (x.wrapping_sub(lo) as u32) <= (hi.wrapping_sub(lo) as u32)
}

fn is_white_space(c: u32) -> bool {
  matches!(c, 0x09 | 0x0B | 0x0C | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

fn is_white_space_or_line_terminator(c: u32) -> bool {
  is_white_space(c) || matches!(c, 0x0A | 0x0D | 0x2028 | 0x2029)
}

struct InputReader<'a> {
  index: usize,
  buffer: &'a [u16],
  ch: u32,
}

impl<'a> InputReader<'a> {
  fn new(buffer: &'a [u16]) -> Self {
    let mut r = Self { index: 0, buffer, ch: 0 };
    r.next();
    r
  }

  fn position(&self) -> usize {
    self.index
  }

  fn next(&mut self) {
    self.ch = self.buffer.get(self.index).map(|u| u32::from(*u)).unwrap_or(0);
    self.index += 1;
  }

  fn read_unsigned_numeral(&mut self) -> i32 {
    let mut n = 0;
    let mut i = 0;
    while self.ch == u32::from(b'0') {
      self.next();
    }
    while self.is_ascii_digit() {
      if i < K_MAX_SIGNIFICANT_DIGITS {
        n = n * 10 + (self.ch - u32::from(b'0')) as i32;
      }
      i += 1;
      self.next();
    }
    n
  }

  fn read_word(&mut self, prefix: &mut [u32; 3]) -> i32 {
    let mut len = 0;
    while self.is_ascii_alpha_or_above() && !is_white_space(self.ch) {
      if (len as usize) < prefix.len() {
        prefix[len as usize] = self.ch | 0x20;
      }
      self.next();
      len += 1;
    }
    for p in prefix.iter_mut().skip(len as usize) {
      *p = 0;
    }
    len
  }

  fn skip(&mut self, c: u8) -> bool {
    if self.ch == u32::from(c) {
      self.next();
      return true;
    }
    false
  }

  fn skip_white_space(&mut self) -> bool {
    if is_white_space_or_line_terminator(self.ch) {
      self.next();
      return true;
    }
    false
  }

  fn skip_parentheses(&mut self) -> bool {
    if self.ch != u32::from(b'(') {
      return false;
    }
    let mut balance = 0;
    loop {
      if self.ch == u32::from(b')') {
        balance -= 1;
      } else if self.ch == u32::from(b'(') {
        balance += 1;
      }
      self.next();
      if !(balance > 0 && self.ch != 0) {
        break;
      }
    }
    true
  }

  fn is_end(&self) -> bool {
    self.ch == 0
  }

  fn is_ascii_digit(&self) -> bool {
    (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch)
  }

  fn is_ascii_alpha_or_above(&self) -> bool {
    self.ch >= u32::from(b'A')
  }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum KeywordType {
  Invalid = 0,
  MonthName = 1,
  TimeZoneName = 2,
  TimeSeparator = 3,
  AmPm = 4,
}

const TAG_INVALID: i32 = -6;
const TAG_UNKNOWN: i32 = -5;
const TAG_WHITE_SPACE: i32 = -4;
const TAG_NUMBER: i32 = -3;
const TAG_SYMBOL: i32 = -2;
const TAG_END_OF_INPUT: i32 = -1;

#[derive(Clone, Copy)]
struct DateToken {
  tag: i32,
  length: i32,
  value: i32,
}

impl DateToken {
  fn is_invalid(&self) -> bool {
    self.tag == TAG_INVALID
  }
  fn is_number(&self) -> bool {
    self.tag == TAG_NUMBER
  }
  fn is_symbol(&self) -> bool {
    self.tag == TAG_SYMBOL
  }
  fn is_white_space(&self) -> bool {
    self.tag == TAG_WHITE_SPACE
  }
  fn is_end_of_input(&self) -> bool {
    self.tag == TAG_END_OF_INPUT
  }
  fn is_keyword(&self) -> bool {
    self.tag >= 0
  }
  fn is_symbol_char(&self, c: u8) -> bool {
    self.is_symbol() && self.value == i32::from(c)
  }
  fn is_keyword_type(&self, t: KeywordType) -> bool {
    self.tag == t as i32
  }
  fn is_fixed_length_number(&self, length: i32) -> bool {
    self.is_number() && self.length == length
  }
  fn is_ascii_sign(&self) -> bool {
    self.tag == TAG_SYMBOL && (self.value == i32::from(b'-') || self.value == i32::from(b'+'))
  }
  fn ascii_sign(&self) -> i32 {
    44 - self.value
  }
  fn is_keyword_z(&self) -> bool {
    self.is_keyword_type(KeywordType::TimeZoneName) && self.length == 1 && self.value == 0
  }
  fn keyword(t: i32, value: i32, length: i32) -> Self {
    Self { tag: t, length, value }
  }
  fn number(value: i32, length: i32) -> Self {
    Self { tag: TAG_NUMBER, length, value }
  }
  fn symbol(c: u8) -> Self {
    Self { tag: TAG_SYMBOL, length: 1, value: i32::from(c) }
  }
  fn end_of_input() -> Self {
    Self { tag: TAG_END_OF_INPUT, length: 0, value: -1 }
  }
  fn white_space(length: i32) -> Self {
    Self { tag: TAG_WHITE_SPACE, length, value: -1 }
  }
  fn unknown() -> Self {
    Self { tag: TAG_UNKNOWN, length: 1, value: -1 }
  }
  fn invalid() -> Self {
    Self { tag: TAG_INVALID, length: 0, value: -1 }
  }
}

const KEYWORDS: &[([u8; 3], KeywordType, i32)] = &[
  (*b"jan", KeywordType::MonthName, 1),
  (*b"feb", KeywordType::MonthName, 2),
  (*b"mar", KeywordType::MonthName, 3),
  (*b"apr", KeywordType::MonthName, 4),
  (*b"may", KeywordType::MonthName, 5),
  (*b"jun", KeywordType::MonthName, 6),
  (*b"jul", KeywordType::MonthName, 7),
  (*b"aug", KeywordType::MonthName, 8),
  (*b"sep", KeywordType::MonthName, 9),
  (*b"oct", KeywordType::MonthName, 10),
  (*b"nov", KeywordType::MonthName, 11),
  (*b"dec", KeywordType::MonthName, 12),
  (*b"am\0", KeywordType::AmPm, 0),
  (*b"pm\0", KeywordType::AmPm, 12),
  (*b"ut\0", KeywordType::TimeZoneName, 0),
  (*b"utc", KeywordType::TimeZoneName, 0),
  (*b"z\0\0", KeywordType::TimeZoneName, 0),
  (*b"gmt", KeywordType::TimeZoneName, 0),
  (*b"cdt", KeywordType::TimeZoneName, -5),
  (*b"cst", KeywordType::TimeZoneName, -6),
  (*b"edt", KeywordType::TimeZoneName, -4),
  (*b"est", KeywordType::TimeZoneName, -5),
  (*b"mdt", KeywordType::TimeZoneName, -6),
  (*b"mst", KeywordType::TimeZoneName, -7),
  (*b"pdt", KeywordType::TimeZoneName, -7),
  (*b"pst", KeywordType::TimeZoneName, -8),
  (*b"t\0\0", KeywordType::TimeSeparator, 0),
];

fn keyword_lookup(pre: &[u32; 3], len: i32) -> (KeywordType, i32) {
  for (word, t, value) in KEYWORDS {
    let matches = pre.iter().zip(word.iter()).all(|(p, w)| *p == u32::from(*w));
    if matches && (len <= 3 || *t == KeywordType::MonthName) {
      return (*t, *value);
    }
  }
  (KeywordType::Invalid, 0)
}

struct Tokenizer<'a> {
  input: InputReader<'a>,
  next: DateToken,
}

impl<'a> Tokenizer<'a> {
  fn new(input: InputReader<'a>) -> Self {
    let mut t = Self { input, next: DateToken::end_of_input() };
    t.next = t.scan();
    t
  }

  fn next(&mut self) -> DateToken {
    let result = self.next;
    self.next = self.scan();
    result
  }

  fn peek(&self) -> DateToken {
    self.next
  }

  fn skip_symbol(&mut self, c: u8) -> bool {
    if self.next.is_symbol_char(c) {
      self.next = self.scan();
      return true;
    }
    false
  }

  fn scan(&mut self) -> DateToken {
    let pre_pos = self.input.position();
    if self.input.is_end() {
      return DateToken::end_of_input();
    }
    if self.input.is_ascii_digit() {
      let n = self.input.read_unsigned_numeral();
      let length = (self.input.position() - pre_pos) as i32;
      return DateToken::number(n, length);
    }
    for c in [b':', b'-', b'+', b'.', b')'] {
      if self.input.skip(c) {
        return DateToken::symbol(c);
      }
    }
    if self.input.is_ascii_alpha_or_above() && !is_white_space(self.input.ch) {
      let mut buffer = [0u32; 3];
      let length = self.input.read_word(&mut buffer);
      let (t, value) = keyword_lookup(&buffer, length);
      return DateToken::keyword(t as i32, value, length);
    }
    if self.input.skip_white_space() {
      return DateToken::white_space((self.input.position() - pre_pos) as i32);
    }
    if self.input.skip_parentheses() {
      return DateToken::unknown();
    }
    self.input.next();
    DateToken::unknown()
  }
}

struct TimeZoneComposer {
  sign: i32,
  hour: i32,
  minute: i32,
}

impl TimeZoneComposer {
  fn set(&mut self, offset_in_hours: i32) {
    self.sign = if offset_in_hours < 0 { -1 } else { 1 };
    self.hour = offset_in_hours * self.sign;
    self.minute = 0;
  }
  fn set_sign(&mut self, sign: i32) {
    self.sign = if sign < 0 { -1 } else { 1 };
  }
  fn is_expecting(&self, n: i32) -> bool {
    self.hour != K_NONE && self.minute == K_NONE && is_minute(n)
  }
  fn is_utc(&self) -> bool {
    self.hour == 0 && self.minute == 0
  }
  fn is_empty(&self) -> bool {
    self.hour == K_NONE
  }
  fn write(&mut self, out: &mut [f64; 8]) -> bool {
    if self.sign != K_NONE {
      if self.hour == K_NONE {
        self.hour = 0;
      }
      if self.minute == K_NONE {
        self.minute = 0;
      }
      let total = (self.hour as u32).wrapping_mul(3600).wrapping_add((self.minute as u32).wrapping_mul(60));
      if total > SMI_MAX {
        return false;
      }
      let mut total = total as i32;
      if self.sign < 0 {
        total = -total;
      }
      out[UTC_OFFSET] = f64::from(total);
    } else {
      out[UTC_OFFSET] = f64::NAN;
    }
    true
  }
}

fn is_minute(x: i32) -> bool {
  between(x, 0, 59)
}
fn is_hour(x: i32) -> bool {
  between(x, 0, 23)
}
fn is_second(x: i32) -> bool {
  between(x, 0, 59)
}
fn is_hour12(x: i32) -> bool {
  between(x, 0, 12)
}
fn is_millisecond(x: i32) -> bool {
  between(x, 0, 999)
}
fn is_month(x: i32) -> bool {
  between(x, 1, 12)
}
fn is_day(x: i32) -> bool {
  between(x, 1, 31)
}

struct TimeComposer {
  comp: [i32; 4],
  index: usize,
  hour_offset: i32,
}

impl TimeComposer {
  fn is_empty(&self) -> bool {
    self.index == 0
  }
  fn is_expecting(&self, n: i32) -> bool {
    (self.index == 1 && is_minute(n)) || (self.index == 2 && is_second(n)) || (self.index == 3 && is_millisecond(n))
  }
  fn add(&mut self, n: i32) -> bool {
    if self.index < 4 {
      self.comp[self.index] = n;
      self.index += 1;
      true
    } else {
      false
    }
  }
  fn add_final(&mut self, n: i32) -> bool {
    if !self.add(n) {
      return false;
    }
    while self.index < 4 {
      self.comp[self.index] = 0;
      self.index += 1;
    }
    true
  }
  fn write(&mut self, out: &mut [f64; 8]) -> bool {
    while self.index < 4 {
      self.comp[self.index] = 0;
      self.index += 1;
    }
    let [mut hour, minute, second, millisecond] = self.comp;
    if self.hour_offset != K_NONE {
      if !is_hour12(hour) {
        return false;
      }
      hour %= 12;
      hour += self.hour_offset;
    }
    if (!is_hour(hour) || !is_minute(minute) || !is_second(second) || !is_millisecond(millisecond))
      && (hour != 24 || minute != 0 || second != 0 || millisecond != 0)
    {
      return false;
    }
    out[HOUR] = f64::from(hour);
    out[MINUTE] = f64::from(minute);
    out[SECOND] = f64::from(second);
    out[MILLISECOND] = f64::from(millisecond);
    true
  }
}

struct DayComposer {
  comp: [i32; 3],
  index: usize,
  named_month: i32,
  is_iso_date: bool,
}

impl DayComposer {
  fn is_empty(&self) -> bool {
    self.index == 0
  }
  fn add(&mut self, n: i32) -> bool {
    if self.index < 3 {
      self.comp[self.index] = n;
      self.index += 1;
      true
    } else {
      false
    }
  }
  fn write(&mut self, out: &mut [f64; 8]) -> bool {
    if self.index < 1 {
      return false;
    }
    while self.index < 3 {
      self.comp[self.index] = 1;
      self.index += 1;
    }
    let mut year: i32 = 0;
    let month;
    let day;
    let c = self.comp;
    if self.named_month == K_NONE {
      if self.is_iso_date || (self.index == 3 && !is_day(c[0])) {
        year = c[0];
        month = c[1];
        day = c[2];
      } else {
        month = c[0];
        day = c[1];
        if self.index == 3 {
          year = c[2];
        }
      }
    } else {
      month = self.named_month;
      if self.index == 1 {
        day = c[0];
      } else if !is_day(c[0]) {
        year = c[0];
        day = c[1];
      } else {
        day = c[0];
        year = c[1];
      }
    }
    if !self.is_iso_date {
      if between(year, 0, 49) {
        year += 2000;
      } else if between(year, 50, 99) {
        year += 1900;
      }
    }
    if !is_month(month) || !is_day(day) {
      return false;
    }
    out[YEAR] = f64::from(year);
    out[MONTH] = f64::from(month - 1);
    out[DAY] = f64::from(day);
    true
  }
}

fn read_milliseconds(token: DateToken) -> i32 {
  let mut number = token.value;
  let mut length = token.length;
  if length < 3 {
    if length == 1 {
      number *= 100;
    } else if length == 2 {
      number *= 10;
    }
  } else if length > 3 {
    if length > K_MAX_SIGNIFICANT_DIGITS {
      length = K_MAX_SIGNIFICANT_DIGITS;
    }
    let mut factor = 1;
    loop {
      factor *= 10;
      length -= 1;
      if length <= 3 {
        break;
      }
    }
    number /= factor;
  }
  number
}

fn parse_es5(sc: &mut Tokenizer, day: &mut DayComposer, time: &mut TimeComposer, tz: &mut TimeZoneComposer) -> DateToken {
  if sc.peek().is_ascii_sign() {
    let sign_token = sc.next();
    if !sc.peek().is_fixed_length_number(6) {
      return sign_token;
    }
    let sign = sign_token.ascii_sign();
    let year = sc.next().value;
    if sign < 0 && year == 0 {
      return sign_token;
    }
    day.add(sign * year);
  } else if sc.peek().is_fixed_length_number(4) {
    day.add(sc.next().value);
  } else {
    return sc.next();
  }
  if sc.skip_symbol(b'-') {
    if !sc.peek().is_fixed_length_number(2) || !is_month(sc.peek().value) {
      return sc.next();
    }
    day.add(sc.next().value);
    if sc.skip_symbol(b'-') {
      if !sc.peek().is_fixed_length_number(2) || !is_day(sc.peek().value) {
        return sc.next();
      }
      day.add(sc.next().value);
    }
  }
  if !sc.peek().is_keyword_type(KeywordType::TimeSeparator) {
    if !sc.peek().is_end_of_input() {
      return sc.next();
    }
  } else {
    sc.next();
    if !sc.peek().is_fixed_length_number(2) || !between(sc.peek().value, 0, 24) {
      return DateToken::invalid();
    }
    let hour_is_24 = sc.peek().value == 24;
    time.add(sc.next().value);
    if !sc.skip_symbol(b':') {
      return DateToken::invalid();
    }
    if !sc.peek().is_fixed_length_number(2) || !is_minute(sc.peek().value) || (hour_is_24 && sc.peek().value > 0) {
      return DateToken::invalid();
    }
    time.add(sc.next().value);
    if sc.skip_symbol(b':') {
      if !sc.peek().is_fixed_length_number(2) || !is_second(sc.peek().value) || (hour_is_24 && sc.peek().value > 0) {
        return DateToken::invalid();
      }
      time.add(sc.next().value);
      if sc.skip_symbol(b'.') {
        if !sc.peek().is_number() || (hour_is_24 && sc.peek().value > 0) {
          return DateToken::invalid();
        }
        time.add(read_milliseconds(sc.next()));
      }
    }
    if sc.peek().is_keyword_z() {
      sc.next();
      tz.set(0);
    } else if sc.peek().is_symbol_char(b'+') || sc.peek().is_symbol_char(b'-') {
      tz.set_sign(if sc.next().value == i32::from(b'+') { 1 } else { -1 });
      if sc.peek().is_fixed_length_number(4) {
        let hourmin = sc.next().value;
        let hour = hourmin / 100;
        let min = hourmin % 100;
        if !is_hour(hour) || !is_minute(min) {
          return DateToken::invalid();
        }
        tz.hour = hour;
        tz.minute = min;
      } else {
        if !sc.peek().is_fixed_length_number(2) || !is_hour(sc.peek().value) {
          return DateToken::invalid();
        }
        tz.hour = sc.next().value;
        if !sc.skip_symbol(b':') {
          return DateToken::invalid();
        }
        if !sc.peek().is_fixed_length_number(2) || !is_minute(sc.peek().value) {
          return DateToken::invalid();
        }
        tz.minute = sc.next().value;
      }
    }
    if !sc.peek().is_end_of_input() {
      return DateToken::invalid();
    }
  }
  if tz.is_empty() && time.is_empty() {
    tz.set(0);
  }
  day.is_iso_date = true;
  DateToken::end_of_input()
}

fn parse(units: &[u16]) -> Option<[f64; 8]> {
  let mut scanner = Tokenizer::new(InputReader::new(units));
  let mut tz = TimeZoneComposer { sign: K_NONE, hour: K_NONE, minute: K_NONE };
  let mut time = TimeComposer { comp: [0; 4], index: 0, hour_offset: K_NONE };
  let mut day = DayComposer { comp: [0; 3], index: 0, named_month: K_NONE, is_iso_date: false };

  let next_unhandled = parse_es5(&mut scanner, &mut day, &mut time, &mut tz);
  if next_unhandled.is_invalid() {
    return None;
  }
  let mut has_read_number = !day.is_empty();
  let mut token = next_unhandled;
  while !token.is_end_of_input() {
    if token.is_number() {
      has_read_number = true;
      let n = token.value;
      if scanner.skip_symbol(b':') {
        if scanner.skip_symbol(b':') {
          if !time.is_empty() {
            return None;
          }
          time.add(n);
          time.add(0);
        } else {
          if !time.add(n) {
            return None;
          }
          if scanner.peek().is_symbol_char(b'.') {
            scanner.next();
          }
        }
      } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
        time.add(n);
        if !scanner.peek().is_number() {
          return None;
        }
        let ms = read_milliseconds(scanner.next());
        if ms < 0 {
          return None;
        }
        time.add_final(ms);
      } else if tz.is_expecting(n) {
        tz.minute = n;
      } else if time.is_expecting(n) {
        time.add_final(n);
        let peek = scanner.peek();
        if !peek.is_end_of_input() && !peek.is_white_space() && !peek.is_keyword_z() && !peek.is_ascii_sign() {
          return None;
        }
      } else {
        if !day.add(n) {
          return None;
        }
        scanner.skip_symbol(b'-');
      }
    } else if token.is_keyword() {
      let value = token.value;
      if token.is_keyword_type(KeywordType::AmPm) && !time.is_empty() {
        time.hour_offset = value;
      } else if token.is_keyword_type(KeywordType::MonthName) {
        day.named_month = value;
        scanner.skip_symbol(b'-');
      } else if token.is_keyword_type(KeywordType::TimeZoneName) && has_read_number {
        tz.set(value);
      } else {
        if has_read_number {
          return None;
        }
        if scanner.peek().is_number() {
          return None;
        }
      }
    } else if token.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) {
      tz.set_sign(token.ascii_sign());
      let mut n = 0;
      let mut length = 0;
      if scanner.peek().is_number() {
        let next_token = scanner.next();
        length = next_token.length;
        n = next_token.value;
      }
      has_read_number = true;
      if scanner.peek().is_symbol_char(b':') {
        tz.hour = n;
        tz.minute = K_NONE;
      } else if length == 2 || length == 1 {
        tz.hour = n;
        tz.minute = 0;
      } else if length == 4 || length == 3 {
        tz.hour = n / 100;
        tz.minute = n % 100;
      } else {
        return None;
      }
    } else if (token.is_ascii_sign() || token.is_symbol_char(b')')) && has_read_number {
      return None;
    }
    token = scanner.next();
  }

  let mut out = [0.0; 8];
  (day.write(&mut out) && time.write(&mut out) && tz.write(&mut out)).then_some(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_like_v8() {
    assert_eq!(date_parse("2000-01-01T00:00:00Z", &Utc), 946_684_800_000.0);
    assert_eq!(date_parse("Jan 1 2000 10:00 +596000:", &Utc), -1_198_879_200_000.0);
    assert!(date_parse("Jan 1 2000 10:00 +597000:", &Utc).is_nan());
    assert_eq!(date_parse("12345", &Utc), 327_403_382_400_000.0);
    assert_eq!(date_parse("2000-01-01\u{0}zz", &Utc), 946_684_800_000.0);
  }
}
