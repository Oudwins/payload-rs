import { queryDrafts as original } from '../../../../packages/db-mongodb/src/queryDrafts.js'
import { encode, recordAdapter, unit } from '../recorder.js'

export const queryDrafts: typeof original = async function (this: any, args) {
  const { req, ...rest } = args
  return unit(
    'queryDrafts',
    this,
    () => ({ ...(encode(rest) as object), hasReq: Boolean(req) }),
    () => original.call(recordAdapter(this) as typeof this, args),
  )
}
