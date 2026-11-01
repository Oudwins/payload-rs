// Generates test/__rs/read/dates.json: `Date.parse` results from V8 for a battery of strings in
// several process time zones (one child process per zone), replayed by
// `cargo test -p payload-sql-read --test dates` against the Rust port of V8's DateParser
// (the test sets TZ to each recorded zone).
//   node test/__rs/read/capture/dates.mjs                  # UTC, Europe/Lisbon, America/New_York
//   RS_READ_TZS=UTC,Asia/Tokyo node test/__rs/read/capture/dates.mjs
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const base = [
  '2020-01-01T10:00:00.000Z',
  '2020-01-01T10:00:00.123456Z',
  '2020-01-01T10:00:00.1234567891234Z',
  '2020-01-01T10:00:00.1Z',
  '2020-01-01T10:00:00.Z',
  '2020-01-01t10:00:00z',
  '2020-01-01T24:00:00Z',
  '2020-01-01T24:00:01Z',
  '2020-01-01T10:00Z',
  '2020-01-01T10Z',
  '2020',
  '2020-06',
  '2020-06-15',
  '2020-1-1',
  '2020-01-1',
  '+002020-01-01',
  '-000001-01-01T00:00:00Z',
  '-000000-01-01',
  '+275760-09-13T00:00:00.000Z',
  '+275760-09-13T00:00:00.001Z',
  '2020-01-01T10:00:00+0100',
  '2020-01-01T10:00:00+01',
  '2020-01-01T10:00:00+01:30',
  '2020-01-01T10:00:00-23:59',
  '2020-01-01T10:00:00+24:00',
  '2020-06-01T10:00:00',
  '2020-12-01T10:00:00',
  '2020-03-29T01:30:00',
  '2020-10-25T01:30:00',
  ' 2020-01-01T10:00:00Z',
  '2020-01-01T10:00:00Z ',
  '2020-01-01 10:00:00',
  '2020-01-01 10:00:00Z',
  '2020-01-01 10:00:00 GMT+0200',
  '2020-01-01T10:00:60Z',
  '2020-13-01',
  '2019-02-29',
  '2019-02-30',
  '2019-02-31T12:00:00Z',
  '2020-01-01T10:00:00 Z',
  'Jan 1 2020',
  'January 1, 2020',
  'Sat Oct 31 2026',
  'Saturday, October 31, 2026',
  'Sat Oct 31 2026 10:20:30 GMT+0000 (Western European Standard Time)',
  'Sat Oct 31 2026 10:20:30 GMT+0100 (Central European Standard Time)',
  'Sat, 31 Oct 2026 10:20:30 GMT',
  'Tue Mar 01 2022 08:00:00 GMT-0500 (Eastern Standard Time)',
  '31 Oct 2026',
  'Oct 31',
  '10/31/2026',
  '10/31/2026, 10:20:30 AM',
  '10/31/2026, 12:20:30 PM',
  '10/31/2026, 12:20:30 AM',
  '10/31/26',
  '1/2/3',
  '2026/10/31',
  '2026/10/31 10:20',
  '31/10/2026',
  'October 13, 1975 11:13:00',
  'Mon, 25 Dec 1995 13:30:00 +0430',
  'Mon, 25 Dec 1995 13:30:00 PST',
  'Mon, 25 Dec 1995 13:30:00 EDT',
  '12:00',
  'Thu, 01 Jan 1970 00:00:00 GMT-1',
  'Thu, 01 Jan 1970 00:00:00 UTC+12345',
  '1970-01-01T00:00:00.000+00:00',
  '2020-01-01T10:00:00.000+00:00 (comment)',
  'Dec 25, 1995 (Christmas)',
  'Dec 25 (1995)',
  'garbage',
  '',
  '1577872800000',
  '2020-01-01T10:00:00.000Zjunk',
  'tomorrow 2020',
  '2020 Jan 5',
  'Jan-05-2020',
  '05-Jan-2020',
  '5 January 2020 10:00 pm',
  '5 January 2020 13:00 pm',
  '2020-01-05T10:00:00.000z',
  'Sun Jan 05 2020 10:00:00 GMT+0000',
  '2020-01-05 10:00:00.5',
  '2020-01-05 10:00:00.',
  '2020-01-05 10::',
  '2020-01-05 10:00 +05:30',
  '2020-01-05 10:00 UTC+5',
  '2020-01-05 10:00 UTC-05:30',
  // lone UTF-16 surrogates (and U+FFFD, which the Rust side substitutes for them)
  '2020-01-01\ud800',
  '2020-01-01\ufffd',
  'Sat Oct 31 2026 \ud800',
  '\ud800Sat Oct 31 2026',
  '\udc00 Oct 31 2026',
  'Oct\ud83d 31 2026',
  '2020-01-01T10:00:00Z\ud83d',
  '\ud83d\ude00 2020-01-01',
  '31 Oct 2026 10:00 \udfff',
]

const now = new Date('2026-10-31T11:15:51.216Z')
const generated = [
  now.toString(),
  now.toDateString(),
  now.toUTCString(),
  now.toLocaleString('en-US'),
  now.toLocaleDateString('en-US'),
  now.toISOString(),
]

const cases = [...base, ...generated].map((input) => {
  const t = Date.parse(input)
  return { input, time: Number.isNaN(t) ? null : t }
})

if (process.argv[2] === '--child') {
  process.stdout.write(JSON.stringify(cases))
} else {
  const zones = (process.env.RS_READ_TZS ?? 'UTC,Europe/Lisbon,America/New_York').split(',')
  const out = {}
  for (const zone of zones) {
    const output = execFileSync(process.execPath, [import.meta.filename, '--child'], {
      env: { ...process.env, TZ: zone },
    })
    out[zone] = { cases: JSON.parse(output.toString()) }
  }
  fs.writeFileSync(
    path.resolve(import.meta.dirname, '../dates.json'),
    JSON.stringify({ zones: out }, null, 1),
  )
  console.log(`wrote ${cases.length} date cases for ${zones.join(', ')}`)
}
