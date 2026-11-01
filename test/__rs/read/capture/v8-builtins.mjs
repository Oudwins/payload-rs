// Generates differential cases for the V8 builtins ported in crates/payload-sql-read
// (`JSON.parse` errors, `Number(string)`, `Number(object)`, `Array.prototype.sort`) and prints
// them as JSON on stdout. Run by crates/payload-sql-read/tests/v8_builtins.rs:
//   node test/__rs/read/capture/v8-builtins.mjs <json-parse|number|number-object|sort>
// Inputs come from a seeded PRNG, so every run produces the same cases.

let seed = 0x2545f491
const random = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]

/** `String(number)` keeping `-0` apart. */
const numberText = (n) => (Object.is(n, -0) ? '-0' : String(n))
/** Error messages as UTF-8 (lone surrogates become U+FFFD, like the Rust side). */
const message = (e) => `${e.name}: ${e.message}`.toWellFormed()

const randomJson = (depth) => {
  const r = int(depth > 3 ? 6 : 9)
  switch (r) {
    case 0:
      return null
    case 1:
      return random() < 0.5
    case 2:
      return pick([0, -0.5, 12, 1e21, 3.25e-7, -1234567.891, 9007199254740993])
    case 3:
    case 4:
      return pick([
        '',
        'a',
        'é',
        'line\nbreak',
        'q"uote',
        'back\\slash',
        '😀',
        '\u0001',
        'x'.repeat(30),
      ])
    case 5:
      return pick(['__proto__', 'constructor', 'toString'])
    case 6:
    case 7: {
      const out = []
      for (let i = int(5); i > 0; i--) {
        out.push(randomJson(depth + 1))
      }
      return out
    }
    default: {
      const out = {}
      for (let i = int(5); i > 0; i--) {
        out[pick(['a', 'b', '1', '0', 'key with space', '__proto__', 'é'])] = randomJson(depth + 1)
      }
      return out
    }
  }
}

const whitespace = () => pick(['', '', ' ', '\n', '\r\n', '\t', '\r', '  \n '])
/** JSON text with random insignificant white space (re-tokenizes `JSON.stringify` output). */
const spaced = (text) => text.replace(/([,:[\]{}])/g, (m) => whitespace() + m + whitespace())

const mutate = (text) => {
  const chars = [...text]
  const at = int(chars.length + 1)
  const noise = pick([
    ',',
    ':',
    '[',
    ']',
    '{',
    '}',
    '"',
    "'",
    '\\',
    'x',
    't',
    'n',
    'f',
    '-',
    '+',
    '.',
    'e',
    '0',
    '1',
    ' ',
    '\n',
    '\u0000',
    '\u001f',
    'é',
    '中',
    '😀',
    '\ud83d',
    'NaN',
    'undefined',
    'tru',
    'nul',
    '\\u12',
    '\\x',
  ])
  switch (int(5)) {
    case 0:
      chars.splice(at, 1)
      break
    case 1:
      chars.splice(at, 0, noise)
      break
    case 2:
      chars.splice(at, 1, noise)
      break
    case 3:
      return chars.slice(0, at).join('')
    default:
      chars.splice(at, int(4), noise, noise)
  }
  return chars.join('')
}

const jsonParseCases = () => {
  const inputs = [
    '',
    ' ',
    '[1,]',
    '01',
    '-01',
    '1.',
    '1.e5',
    '-',
    '-a',
    '[-]',
    '1e',
    '1e+',
    '0.5e-',
    '"\t"',
    '{"a" 1}',
    '[1] x',
    "'a'",
    '"\\x"',
    '+1',
    'NaN',
    'undefined',
    '[object Object]',
    'Infinity',
    '{',
    '[',
    '{"a":1,}',
    '{,}',
    '[1 2]',
    '{"a":1 "b":2}',
    '"\\u12G4"',
    '"\\u12',
    '"\\',
    '"\\u',
    '"abc',
    'tru',
    'trux',
    'tr1',
    'tr"',
    'nul',
    'nulx',
    'fals',
    '[tru',
    "{'a':1}",
    '{a:1}',
    '["a\\\n"]',
    '\n\n  [1,\n 2,,]',
    '{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": tru}',
    '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,x]',
    'x'.repeat(38),
    '"a"x',
    '1 2',
    '["a" "b"]',
    '{"a":"b" 3}',
    '{"a"}',
    ' ',
    '  1',
    '[1,"\u0001"]',
    '{"a":1}}',
    '[]]',
    '"\\ud83d"x',
    '{"a":1,"b" 2}',
    '{"a":1,"b"',
    '\r\n[1,\r\n\r2,\n\n x]',
    '[1,\r\n2 3]',
    '[1,\r\r\n\n2 3]',
    '[中]',
    '[😀]',
    '{"a":1,"b":2,"c":3,"d":4,"e":5 中}',
    '1x',
    '[1x]',
    '{"a":"\\u00"}',
    '"\\u00zz"',
    '"a\nb"',
    '{"a":1 , }',
    '[,1]',
    '{"a":[}',
    '{:1}',
    '{"a"::1}',
    '1 x yyyyyyyyyyyyyyyyyyyyyyyyy',
    'a'.repeat(20),
    'a'.repeat(21),
    '[1,2,3,4,5,6,7,8,9,é,11,12,13,14]',
    ' {"b":1,"a":2,"b":3,"__proto__":{"x":1}} ',
    '[1e2,-0,0.5,1E-7]',
    '"\\ud83d\\ude00"',
    '"\\udc00x"',
  ]
  for (let i = 0; i < 3000; i++) {
    const text = spaced(JSON.stringify(randomJson(0)))
    inputs.push(random() < 0.15 ? text : mutate(random() < 0.3 ? mutate(text) : text))
  }
  return inputs.map((input) => {
    try {
      return { input, ok: JSON.stringify(JSON.parse(input)) }
    } catch (e) {
      return { input, error: message(e) }
    }
  })
}

const numberCases = () => {
  const inputs = [
    '',
    ' ',
    ' 12 ',
    '12abc',
    '0x1A',
    '0X1a',
    '0x',
    '0o17',
    '0O8',
    '0b101',
    '0B2',
    '-0x10',
    '+0x10',
    '1e3',
    '.5',
    '5.',
    '.',
    'inf',
    'Infinity',
    '+Infinity',
    '-Infinity',
    'infinity',
    '1_000',
    '0.0000001',
    '  7 ﻿',
    ' -3 ',
    '\u0085 1',
    '᠎1',
    '1e400',
    '-1e400',
    '1e-400',
    '-0',
    '00012',
    '0x20000000000001',
    '0x20000000000003',
    '0x1fffffffffffff',
    '0x20000000000000800',
    '0x20000000000000801',
    '0x' + 'f'.repeat(300),
    '0b' + '1'.repeat(80),
    '0o' + '7'.repeat(30),
    '123456789012345678901234567890',
    '9007199254740993',
    '0.1e1',
    '1e',
    '1e+',
    '--1',
    '1-',
    '١٢',
    '12\u0000',
  ]
  const alphabet = [
    '0',
    '1',
    '7',
    '9',
    'a',
    'f',
    'x',
    'o',
    'b',
    'e',
    'E',
    '.',
    '+',
    '-',
    ' ',
    '\t',
    '\n',
    ' ',
    'I',
    'n',
    'N',
  ]
  for (let i = 0; i < 4000; i++) {
    let s = ''
    for (let n = int(8); n > 0; n--) {
      s += pick(alphabet)
    }
    inputs.push(s)
  }
  for (let i = 0; i < 2000; i++) {
    const [prefix, digits] = pick([
      ['0x', '0123456789abcdefABCDEF'],
      ['0b', '01'],
      ['0o', '01234567'],
      ['', '0123456789'],
    ])
    let s = prefix + (prefix ? '1' : String(1 + int(9)))
    for (let n = 10 + int(70); n > 0; n--) {
      s += pick([...digits])
    }
    if (!prefix && random() < 0.5) {
      s =
        s.slice(0, 1 + int(s.length - 1)) +
        '.' +
        s.slice(1 + int(s.length - 1)) +
        pick(['', 'e-300', 'e5', 'e+30'])
    }
    inputs.push(s)
  }
  return inputs.map((input) => ({
    input,
    parseFloat: numberText(Number.parseFloat(input)),
    parseInt: numberText(Number.parseInt(input)),
    value: numberText(Number(input)),
  }))
}

const numberObjectCases = () => {
  const inputs = [
    '{}',
    '[]',
    '[[]]',
    '[1]',
    '[1,2]',
    '[" 12 "]',
    '["0x10"]',
    '[null]',
    '[[3]]',
    '[{}]',
    '{"toString":1}',
    '{"valueOf":1}',
    '{"toString":1,"valueOf":2}',
    '{"valueOf":null,"toString":"5"}',
    '[{"toString":1}]',
    '[{"valueOf":1}]',
    '[[{"toString":0,"valueOf":0}]]',
    '{"__proto__":1}',
    '[true]',
    '[false,1]',
    '[""]',
    '{"a":1}',
    '[[1],[2]]',
    '[["7"]]',
    '{"toString":{}}',
    '{"valueOf":[]}',
  ]
  return inputs.map((input) => {
    try {
      return { input, value: numberText(Number(JSON.parse(input))) }
    } catch (e) {
      return { input, error: message(e) }
    }
  })
}

const sortCases = () => {
  const cases = []
  const lengths = [
    0, 1, 2, 3, 5, 8, 31, 32, 33, 63, 64, 65, 100, 127, 128, 200, 257, 500, 1000, 1500,
  ]
  for (let c = 0; c < 400; c++) {
    const length = c < lengths.length * 4 ? lengths[c % lengths.length] : int(700)
    const flavour = int(5)
    const orders = []
    for (let i = 0; i < length; i++) {
      const r = random()
      if (flavour === 0) {
        orders.push(int(length + 1))
      } else if (flavour === 1) {
        orders.push(r < 0.3 ? null : int(10))
      } else if (flavour === 2) {
        orders.push(r < 0.2 ? 'undefined' : r < 0.3 ? 'NaN' : r < 0.4 ? String(int(9)) : int(50))
      } else if (flavour === 3) {
        // long ascending / descending runs with noise, to exercise run detection and galloping
        const base = c % 2 ? i : length - i
        orders.push(r < 0.05 ? 'undefined' : r < 0.1 ? int(length) : base)
      } else {
        orders.push(r < 0.5 ? 'undefined' : i % 7)
      }
    }
    const rows = orders.map((order, index) => {
      const row = { index }
      if (order === 'NaN') {
        row._order = Number.NaN
      } else if (order !== 'undefined') {
        row._order = typeof order === 'string' ? order : order
      }
      return row
    })
    rows.sort((a, b) => {
      if (typeof a._order === 'number' && typeof b._order === 'number') {
        return a._order - b._order
      }
      return 0
    })
    cases.push({
      orders: orders.map((o) =>
        typeof o === 'string' && o !== 'NaN' && o !== 'undefined' ? { s: o } : o,
      ),
      sorted: rows.map((r) => r.index),
    })
  }
  return cases
}

const mode = process.argv[2]
const generators = {
  'json-parse': jsonParseCases,
  number: numberCases,
  'number-object': numberObjectCases,
  sort: sortCases,
}
if (!generators[mode]) {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
process.stdout.write(JSON.stringify(generators[mode]()))
