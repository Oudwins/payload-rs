import { getSession as original } from '../../../../packages/db-mongodb/src/utilities/getSession.js'
import { leaf } from '../recorder.js'

export const getSession: typeof original = (db, req) =>
  leaf('getSession', () => ({ hasReq: Boolean(req) }), () => original(db, req))
