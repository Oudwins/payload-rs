//! Port of the client configuration pipeline of `@libsql/client` for local
//! databases:
//!
//! - `@libsql/core/lib-esm/uri.js`: `parseUri`, `parseAuthority`, `parseQuery`, `percentDecode`
//! - `@libsql/core/lib-esm/config.js`: `expandConfig`, `isInMemoryConfig`
//! - `@libsql/client/lib-esm/sqlite3.js`: the URL checks of `_createClient`
//!
//! The result is the path and options handed to `new Database(path, opts)`
//! plus the `intMode`.

use crate::conn::OpenOptions;
use crate::error::{ClientError, Result};
use crate::value::IntMode;

const SUPPORTED_URL_LINK: &str = "https://github.com/libsql/libsql-client-ts#supported-urls";

/// The parts of the JS `Config` object the local client looks at.
#[derive(Clone, Debug, Default)]
pub struct ClientConfig {
  /// `String(config.url)`.
  pub url: String,
  /// `JSON.stringify(config.intMode ?? "number")` (or `"undefined"` when not
  /// JSON serializable), used for the exact `TypeError` message.
  pub int_mode_json: String,
  /// Whether `config.syncUrl` is truthy.
  pub sync_url: bool,
  /// Whether `config.authToken` is a string, `null` or `undefined`. The
  /// binding reads `opts.authToken ?? ""` as a string argument, so any other
  /// value makes `new Database` throw (unless the URL sets `authToken`).
  pub is_auth_token_valid: bool,
  /// `config.encryptionKey ?? ""` when it is a string.
  pub encryption_key: String,
  /// Whether `config.encryptionKey` is a string, `null` or `undefined`
  /// (read like `authToken`).
  pub is_encryption_key_valid: bool,
}

/// Where and how to open the database.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenTarget {
  /// The path passed to `new Database(path, opts)`.
  pub path: String,
  /// The parts of `opts` that reach SQLite.
  pub options: OpenOptions,
  pub int_mode: IntMode,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Userinfo {
  pub username: String,
  pub password: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Authority {
  pub host: String,
  pub port: Option<f64>,
  pub userinfo: Option<Userinfo>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Uri {
  pub scheme: String,
  pub authority: Option<Authority>,
  pub path: String,
  pub query: Option<Vec<(String, String)>>,
  pub fragment: Option<String>,
}

fn json_str(s: &str) -> String {
  serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

/// Port of `parseUri` (URI_RE =
/// `^(?<scheme>[A-Za-z][A-Za-z.+-]*):(//(?<authority>[^/?#]*))?(?<path>[^?#]*)(\?(?<query>[^#]*))?(#(?<fragment>.*))?$`).
pub fn parse_uri(text: &str) -> Result<Uri> {
  let invalid = || ClientError::libsql(format!("The URL '{text}' is not in a valid format"), "URL_INVALID");
  let mut chars = text.char_indices();
  match chars.next() {
    Some((_, c)) if c.is_ascii_alphabetic() => {}
    _ => return Err(invalid()),
  }
  let scheme_end = text
    .char_indices()
    .skip(1)
    .find(|&(_, c)| !(c.is_ascii_alphabetic() || c == '.' || c == '+' || c == '-'))
    .map(|(i, _)| i)
    .unwrap_or(text.len());
  if !text[scheme_end..].starts_with(':') {
    return Err(invalid());
  }
  let scheme = text[..scheme_end].to_string();
  let mut rest = &text[scheme_end + 1..];

  let mut authority_text = None;
  if let Some(after) = rest.strip_prefix("//") {
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    authority_text = Some(&after[..end]);
    rest = &after[end..];
  }
  let path_end = rest.find(['?', '#']).unwrap_or(rest.len());
  let path_text = &rest[..path_end];
  rest = &rest[path_end..];
  let mut query_text = None;
  if let Some(after) = rest.strip_prefix('?') {
    let end = after.find('#').unwrap_or(after.len());
    query_text = Some(&after[..end]);
    rest = &after[end..];
  }
  let fragment_text = rest.strip_prefix('#');

  let authority = authority_text.map(parse_authority).transpose()?;
  let path = percent_decode(path_text)?;
  let query = query_text.map(parse_query).transpose()?;
  let fragment = fragment_text.map(percent_decode).transpose()?;
  Ok(Uri { scheme, authority, path, query, fragment })
}

/// Matches `((?<host>[^:\[\]]*)|(\[(?<host_br>[^\[\]]*)\]))(:(?<port>[0-9]*))?$`
/// against `s`, returning `(host, host_br, port)`.
fn port_of(tail: &str) -> Option<Option<&str>> {
  if tail.is_empty() {
    return Some(None);
  }
  let digits = tail.strip_prefix(':')?;
  digits.bytes().all(|b| b.is_ascii_digit()).then_some(Some(digits))
}

fn match_host_port(s: &str) -> Option<(Option<&str>, Option<&str>, Option<&str>)> {
  // Alternative 1: greedy `[^:\[\]]*`. A shorter host is always followed by a
  // host character, so only the maximal run can succeed.
  let host_end = s.find([':', '[', ']']).unwrap_or(s.len());
  if let Some(port) = port_of(&s[host_end..]) {
    return Some((Some(&s[..host_end]), None, port));
  }
  // Alternative 2: `\[[^\[\]]*\]`.
  let inner = s.strip_prefix('[')?;
  let close = inner.find(['[', ']'])?;
  if inner.as_bytes()[close] != b']' {
    return None;
  }
  let port = port_of(&inner[close + 1..])?;
  Some((None, Some(&inner[..close]), port))
}

/// Port of `parseAuthority` (AUTHORITY_RE =
/// `^((?<username>[^:]*)(:(?<password>.*))?@)?((?<host>[^:\[\]]*)|(\[(?<host_br>[^\[\]]*)\]))(:(?<port>[0-9]*))?$`),
/// enumerating the regex alternatives in JS backtracking priority order.
pub fn parse_authority(text: &str) -> Result<Authority> {
  type Groups<'a> = (Option<&'a str>, Option<&'a str>, Option<&'a str>, Option<&'a str>, Option<&'a str>);
  let matched = (|| -> Option<Groups<'_>> {
    // Userinfo present: username `[^:]*` greedy, longest first.
    let max_user = text.find(':').unwrap_or(text.len());
    let boundaries: Vec<usize> = text[..max_user]
      .char_indices()
      .map(|(i, _)| i)
      .chain(std::iter::once(max_user))
      .collect();
    for &user_end in boundaries.iter().rev() {
      let username = &text[..user_end];
      let after_user = &text[user_end..];
      // `(:(?<password>.*))?` is tried first (greedy optional).
      if let Some(pw_rest) = after_user.strip_prefix(':') {
        let mut ends: Vec<usize> = pw_rest.char_indices().map(|(i, _)| i).collect();
        ends.push(pw_rest.len());
        for &pw_end in ends.iter().rev() {
          if let Some(tail) = pw_rest[pw_end..].strip_prefix('@') {
            if let Some((host, host_br, port)) = match_host_port(tail) {
              return Some((Some(username), Some(&pw_rest[..pw_end]), host, host_br, port));
            }
          }
        }
      }
      if let Some(tail) = after_user.strip_prefix('@') {
        if let Some((host, host_br, port)) = match_host_port(tail) {
          return Some((Some(username), None, host, host_br, port));
        }
      }
    }
    let (host, host_br, port) = match_host_port(text)?;
    Some((None, None, host, host_br, port))
  })();
  let Some((username, password, host, host_br, port)) = matched else {
    return Err(ClientError::libsql(
      "The authority part of the URL is not in a valid format",
      "URL_INVALID",
    ));
  };
  let host = percent_decode(host_br.or(host).unwrap_or(""))?;
  // `groups["port"] ? parseInt(groups["port"], 10) : undefined`
  let port = match port {
    Some(p) if !p.is_empty() => Some(p.parse::<f64>().unwrap_or(f64::NAN)),
    _ => None,
  };
  let userinfo = match username {
    Some(username) => Some(Userinfo {
      username: percent_decode(username)?,
      password: password.map(percent_decode).transpose()?,
    }),
    None => None,
  };
  Ok(Authority { host, port, userinfo })
}

/// Port of `parseQuery`.
fn parse_query(text: &str) -> Result<Vec<(String, String)>> {
  let mut pairs = Vec::new();
  for sequence in text.split('&') {
    if sequence.is_empty() {
      continue;
    }
    let (key, value) = match sequence.find('=') {
      Some(i) => (&sequence[..i], &sequence[i + 1..]),
      None => (sequence, ""),
    };
    pairs.push((percent_decode(&key.replace('+', " "))?, percent_decode(&value.replace('+', " "))?));
  }
  Ok(pairs)
}

fn hex_val(b: u8) -> Option<u8> {
  match b {
    b'0'..=b'9' => Some(b - b'0'),
    b'a'..=b'f' => Some(b - b'a' + 10),
    b'A'..=b'F' => Some(b - b'A' + 10),
    _ => None,
  }
}

/// JS `decodeURIComponent` (ECMA-262 `Decode` with an empty reserved set).
pub fn decode_uri_component(text: &str) -> std::result::Result<String, ()> {
  let bytes = text.as_bytes();
  let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
  let read_escape = |i: usize| -> Option<u8> {
    if bytes.get(i) != Some(&b'%') {
      return None;
    }
    let hi = hex_val(*bytes.get(i + 1)?)?;
    let lo = hex_val(*bytes.get(i + 2)?)?;
    Some(hi * 16 + lo)
  };
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] != b'%' {
      out.push(bytes[i]);
      i += 1;
      continue;
    }
    let b = read_escape(i).ok_or(())?;
    i += 3;
    if b < 0x80 {
      out.push(b);
      continue;
    }
    let n = if b & 0xE0 == 0xC0 {
      2
    } else if b & 0xF0 == 0xE0 {
      3
    } else if b & 0xF8 == 0xF0 {
      4
    } else {
      return Err(());
    };
    let mut seq = vec![b];
    for _ in 1..n {
      let c = read_escape(i).ok_or(())?;
      if c & 0xC0 != 0x80 {
        return Err(());
      }
      seq.push(c);
      i += 3;
    }
    let decoded = std::str::from_utf8(&seq).map_err(|_| ())?;
    out.extend_from_slice(decoded.as_bytes());
  }
  String::from_utf8(out).map_err(|_| ())
}

/// Port of `percentDecode`.
fn percent_decode(text: &str) -> Result<String> {
  decode_uri_component(text).map_err(|()| ClientError::UriMalformed {
    message: "URL component has invalid percent encoding: URIError: URI malformed".to_string(),
  })
}

/// Port of `expandConfig(config, true)` followed by the local-file checks of
/// `sqlite3.js` `_createClient`.
pub fn resolve_config(config: &ClientConfig) -> Result<OpenTarget> {
  let mut url = config.url.as_str();
  if url == ":memory:" {
    url = "file::memory:";
  }
  let uri = parse_uri(url)?;
  let original_scheme = uri.scheme.to_lowercase();
  let is_in_memory_mode = original_scheme == "file" && uri.path == ":memory:" && uri.authority.is_none();

  let mut tls: Option<bool> = None;
  let mut has_url_auth_token = false;
  let mut connection_query_params: Vec<String> = Vec::new();
  for (key, value) in uri.query.iter().flatten() {
    if is_in_memory_mode {
      if key != "cache" {
        return Err(ClientError::libsql(
          format!("Unsupported URL query parameter {}", json_str(key)),
          "URL_PARAM_NOT_SUPPORTED",
        ));
      }
      if value != "shared" && value != "private" {
        return Err(ClientError::libsql(
          format!(
            "Unknown value for the \"{key}\" query argument: {}. Supported values are: [\"shared\", \"private\"]",
            json_str(value)
          ),
          "URL_INVALID",
        ));
      }
      connection_query_params.push(format!("{key}={value}"));
    } else {
      match key.as_str() {
        "tls" => {
          if value != "0" && value != "1" {
            return Err(ClientError::libsql(
              format!(
                "Unknown value for the \"{key}\" query argument: {}. Supported values are: [\"0\", \"1\"]",
                json_str(value)
              ),
              "URL_INVALID",
            ));
          }
          tls = Some(value == "1");
        }
        "authToken" => has_url_auth_token = true,
        _ => {
          return Err(ClientError::libsql(
            format!("Unsupported URL query parameter {}", json_str(key)),
            "URL_PARAM_NOT_SUPPORTED",
          ));
        }
      }
    }
  }
  let query_string = if connection_query_params.is_empty() {
    String::new()
  } else {
    format!("?{}", connection_query_params.join("&"))
  };
  let path = format!("{}{}", uri.path, query_string);

  let scheme = if original_scheme == "libsql" {
    if tls == Some(false) {
      if uri.authority.as_ref().and_then(|a| a.port).is_none() {
        return Err(ClientError::libsql(
          "A \"libsql:\" URL with ?tls=0 must specify an explicit port",
          "URL_INVALID",
        ));
      }
      "http".to_string()
    } else {
      "https".to_string()
    }
  } else {
    original_scheme
  };
  if !matches!(scheme.as_str(), "http" | "ws" | "https" | "wss" | "file") {
    return Err(ClientError::libsql(
      format!(
        "The client supports only \"libsql:\", \"wss:\", \"ws:\", \"https:\", \"http:\" and \"file:\" URLs, got {}. For more information, please read {SUPPORTED_URL_LINK}",
        json_str(&format!("{}:", uri.scheme))
      ),
      "URL_SCHEME_NOT_SUPPORTED",
    ));
  }
  let int_mode = match config.int_mode_json.as_str() {
    "\"number\"" => IntMode::Number,
    "\"bigint\"" => IntMode::Bigint,
    "\"string\"" => IntMode::String,
    other => {
      return Err(ClientError::Type(format!(
        "Invalid value for intMode, expected \"number\", \"bigint\" or \"string\", got {other}"
      )));
    }
  };
  if let Some(fragment) = &uri.fragment {
    return Err(ClientError::libsql(
      format!("URL fragments are not supported: {}", json_str(&format!("#{fragment}"))),
      "URL_INVALID",
    ));
  }

  // --- sqlite3.js `_createClient` ---
  if scheme != "file" {
    // `node.js` would build a remote (ws/http) client here. Only the local
    // sqlite3 driver is backed by the Rust runtime.
    return Err(ClientError::libsql(
      format!(
        "URL scheme {} is not supported by the local sqlite3 client. For more information, please read {SUPPORTED_URL_LINK}",
        json_str(&format!("{scheme}:"))
      ),
      "URL_SCHEME_NOT_SUPPORTED",
    ));
  }
  let authority = if is_in_memory_mode { None } else { uri.authority.as_ref() };
  if let Some(authority) = authority {
    let host = authority.host.to_lowercase();
    if !host.is_empty() && host != "localhost" {
      return Err(ClientError::libsql(
        format!(
          "Invalid host in file URL: {}. A \"file:\" URL with an absolute path should start with one slash (\"file:/absolute/path.db\") or with three slashes (\"file:///absolute/path.db\"). For more information, please read {SUPPORTED_URL_LINK}",
          json_str(&authority.host)
        ),
        "URL_INVALID",
      ));
    }
    if authority.port.is_some() {
      return Err(ClientError::libsql("File URL cannot have a port", "URL_INVALID"));
    }
    if authority.userinfo.is_some() {
      return Err(ClientError::libsql("File URL cannot have username and password", "URL_INVALID"));
    }
  }
  // isInMemoryConfig
  let is_in_memory = path == ":memory:" || path.starts_with(":memory:?");
  if is_in_memory && config.sync_url {
    return Err(ClientError::libsql(
      format!(
        "Embedded replica must use file for local db but URI with in-memory mode were provided instead: {path}"
      ),
      "URL_INVALID",
    ));
  }
  if config.sync_url {
    return Err(ClientError::libsql(
      "Embedded replicas (syncUrl) are not supported by the Rust SQLite runtime",
      "URL_SCHEME_NOT_SUPPORTED",
    ));
  }
  let path = if is_in_memory { format!("file:{path}") } else { path };
  // `new Database(path, opts)`: the binding reads `authToken`, then
  // `encryptionKey` as string arguments (neon `cx.argument::<JsString>`).
  // `expandConfig` drops both (`undefined`) for in-memory URLs.
  let options = if is_in_memory_mode {
    OpenOptions::default()
  } else {
    if !(has_url_auth_token || config.is_auth_token_valid) || !config.is_encryption_key_valid {
      return Err(ClientError::Type("failed to downcast any to string".to_string()));
    }
    OpenOptions { encryption_key: config.encryption_key.as_bytes().to_vec() }
  };
  Ok(OpenTarget { path, options, int_mode })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn cfg(url: &str) -> ClientConfig {
    ClientConfig {
      url: url.to_string(),
      int_mode_json: "\"number\"".to_string(),
      is_auth_token_valid: true,
      is_encryption_key_valid: true,
      ..Default::default()
    }
  }

  #[test]
  fn resolves_file_paths() {
    assert_eq!(resolve_config(&cfg("file:./payload.db")).unwrap().path, "./payload.db");
    assert_eq!(resolve_config(&cfg("file:/tmp/x.db")).unwrap().path, "/tmp/x.db");
    assert_eq!(resolve_config(&cfg("file:///tmp/x.db")).unwrap().path, "/tmp/x.db");
    assert_eq!(resolve_config(&cfg("file://localhost/tmp/x.db")).unwrap().path, "/tmp/x.db");
    assert_eq!(resolve_config(&cfg(":memory:")).unwrap().path, "file::memory:");
    assert_eq!(resolve_config(&cfg("file::memory:?cache=shared")).unwrap().path, "file::memory:?cache=shared");
    assert_eq!(resolve_config(&cfg("file:a%20b.db")).unwrap().path, "a b.db");
  }

  #[test]
  fn authority_backtracking() {
    let a = parse_authority("a:b@c@d").unwrap();
    assert_eq!(a.host, "d");
    assert_eq!(a.userinfo.unwrap().password.as_deref(), Some("b@c"));
    let a = parse_authority("a@b@c").unwrap();
    assert_eq!(a.host, "c");
    assert_eq!(a.userinfo.unwrap().username, "a@b");
    assert!(parse_authority("a@b@c:x").is_err());
    let a = parse_authority("[::1]:80").unwrap();
    assert_eq!(a.host, "::1");
    assert_eq!(a.port, Some(80.0));
  }

  #[test]
  fn decodes_like_js() {
    assert_eq!(decode_uri_component("%E2%82%AC%2F").unwrap(), "€/");
    assert!(decode_uri_component("%E2%82").is_err());
    assert!(decode_uri_component("%zz").is_err());
    assert!(decode_uri_component("%C0%AF").is_err());
  }
}
