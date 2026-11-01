import { findDistinct as original } from '../../../../packages/db-mongodb/src/findDistinct.js'
import { encode, recordAdapter, unit } from '../recorder.js'

export const findDistinct: typeof original = async function (this: any, args) {
  const { req, ...rest } = args
  return unit(
    'findDistinct',
    this,
    () => ({ ...(encode(rest) as object), hasReq: Boolean(req) }),
    () => original.call(recordAdapter(this) as typeof this, args),
  )
}
