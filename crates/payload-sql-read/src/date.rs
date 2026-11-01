//! JS `Date` support shared by the engine crates: V8's `Date.parse` (a full
//! port of V8's `DateParser`, see [`crate::dateparse`]), `toISOString`, and
//! local-time conversion in the **process time zone** (libc `localtime_r`,
//! i.e. the `TZ` environment variable, like Node with system tz data).
//!
//! Results that involve local time (date strings without an offset, e.g.
//! `"2020-06-01T10:00:00"` or `"Sat Oct 31 2026"`) depend on `TZ`, exactly like
//! in Node. Node calls `tzset()` when `process.env.TZ` is assigned; Rust code
//! that changes `TZ` itself must call [`set_process_time_zone`].

use payload_engine::error::{EngineError, Result};

use crate::jsstr::JsStr;

unsafe extern "C" {
  fn tzset();
}

/// Sets `TZ` for the current process (`None` removes it) and reloads the libc
/// time zone state, like assigning `process.env.TZ` in Node.
///
/// # Safety
/// Mutates the process environment: no other thread may read or write
/// environment variables (or call libc time functions) concurrently.
pub unsafe fn set_process_time_zone(tz: Option<&str>) {
  // SAFETY: guaranteed by the caller.
  unsafe {
    match tz {
      Some(tz) => std::env::set_var("TZ", tz),
      None => std::env::remove_var("TZ"),
    }
    tzset();
  }
}

/// Re-reads `TZ` into the libc time zone state (`tzset()`).
pub fn reload_time_zone() {
  // SAFETY: tzset only reads the environment and updates libc's internal tz state.
  unsafe { tzset() }
}


pub const MS_PER_DAY: f64 = 86_400_000.0;

/// `MakeDay(year, month(0-based), date)` -> days since epoch.
pub fn days_from_civil(year: i64, month0: i64, day: i64) -> f64 {
  let y = year + month0.div_euclid(12);
  let m = month0.rem_euclid(12) + 1;
  // Howard Hinnant's days_from_civil for the first of the month.
  let y_adj = if m <= 2 { y - 1 } else { y };
  let era = y_adj.div_euclid(400);
  let yoe = y_adj - era * 400;
  let mp = (m + 9) % 12;
  let doy = (153 * mp + 2) / 5;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  (era * 146_097 + doe - 719_468 + (day - 1)) as f64
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
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
  if !t.is_finite() || t.abs() > 8.64e15 { f64::NAN } else { t.trunc() + 0.0 }
}

/// Offset of local time from UTC in milliseconds at UTC time `t`.
#[cfg(unix)]
pub fn local_offset_ms(t: f64) -> f64 {
  let secs = (t / 1000.0).floor() as libc::time_t;
  // SAFETY: localtime_r only writes into the provided `tm`.
  unsafe {
    let mut tm: libc::tm = std::mem::zeroed();
    if libc::localtime_r(&secs, &mut tm).is_null() {
      return 0.0;
    }
    tm.tm_gmtoff as f64 * 1000.0
  }
}

#[cfg(not(unix))]
pub fn local_offset_ms(_t: f64) -> f64 {
  0.0
}

/// `UTC(t)` for a local wall-clock time value: ambiguous times (repeated hour)
/// use the earlier instant, skipped times use the offset before the transition.
pub fn local_to_utc(local: f64) -> f64 {
  let before = local_offset_ms(local - MS_PER_DAY);
  let mut candidates = vec![before, local_offset_ms(local), local_offset_ms(local + MS_PER_DAY)];
  candidates.dedup();
  let valid = candidates.into_iter().filter(|o| local_offset_ms(local - o) == *o).fold(None, |acc: Option<f64>, o| {
    Some(acc.map_or(o, |a| a.max(o)))
  });
  local - valid.unwrap_or(before)
}

/// `Date.parse(string)` / `new Date(string).getTime()` in the process time zone
/// (NaN for invalid dates), see [`crate::dateparse`].
pub fn parse(s: &str) -> f64 {
  crate::dateparse::parse(s)
}

/// [`parse`] for any JS string. Lone surrogates are parsed as U+FFFD: V8's date
/// parser treats every code unit >= 0x80 that is not white space the same way
/// (an unknown word character), so the result is identical (covered by
/// test/__rs/read/dates.json).
pub fn parse_js(s: &JsStr) -> f64 {
  match s.as_str() {
    Some(s) => parse(s),
    None => parse(&s.to_lossy()),
  }
}

/// `new Date(string).toISOString()` (`RangeError` for invalid dates).
pub fn iso_from_string(s: &JsStr) -> Result<String> {
  to_iso_string(parse_js(s))
}

/// `Date.prototype.toISOString()` (throws `RangeError` for invalid dates).
pub fn to_iso_string(t: f64) -> Result<String> {
  if t.is_nan() {
    return Err(EngineError::new("RangeError", "Invalid time value"));
  }
  let ms_total = t as i64;
  let days = ms_total.div_euclid(MS_PER_DAY as i64);
  let ms_of_day = ms_total.rem_euclid(MS_PER_DAY as i64);
  let (y, m, d) = civil_from_days(days);
  let (h, mi, s, ms) = (ms_of_day / 3_600_000, (ms_of_day / 60_000) % 60, (ms_of_day / 1000) % 60, ms_of_day % 1000);
  let year = if (0..=9999).contains(&y) {
    format!("{y:04}")
  } else if y < 0 {
    format!("-{:06}", -y)
  } else {
    format!("+{y:06}")
  };
  Ok(format!("{year}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z"))
}

/// Approximation of `Date.prototype.toString()`, only reachable when a `Date`
/// is used as a property key (never for sqlite rows).
pub fn date_to_string(t: f64) -> String {
  to_iso_string(t).unwrap_or_else(|_| "Invalid Date".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn parse_date(s: &str) -> Result<f64> {
    Ok(parse(s))
  }

  #[test]
  fn iso_dates() {
    let iso = |s: &str| to_iso_string(parse_date(s).unwrap()).unwrap();
    assert_eq!(iso("2020-01-01T10:00:00.123456Z"), "2020-01-01T10:00:00.123Z");
    assert_eq!(iso("2020-01-01t10:00:00z"), "2020-01-01T10:00:00.000Z");
    assert_eq!(iso("2020-01-01T24:00:00Z"), "2020-01-02T00:00:00.000Z");
    assert_eq!(iso("2020"), "2020-01-01T00:00:00.000Z");
    assert_eq!(iso("+002020-01-01"), "2020-01-01T00:00:00.000Z");
    assert_eq!(iso("2020-01-01T10:00:00+01:00"), "2020-01-01T09:00:00.000Z");
    assert_eq!(iso("2019-02-29T00:00:00Z"), "2019-03-01T00:00:00.000Z");
    assert_eq!(iso("1969-12-31T23:59:59.999Z"), "1969-12-31T23:59:59.999Z");
    assert!(parse_date("2020-01-01T10Z").unwrap().is_nan());
    assert!(parse_date("2020-13-01").unwrap().is_nan());
  }
}
