// Generates fixtures/dates.json: `new Date(input)` results for a corpus of strings in several
// process time zones, used by the Rust unit test `js_ops::tests::dates_match_v8`.
//
// Run: node test/__rs/query/gen-dates.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const timeZones = [
  'UTC',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'America/St_Johns',
  'America/Sao_Paulo',
  'Pacific/Apia',
  'Pacific/Chatham',
]

const parts = [
  '2020',
  '-',
  '01',
  '1',
  '/',
  ' ',
  'T',
  '10',
  ':',
  '00',
  '.',
  '123',
  'Z',
  '+',
  '05',
  '0530',
  'Jan',
  'march',
  'pm',
  'AM',
  'GMT',
  'utc',
  'pst',
  ',',
  '(x)',
  ')',
  '24',
  '99',
  '50',
  '31',
  '0',
  'abc',
  't',
  '12',
]
let seed = 42
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const inputs = new Set([
  '10',
  '1,2,3',
  '123',
  '-1',
  '2020/01/01',
  'Jan 1 2020',
  '2020-01-01 10:00',
  '2020-1-1',
  '  2020-01-01',
  '20201-01-01',
  'not a date',
  'abc',
  '',
  ' ',
  '2020-01-01T10:00:00.Z',
  '-000000-01-01T00:00:00Z',
  '2021-02-30',
  '2021-02-31T10:00Z',
  '2020-13-01',
  '2020-01-01T24:00:00Z',
  '2020-01-01T24:00:01Z',
  '2020-01-01T10:00:00.1234567Z',
  '+002020-01-01',
  '2020-01-01T10:00:00+0100',
  '2020-01-01T10:00:00+01:00',
  '2020-01-01t10:00:00z',
  '12/31/1999 11:59 pm',
  'Tue Mar 01 2022 10:00:00 GMT+0200 (CEST)',
  '1 jan 99',
  'December 17, 1995 03:24:00',
  '1995-12-17T03:24:00',
  'Sun Feb 01 1998 00:00:00 GMT+0000 (GMT)',
  '2023-12-31T23:59:59.000Z',
  '2021-06-15T12:30:00.000Z',
  '1999-03-04T05:06:07.000Z',
  '2020-01-01',
  '0000-01-01',
  '275760-09-13',
  '+275760-09-13T00:00:00.000Z',
  '+275760-09-13T00:00:00.001Z',
  'true',
  'null',
  // DST transitions (skipped / repeated wall-clock times) and historical offsets
  '2021-03-14T02:30:00',
  '2021-03-14T03:30:00',
  '2021-11-07T01:30:00',
  '2021-11-07T00:59:59.999',
  '2021-03-28T01:30:00',
  '2021-03-28T02:30:00',
  '2021-10-31T01:30:00',
  '2021-10-31T02:30:00',
  '2021-10-03T02:15:00',
  '2021-04-04T01:45:00',
  '2018-11-04T00:30:00',
  '2019-02-16T23:30:00',
  '2011-12-30T12:00:00',
  '2011-12-29T23:59:00',
  'Mar 14 2021 02:30',
  '2021-03-14 02:30',
  '11/7/2021 1:30 AM',
  '1900-01-01T00:00:00',
  '1850-06-01T12:00:00',
  '1883-11-18T12:00:00',
  '1970-01-01T00:00:00',
  '2100-07-01T12:00:00',
  '2038-01-19T03:14:08',
  '0001-01-01T00:00:00',
  '-000001-01-01T00:00:00',
  '+275760-09-13T00:00:00',
  '-271821-04-20T00:00:00',
  '2020-06-01',
  '2020-06-01T00:00',
  'June 1, 2020',
  '2020-06-01 00:00:00 GMT',
])
for (let i = 0; i < 3000; i++) {
  const n = 1 + Math.floor(rand() * 7)
  let s = ''
  for (let j = 0; j < n; j++) {
    s += parts[Math.floor(rand() * parts.length)]
  }
  inputs.add(s)
}

if (process.env.RS_DATES_CHILD) {
  const times = JSON.parse(fs.readFileSync(0, 'utf8')).map((input) => {
    const t = new Date(input).getTime()
    return Number.isNaN(t) ? null : t
  })
  process.stdout.write(JSON.stringify(times))
} else {
  const list = [...inputs]
  const zones = timeZones.map((tz) => {
    const times = JSON.parse(
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, RS_DATES_CHILD: '1', TZ: tz },
        input: JSON.stringify(list),
        maxBuffer: 64 * 1024 * 1024,
      }).toString(),
    )
    return { times, tz }
  })
  fs.mkdirSync(path.join(dirname, 'fixtures'), { recursive: true })
  fs.writeFileSync(
    path.join(dirname, 'fixtures', 'dates.json'),
    JSON.stringify({ inputs: list, zones }),
  )
  console.log(`wrote ${list.length} date cases x ${zones.length} time zones`)
}
