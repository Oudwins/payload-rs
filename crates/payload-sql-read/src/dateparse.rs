//! Port of V8's `DateParser` (src/date/dateparser*.{h,cc}): the ES5 Date Time
//! String Format followed by V8's legacy fallback parser, as used by
//! `new Date(string)` / `Date.parse(string)`.

use crate::date::{MS_PER_DAY, days_from_civil, local_to_utc, time_clip};
use crate::jsops::is_js_whitespace;

const NONE: i64 = i64::MIN;
const MAX_INT: i64 = i32::MAX as i64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum KeywordType {
  Invalid,
  MonthName,
  TimeZoneName,
  TimeSeparator,
  AmPm,
}

#[derive(Clone, Copy, Debug)]
enum Token {
  Invalid,
  Unknown,
  Number { n: i64, len: usize },
  Symbol(char),
  WhiteSpace,
  Keyword { ty: KeywordType, value: i64, len: usize },
  End,
}

impl Token {
  fn is_number(&self) -> bool {
    matches!(self, Token::Number { .. })
  }
  fn is_fixed_length_number(&self, l: usize) -> bool {
    matches!(self, Token::Number { len, .. } if *len == l)
  }
  fn number(&self) -> i64 {
    match self {
      Token::Number { n, .. } => *n,
      _ => 0,
    }
  }
  fn is_symbol(&self, c: char) -> bool {
    matches!(self, Token::Symbol(s) if *s == c)
  }
  fn is_ascii_sign(&self) -> bool {
    self.is_symbol('+') || self.is_symbol('-')
  }
  fn ascii_sign(&self) -> i64 {
    if self.is_symbol('-') { -1 } else { 1 }
  }
  fn is_keyword_type(&self, t: KeywordType) -> bool {
    matches!(self, Token::Keyword { ty, .. } if *ty == t)
  }
  fn is_keyword_z(&self) -> bool {
    matches!(self, Token::Keyword { ty: KeywordType::TimeZoneName, value: 0, len: 1 })
  }
}

/// `KeywordTable` (3 character prefixes, NUL padded).
const KEYWORDS: [(&[u8; 3], KeywordType, i64); 25] = [
  (b"jan", KeywordType::MonthName, 1),
  (b"feb", KeywordType::MonthName, 2),
  (b"mar", KeywordType::MonthName, 3),
  (b"apr", KeywordType::MonthName, 4),
  (b"may", KeywordType::MonthName, 5),
  (b"jun", KeywordType::MonthName, 6),
  (b"jul", KeywordType::MonthName, 7),
  (b"aug", KeywordType::MonthName, 8),
  (b"sep", KeywordType::MonthName, 9),
  (b"oct", KeywordType::MonthName, 10),
  (b"nov", KeywordType::MonthName, 11),
  (b"dec", KeywordType::MonthName, 12),
  (b"am\0", KeywordType::AmPm, 0),
  (b"pm\0", KeywordType::AmPm, 12),
  (b"ut\0", KeywordType::TimeZoneName, 0),
  (b"utc", KeywordType::TimeZoneName, 0),
  (b"z\0\0", KeywordType::TimeZoneName, 0),
  (b"gmt", KeywordType::TimeZoneName, 0),
  (b"cdt", KeywordType::TimeZoneName, -5),
  (b"cst", KeywordType::TimeZoneName, -6),
  (b"edt", KeywordType::TimeZoneName, -4),
  (b"est", KeywordType::TimeZoneName, -5),
  (b"mdt", KeywordType::TimeZoneName, -6),
  (b"mst", KeywordType::TimeZoneName, -7),
  (b"pdt", KeywordType::TimeZoneName, -7),
];
const PST: (&[u8; 3], KeywordType, i64) = (b"pst", KeywordType::TimeZoneName, -8);
const T_SEP: (&[u8; 3], KeywordType, i64) = (b"t\0\0", KeywordType::TimeSeparator, 0);

fn lookup_keyword(prefix: [u32; 3], len: usize) -> (KeywordType, i64) {
  for (word, ty, value) in KEYWORDS.iter().copied().chain([PST, T_SEP]) {
    let matches = word.iter().zip(prefix).all(|(w, p)| u32::from(*w) == p);
    if matches && (len <= 3 || ty == KeywordType::MonthName) {
      return (ty, value);
    }
  }
  (KeywordType::Invalid, 0)
}

/// `DateStringTokenizer` over UTF-16 code units.
struct Tokenizer {
  s: Vec<u16>,
  pos: usize,
  next: Token,
}

impl Tokenizer {
  fn new(s: &str) -> Self {
    let mut t = Tokenizer { s: s.encode_utf16().collect(), pos: 0, next: Token::End };
    t.next = t.scan();
    t
  }

  fn ch(&self) -> u32 {
    self.s.get(self.pos).map_or(0, |c| u32::from(*c))
  }

  fn is_end(&self) -> bool {
    self.pos >= self.s.len()
  }

  fn is_white_space_char(&self) -> bool {
    char::from_u32(self.ch()).is_some_and(is_js_whitespace)
  }

  fn scan(&mut self) -> Token {
    let pre = self.pos;
    if self.is_end() {
      return Token::End;
    }
    let c = self.ch();
    if (u32::from(b'0')..=u32::from(b'9')).contains(&c) {
      let mut n: i64 = 0;
      while !self.is_end() && (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch()) {
        if n < MAX_INT / 10 - 10 {
          n = n * 10 + i64::from(self.ch() - u32::from(b'0'));
        }
        self.pos += 1;
      }
      return Token::Number { n, len: self.pos - pre };
    }
    for sym in [':', '-', '+', '.', ')'] {
      if c == sym as u32 {
        self.pos += 1;
        return Token::Symbol(sym);
      }
    }
    if c >= u32::from(b'A') && !self.is_white_space_char() {
      let mut prefix = [0u32; 3];
      let mut len = 0;
      while !self.is_end() && self.ch() >= u32::from(b'A') && !self.is_white_space_char() {
        if len < 3 {
          prefix[len] = self.ch() | 0x20;
        }
        len += 1;
        self.pos += 1;
      }
      let (ty, value) = lookup_keyword(prefix, len);
      return Token::Keyword { ty, value, len };
    }
    if self.is_white_space_char() {
      self.pos += 1;
      return Token::WhiteSpace;
    }
    if c == u32::from(b'(') {
      let mut balance = 0;
      loop {
        let ch = self.ch();
        if ch == u32::from(b')') {
          balance -= 1;
        } else if ch == u32::from(b'(') {
          balance += 1;
        }
        self.pos += 1;
        if !(balance > 0 && !self.is_end()) {
          break;
        }
      }
      return Token::Unknown;
    }
    self.pos += 1;
    Token::Unknown
  }

  fn next(&mut self) -> Token {
    let out = self.next;
    self.next = self.scan();
    out
  }

  fn peek(&self) -> Token {
    self.next
  }

  fn skip_symbol(&mut self, c: char) -> bool {
    if self.next.is_symbol(c) {
      self.next();
      true
    } else {
      false
    }
  }
}

fn between(x: i64, lo: i64, hi: i64) -> bool {
  (lo..=hi).contains(&x)
}
fn is_month(x: i64) -> bool {
  between(x, 1, 12)
}
fn is_day(x: i64) -> bool {
  between(x, 1, 31)
}
fn is_hour(x: i64) -> bool {
  between(x, 0, 23)
}
fn is_minute(x: i64) -> bool {
  between(x, 0, 59)
}
fn is_second(x: i64) -> bool {
  between(x, 0, 59)
}
fn is_hour12(x: i64) -> bool {
  between(x, 0, 12)
}
fn is_millisecond(x: i64) -> bool {
  between(x, 0, 999)
}

#[derive(Default)]
struct DayComposer {
  comp: [i64; 3],
  index: usize,
  named_month: Option<i64>,
  is_iso_date: bool,
}

impl DayComposer {
  fn add(&mut self, n: i64) -> bool {
    if self.index == 3 {
      return false;
    }
    self.comp[self.index] = n;
    self.index += 1;
    true
  }

  fn write(&mut self) -> Option<(i64, i64, i64)> {
    if self.index < 1 {
      return None;
    }
    while self.index < 3 {
      self.comp[self.index] = 1;
      self.index += 1;
    }
    let mut year = 0;
    let (month, day);
    match self.named_month {
      None => {
        if self.is_iso_date || (self.index == 3 && !is_day(self.comp[0])) {
          year = self.comp[0];
          month = self.comp[1];
          day = self.comp[2];
        } else {
          month = self.comp[0];
          day = self.comp[1];
          if self.index == 3 {
            year = self.comp[2];
          }
        }
      }
      Some(named) => {
        month = named;
        if self.index == 1 {
          day = self.comp[0];
        } else if !is_day(self.comp[0]) {
          year = self.comp[0];
          day = self.comp[1];
        } else {
          day = self.comp[0];
          year = self.comp[1];
        }
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
      return None;
    }
    Some((year, month - 1, day))
  }
}

struct TimeComposer {
  comp: [i64; 4],
  index: usize,
  hour_offset: i64,
}

impl Default for TimeComposer {
  fn default() -> Self {
    TimeComposer { comp: [0; 4], index: 0, hour_offset: NONE }
  }
}

impl TimeComposer {
  fn is_empty(&self) -> bool {
    self.index == 0
  }
  fn is_expecting(&self, n: i64) -> bool {
    (self.index == 1 && is_minute(n)) || (self.index == 2 && is_second(n)) || (self.index == 3 && is_millisecond(n))
  }
  fn add(&mut self, n: i64) -> bool {
    if self.index < 4 {
      self.comp[self.index] = n;
      self.index += 1;
      true
    } else {
      false
    }
  }
  fn add_final(&mut self, n: i64) -> bool {
    if !self.add(n) {
      return false;
    }
    while self.index < 4 {
      self.comp[self.index] = 0;
      self.index += 1;
    }
    true
  }
  fn write(&mut self) -> Option<[i64; 4]> {
    while self.index < 4 {
      self.comp[self.index] = 0;
      self.index += 1;
    }
    let [mut hour, minute, second, ms] = self.comp;
    if self.hour_offset != NONE {
      if !is_hour12(hour) {
        return None;
      }
      hour %= 12;
      hour += self.hour_offset;
    }
    if !is_hour(hour) || !is_minute(minute) || !is_second(second) || !is_millisecond(ms) {
      if hour != 24 || minute != 0 || second != 0 || ms != 0 {
        return None;
      }
    }
    Some([hour, minute, second, ms])
  }
}

struct TimeZoneComposer {
  sign: i64,
  hour: i64,
  minute: i64,
}

impl Default for TimeZoneComposer {
  fn default() -> Self {
    TimeZoneComposer { sign: NONE, hour: NONE, minute: NONE }
  }
}

impl TimeZoneComposer {
  fn set(&mut self, offset_hours: i64) {
    self.sign = if offset_hours < 0 { -1 } else { 1 };
    self.hour = offset_hours * self.sign;
    self.minute = 0;
  }
  fn is_expecting(&self, n: i64) -> bool {
    self.hour != NONE && self.minute == NONE && is_minute(n)
  }
  fn is_utc(&self) -> bool {
    self.hour == 0 && self.minute == 0
  }
  fn is_empty(&self) -> bool {
    self.hour == NONE
  }
  /// UTC offset in seconds, `None` for local time, `Err` for invalid.
  fn write(&mut self) -> Result<Option<i64>, ()> {
    if self.sign == NONE {
      return Ok(None);
    }
    if self.hour == NONE {
      self.hour = 0;
    }
    if self.minute == NONE {
      self.minute = 0;
    }
    let total = self.hour * 3600 + self.minute * 60;
    if total > (1 << 30) - 1 {
      return Err(());
    }
    Ok(Some(if self.sign < 0 { -total } else { total }))
  }
}

/// `ReadMilliseconds`
fn read_milliseconds(token: Token) -> i64 {
  let Token::Number { mut n, len } = token else { return 0 };
  let mut length = len;
  if length < 3 {
    if length == 1 {
      n *= 100;
    } else if length == 2 {
      n *= 10;
    }
  } else if length > 3 {
    if length > 9 {
      length = 9;
      // The tokenizer stops accumulating after 9 or 10 digits: keep the 9 most significant.
      while n >= 1_000_000_000 {
        n /= 10;
      }
    }
    let mut factor = 1;
    loop {
      factor *= 10;
      length -= 1;
      if length <= 3 {
        break;
      }
    }
    n /= factor;
  }
  n
}

/// `ParseES5DateTime`: returns the next unhandled token.
fn parse_es5(
  scanner: &mut Tokenizer,
  day: &mut DayComposer,
  time: &mut TimeComposer,
  tz: &mut TimeZoneComposer,
) -> Token {
  if scanner.peek().is_ascii_sign() {
    let sign_token = scanner.next();
    if !scanner.peek().is_fixed_length_number(6) {
      return sign_token;
    }
    let sign = sign_token.ascii_sign();
    let year = scanner.next().number();
    if sign < 0 && year == 0 {
      return sign_token;
    }
    day.add(sign * year);
  } else if scanner.peek().is_fixed_length_number(4) {
    let year = scanner.next().number();
    day.add(year);
  } else {
    return scanner.next();
  }
  if scanner.skip_symbol('-') {
    if !scanner.peek().is_fixed_length_number(2) || !is_month(scanner.peek().number()) {
      return scanner.next();
    }
    let month = scanner.next().number();
    day.add(month);
    if scanner.skip_symbol('-') {
      if !scanner.peek().is_fixed_length_number(2) || !is_day(scanner.peek().number()) {
        return scanner.next();
      }
      let d = scanner.next().number();
      day.add(d);
    }
  }
  if !scanner.peek().is_keyword_type(KeywordType::TimeSeparator) {
    if !matches!(scanner.peek(), Token::End) {
      return scanner.next();
    }
  } else {
    scanner.next();
    if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24) {
      return Token::Invalid;
    }
    let hour_is_24 = scanner.peek().number() == 24;
    let hour = scanner.next().number();
    time.add(hour);
    if !scanner.skip_symbol(':') {
      return Token::Invalid;
    }
    if !scanner.peek().is_fixed_length_number(2)
      || !is_minute(scanner.peek().number())
      || (hour_is_24 && scanner.peek().number() > 0)
    {
      return Token::Invalid;
    }
    let minute = scanner.next().number();
    time.add(minute);
    if scanner.skip_symbol(':') {
      if !scanner.peek().is_fixed_length_number(2)
        || !is_second(scanner.peek().number())
        || (hour_is_24 && scanner.peek().number() > 0)
      {
        return Token::Invalid;
      }
      let second = scanner.next().number();
      time.add(second);
      if scanner.skip_symbol('.') {
        if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
          return Token::Invalid;
        }
        let ms = read_milliseconds(scanner.next());
        time.add(ms);
      }
    }
    if scanner.peek().is_keyword_z() {
      scanner.next();
      tz.set(0);
    } else if scanner.peek().is_ascii_sign() {
      tz.sign = if scanner.next().is_symbol('+') { 1 } else { -1 };
      if scanner.peek().is_fixed_length_number(4) {
        let hourmin = scanner.next().number();
        let (h, m) = (hourmin / 100, hourmin % 100);
        if !is_hour(h) || !is_minute(m) {
          return Token::Invalid;
        }
        tz.hour = h;
        tz.minute = m;
      } else {
        if !scanner.peek().is_fixed_length_number(2) || !is_hour(scanner.peek().number()) {
          return Token::Invalid;
        }
        tz.hour = scanner.next().number();
        if !scanner.skip_symbol(':') {
          return Token::Invalid;
        }
        if !scanner.peek().is_fixed_length_number(2) || !is_minute(scanner.peek().number()) {
          return Token::Invalid;
        }
        tz.minute = scanner.next().number();
      }
    }
    if !matches!(scanner.peek(), Token::End) {
      return Token::Invalid;
    }
  }
  if tz.is_empty() && time.is_empty() {
    tz.set(0);
  }
  day.is_iso_date = true;
  Token::End
}

/// `DateParser::Parse`; returns the broken-down fields or `None` when invalid.
fn parse_fields(s: &str) -> Option<((i64, i64, i64), [i64; 4], Option<i64>)> {
  let mut scanner = Tokenizer::new(s);
  let mut day = DayComposer::default();
  let mut time = TimeComposer::default();
  let mut tz = TimeZoneComposer::default();
  let mut token = parse_es5(&mut scanner, &mut day, &mut time, &mut tz);
  if matches!(token, Token::Invalid) {
    return None;
  }
  let mut has_read_number = day.index > 0;
  while !matches!(token, Token::End) {
    match token {
      Token::Number { n, .. } => {
        has_read_number = true;
        if scanner.skip_symbol(':') {
          if scanner.skip_symbol(':') {
            if !time.is_empty() {
              return None;
            }
            time.add(n);
            time.add(0);
          } else {
            if !time.add(n) {
              return None;
            }
            if scanner.peek().is_symbol('.') {
              scanner.next();
            }
          }
        } else if scanner.skip_symbol('.') && time.is_expecting(n) {
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
          if !matches!(peek, Token::End | Token::WhiteSpace) && !peek.is_keyword_z() && !peek.is_ascii_sign() {
            return None;
          }
        } else {
          if !day.add(n) {
            return None;
          }
          scanner.skip_symbol('-');
        }
      }
      Token::Keyword { ty, value, .. } => {
        if ty == KeywordType::AmPm && !time.is_empty() {
          time.hour_offset = value;
        } else if ty == KeywordType::MonthName {
          day.named_month = Some(value);
          scanner.skip_symbol('-');
        } else if ty == KeywordType::TimeZoneName && has_read_number {
          tz.set(value);
        } else {
          if has_read_number {
            return None;
          }
          if scanner.peek().is_number() {
            return None;
          }
        }
      }
      t if t.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) => {
        tz.sign = t.ascii_sign();
        let (mut n, mut length) = (0, 0);
        if scanner.peek().is_number() {
          if let Token::Number { n: num, len } = scanner.next() {
            n = num;
            length = len;
          }
        }
        has_read_number = true;
        if scanner.peek().is_symbol(':') {
          tz.hour = n;
          tz.minute = NONE;
        } else if length == 2 || length == 1 {
          tz.hour = n;
          tz.minute = 0;
        } else if length == 4 || length == 3 {
          tz.hour = n / 100;
          tz.minute = n % 100;
        } else {
          return None;
        }
      }
      t if (t.is_ascii_sign() || t.is_symbol(')')) && has_read_number => return None,
      _ => {}
    }
    token = scanner.next();
  }
  let day_fields = day.write()?;
  let time_fields = time.write()?;
  let offset = tz.write().ok()?;
  Some((day_fields, time_fields, offset))
}

const MAX_TIME_IN_MS: f64 = 864e13;
const MAX_TIME_BEFORE_UTC_IN_MS: f64 = MAX_TIME_IN_MS + 864e6;

/// `Date.parse(string)` / `new Date(string).getTime()` (NaN for invalid dates).
pub fn parse(s: &str) -> f64 {
  let Some(((year, month0, day), [h, m, sec, ms], offset)) = parse_fields(s) else {
    return f64::NAN;
  };
  if year.abs() > 1_000_000_000 {
    return f64::NAN;
  }
  let date =
    days_from_civil(year, month0, day) * MS_PER_DAY + (h * 3_600_000 + m * 60_000 + sec * 1000 + ms) as f64;
  let utc = match offset {
    None => {
      if !(-MAX_TIME_BEFORE_UTC_IN_MS..=MAX_TIME_BEFORE_UTC_IN_MS).contains(&date) {
        return f64::NAN;
      }
      local_to_utc(date)
    }
    Some(offset) => {
      let d = date - offset as f64 * 1000.0;
      if !(-MAX_TIME_IN_MS..=MAX_TIME_IN_MS).contains(&d) {
        return f64::NAN;
      }
      d
    }
  };
  time_clip(utc)
}
