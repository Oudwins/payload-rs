//! The process time zone, as V8 (ICU) applies it in `Date.parse` for local date-times.
//!
//! V8's `DateCache::ToUTC(t)` is `t - LocalOffsetInMs(t, is_utc = false)`, where the offset comes
//! from ICU's `BasicTimeZone::getOffsetFromLocal(t, UCAL_TZ_LOCAL_FORMER, UCAL_TZ_LOCAL_FORMER)`:
//! a local time inside a gap (spring forward) or an overlap (fall back) is interpreted with the
//! offset in effect *before* the transition. The zone is the one ICU detects for the host: `TZ`
//! (re-read on every call, so `process.env.TZ = ...` is followed like Node does), else
//! `/etc/localtime`; an unknown zone is UTC.
//!
//! Zone data is read from the system TZif files (`$TZDIR` or `/usr/share/zoneinfo`): the 64-bit
//! transition table plus the POSIX TZ footer rule for instants after the last transition (RFC
//! 8536). Node's bundled ICU data and the system tzdata must be the same release for exact
//! results (`process.versions.tz` vs `/usr/share/zoneinfo/+VERSION`).

use std::sync::{Arc, Mutex};

const MS_PER_DAY: i64 = 86_400_000;

/// Converts a local wall-clock time value (ms) to UTC in the current process time zone.
pub fn local_to_utc(local_ms: i64) -> f64 {
  process_zone().local_to_utc(local_ms) as f64
}

/// A time zone: transitions (UTC seconds) with the offset (seconds) in effect from each one, the
/// offset before the first transition and an optional rule for instants after the last one.
#[derive(Debug)]
pub struct Zone {
  initial_offset: i64,
  transitions: Vec<(i64, i64)>,
  footer: Option<PosixRule>,
}

impl Zone {
  pub fn utc() -> Self {
    Zone { initial_offset: 0, transitions: Vec::new(), footer: None }
  }

  /// Loads a zone by IANA name (`Europe/Lisbon`) from the zoneinfo directory.
  pub fn named(name: &str) -> Option<Self> {
    let name = name.strip_prefix(':').unwrap_or(name);
    if name.is_empty() || name.split('/').any(|part| part == "..") {
      return None;
    }
    let dir = std::env::var("TZDIR").unwrap_or_else(|_| "/usr/share/zoneinfo".into());
    Self::from_file(&format!("{dir}/{name}"))
  }

  pub fn from_file(path: &str) -> Option<Self> {
    parse_tzif(&std::fs::read(path).ok()?)
  }

  /// Total UTC offset in seconds at a UTC instant (seconds).
  pub fn offset_at_utc(&self, t: i64) -> i64 {
    match self.transitions.partition_point(|(at, _)| *at <= t) {
      0 => self.initial_offset,
      i if i == self.transitions.len() => match &self.footer {
        Some(rule) => rule.offset_at_utc(t),
        None => self.transitions[i - 1].1,
      },
      i => self.transitions[i - 1].1,
    }
  }

  fn offset_at_utc_ms(&self, t_ms: i64) -> i64 {
    self.offset_at_utc(t_ms.div_euclid(1000)) * 1000
  }

  /// `UCAL_TZ_LOCAL_FORMER` for both gaps and overlaps. Assumes at most one transition within
  /// a day of the local time (true for all tzdata zones).
  pub fn local_to_utc(&self, local_ms: i64) -> i64 {
    let before = self.offset_at_utc_ms(local_ms.saturating_sub(MS_PER_DAY));
    let after = self.offset_at_utc_ms(local_ms.saturating_add(MS_PER_DAY));
    let with_before = local_ms - before;
    if before == after || self.offset_at_utc_ms(with_before) == before {
      return with_before;
    }
    let with_after = local_ms - after;
    if self.offset_at_utc_ms(with_after) == after {
      return with_after;
    }
    // In the gap of a forward transition: the offset before it applies.
    with_before
  }
}

static PROCESS_ZONE: Mutex<Option<(Option<String>, Arc<Zone>)>> = Mutex::new(None);

/// The zone for the current `TZ` value, cached until `TZ` changes.
pub fn process_zone() -> Arc<Zone> {
  let tz = std::env::var("TZ").ok();
  let mut cache = PROCESS_ZONE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  if let Some((cached_tz, zone)) = cache.as_ref()
    && *cached_tz == tz
  {
    return zone.clone();
  }
  let zone = Arc::new(match &tz {
    Some(name) => Zone::named(name).unwrap_or_else(Zone::utc),
    None => Zone::from_file("/etc/localtime").unwrap_or_else(Zone::utc),
  });
  *cache = Some((tz, zone.clone()));
  zone
}

// ---------------------------------------------------------------------------------------------
// TZif (RFC 8536)

struct Reader<'a> {
  bytes: &'a [u8],
  pos: usize,
}

impl<'a> Reader<'a> {
  fn take(&mut self, n: usize) -> Option<&'a [u8]> {
    let out = self.bytes.get(self.pos..self.pos.checked_add(n)?)?;
    self.pos += n;
    Some(out)
  }
  fn u32(&mut self) -> Option<u32> {
    Some(u32::from_be_bytes(self.take(4)?.try_into().ok()?))
  }
  fn i32(&mut self) -> Option<i32> {
    Some(i32::from_be_bytes(self.take(4)?.try_into().ok()?))
  }
  fn i64(&mut self) -> Option<i64> {
    Some(i64::from_be_bytes(self.take(8)?.try_into().ok()?))
  }
}

struct Header {
  version: u8,
  isutcnt: usize,
  isstdcnt: usize,
  leapcnt: usize,
  timecnt: usize,
  typecnt: usize,
  charcnt: usize,
}

fn header(r: &mut Reader) -> Option<Header> {
  if r.take(4)? != b"TZif" {
    return None;
  }
  let version = r.take(1)?[0];
  r.take(15)?;
  let mut counts = [0usize; 6];
  for count in &mut counts {
    *count = r.u32()? as usize;
  }
  let [isutcnt, isstdcnt, leapcnt, timecnt, typecnt, charcnt] = counts;
  Some(Header { version, isutcnt, isstdcnt, leapcnt, timecnt, typecnt, charcnt })
}

fn parse_tzif(bytes: &[u8]) -> Option<Zone> {
  let mut r = Reader { bytes, pos: 0 };
  let mut h = header(&mut r)?;
  let mut time_size = 4;
  if h.version >= b'2' {
    // Skip the v1 block; the v2+ block has 64-bit times.
    r.take(h.timecnt * 5 + h.typecnt * 6 + h.charcnt + h.leapcnt * 8 + h.isstdcnt + h.isutcnt)?;
    h = header(&mut r)?;
    time_size = 8;
  }
  let mut times = Vec::with_capacity(h.timecnt);
  for _ in 0..h.timecnt {
    times.push(if time_size == 8 { r.i64()? } else { i64::from(r.i32()?) });
  }
  let indices = r.take(h.timecnt)?.to_vec();
  let mut offsets = Vec::with_capacity(h.typecnt);
  for _ in 0..h.typecnt {
    offsets.push(i64::from(r.i32()?));
    r.take(2)?;
  }
  if offsets.is_empty() {
    return None;
  }
  r.take(h.charcnt + h.leapcnt * (time_size + 4) + h.isstdcnt + h.isutcnt)?;

  let transitions = times
    .into_iter()
    .zip(indices)
    .map(|(at, index)| Some((at, *offsets.get(index as usize)?)))
    .collect::<Option<Vec<_>>>()?;

  let footer = if h.version >= b'2' {
    let rest = std::str::from_utf8(r.bytes.get(r.pos..)?).ok()?;
    let rule = rest.strip_prefix('\n')?.split('\n').next()?;
    if rule.is_empty() { None } else { PosixRule::parse(rule) }
  } else {
    None
  };

  Some(Zone { initial_offset: offsets[0], transitions, footer })
}

// ---------------------------------------------------------------------------------------------
// POSIX TZ strings (`EST5EDT,M3.2.0,M11.1.0`, `<-03>3`, `WET0WEST,M3.5.0/1,M10.5.0`)

#[derive(Debug)]
pub struct PosixRule {
  /// UTC offsets in seconds (east positive, i.e. the negated POSIX offsets).
  std_offset: i64,
  dst: Option<DstRule>,
}

#[derive(Debug)]
struct DstRule {
  offset: i64,
  start: (DateRule, i64),
  end: (DateRule, i64),
}

#[derive(Debug, Clone, Copy)]
enum DateRule {
  /// `Jn`: day 1..=365, February 29 never counted.
  Julian1(i64),
  /// `n`: day 0..=365, February 29 counted in leap years.
  Julian0(i64),
  /// `Mm.w.d`
  MonthWeekDay { month: i64, week: i64, weekday: i64 },
}

impl PosixRule {
  pub fn parse(s: &str) -> Option<Self> {
    let mut p = Parser { s: s.as_bytes(), pos: 0 };
    p.name()?;
    let std_offset = -p.offset()?;
    if p.done() {
      return Some(PosixRule { std_offset, dst: None });
    }
    p.name()?;
    let dst_offset = if p.peek() == Some(b',') { std_offset + 3600 } else { -p.offset()? };
    p.expect(b',')?;
    let start = p.date_time()?;
    p.expect(b',')?;
    let end = p.date_time()?;
    p.done().then_some(PosixRule { std_offset, dst: Some(DstRule { offset: dst_offset, start, end }) })
  }

  fn offset_at_utc(&self, t: i64) -> i64 {
    let Some(dst) = &self.dst else { return self.std_offset };
    let year = civil_from_days((t + self.std_offset).div_euclid(86_400)).0;
    // Check the transitions of the neighbouring years too, for rules that cross a year end.
    let mut state = None;
    for y in [year - 1, year, year + 1] {
      let start = dst.start.0.day(y) * 86_400 + dst.start.1 - self.std_offset;
      let end = dst.end.0.day(y) * 86_400 + dst.end.1 - dst.offset;
      for (at, is_dst) in [(start, true), (end, false)] {
        if at <= t && state.is_none_or(|(prev, _)| at >= prev) {
          state = Some((at, is_dst));
        }
      }
    }
    match state {
      Some((_, true)) => dst.offset,
      _ => self.std_offset,
    }
  }
}

impl DateRule {
  /// Days since 1970-01-01 of the rule's date in `year`.
  fn day(self, year: i64) -> i64 {
    let jan1 = days_from_civil(year, 1, 1);
    match self {
      DateRule::Julian1(n) => {
        let leap_shift = if is_leap(year) && n >= 60 { 1 } else { 0 };
        jan1 + n - 1 + leap_shift
      }
      DateRule::Julian0(n) => jan1 + n,
      DateRule::MonthWeekDay { month, week, weekday } => {
        let first = days_from_civil(year, month, 1);
        let first_weekday = (first + 4).rem_euclid(7);
        let mut day = first + (weekday - first_weekday).rem_euclid(7) + (week - 1) * 7;
        if week == 5 {
          let next_month = if month == 12 { days_from_civil(year + 1, 1, 1) } else { days_from_civil(year, month + 1, 1) };
          while day >= next_month {
            day -= 7;
          }
        }
        day
      }
    }
  }
}

struct Parser<'a> {
  s: &'a [u8],
  pos: usize,
}

impl Parser<'_> {
  fn peek(&self) -> Option<u8> {
    self.s.get(self.pos).copied()
  }
  fn done(&self) -> bool {
    self.pos == self.s.len()
  }
  fn expect(&mut self, c: u8) -> Option<()> {
    (self.peek()? == c).then(|| self.pos += 1)
  }
  fn name(&mut self) -> Option<()> {
    let start = self.pos;
    if self.peek() == Some(b'<') {
      while self.peek()? != b'>' {
        self.pos += 1;
      }
      self.pos += 1;
      return Some(());
    }
    while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
      self.pos += 1;
    }
    (self.pos - start >= 3).then_some(())
  }
  fn number(&mut self) -> Option<i64> {
    let start = self.pos;
    while self.peek().is_some_and(|c| c.is_ascii_digit()) {
      self.pos += 1;
    }
    std::str::from_utf8(&self.s[start..self.pos]).ok()?.parse().ok()
  }
  /// `[+-]hh[:mm[:ss]]` in seconds (POSIX sign: positive is west of UTC).
  fn offset(&mut self) -> Option<i64> {
    let sign = match self.peek() {
      Some(b'-') => {
        self.pos += 1;
        -1
      }
      Some(b'+') => {
        self.pos += 1;
        1
      }
      _ => 1,
    };
    let mut seconds = self.number()? * 3600;
    for unit in [60, 1] {
      if self.peek() != Some(b':') {
        break;
      }
      self.pos += 1;
      seconds += self.number()? * unit;
    }
    Some(sign * seconds)
  }
  fn date_time(&mut self) -> Option<(DateRule, i64)> {
    let rule = match self.peek()? {
      b'J' => {
        self.pos += 1;
        DateRule::Julian1(self.number()?)
      }
      b'M' => {
        self.pos += 1;
        let month = self.number()?;
        self.expect(b'.')?;
        let week = self.number()?;
        self.expect(b'.')?;
        let weekday = self.number()?;
        DateRule::MonthWeekDay { month, week, weekday }
      }
      _ => DateRule::Julian0(self.number()?),
    };
    let time = if self.peek() == Some(b'/') {
      self.pos += 1;
      self.offset()?
    } else {
      7200
    };
    Some((rule, time))
  }
}

fn is_leap(year: i64) -> bool {
  year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// Days since 1970-01-01 (proleptic Gregorian), H. Hinnant's algorithm.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let y = if month <= 2 { year - 1 } else { year };
  let era = y.div_euclid(400);
  let yoe = y - era * 400;
  let mp = (month + 9) % 12;
  let doy = (153 * mp + 2) / 5 + day - 1;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  (yoe + era * 400 + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn posix_rules() {
    let ny = PosixRule::parse("EST5EDT,M3.2.0,M11.1.0").expect("parses");
    // 2024-03-10T07:00Z: DST starts (02:00 EST)
    assert_eq!(ny.offset_at_utc(1_710_053_999), -5 * 3600);
    assert_eq!(ny.offset_at_utc(1_710_054_000), -4 * 3600);
    // 2024-11-03T06:00Z: DST ends (02:00 EDT)
    assert_eq!(ny.offset_at_utc(1_730_613_599), -4 * 3600);
    assert_eq!(ny.offset_at_utc(1_730_613_600), -5 * 3600);
    let lisbon = PosixRule::parse("WET0WEST,M3.5.0/1,M10.5.0").expect("parses");
    assert_eq!(lisbon.offset_at_utc(1_711_846_800), 3600);
    assert_eq!(lisbon.offset_at_utc(1_711_846_799), 0);
    assert_eq!(PosixRule::parse("<-03>3").expect("parses").offset_at_utc(0), -3 * 3600);
  }

  #[test]
  fn civil_round_trip() {
    for days in [-100_000_000, -719_468, -1, 0, 1, 19_000, 100_000_000] {
      let (y, m, d) = civil_from_days(days);
      assert_eq!(days_from_civil(y, m, d), days);
    }
  }
}
