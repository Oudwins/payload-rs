import type { PayloadHandler } from '../../config/types.js'

import { getRequestCollection } from '../../utilities/getRequestEntity.js'
import { headersWithCors } from '../../utilities/headersWithCors.js'
import { httpStatus } from '../../utilities/httpStatus.js'
import { parseParams } from '../../utilities/parseParams/index.js'
import { findOperation } from '../operations/find.js'
import { fusedResponse } from './fusedResponse.js'

export const findHandler: PayloadHandler = async (req) => {
  const collection = getRequestCollection(req)

  const { depth, draft, joins, limit, page, pagination, populate, select, sort, trash, where } =
    parseParams(req.query)

  const operationArgs = {
    collection,
    depth,
    draft,
    joins,
    limit,
    page,
    pagination,
    populate,
    req,
    select,
    sort,
    trash,
    where,
  }
  const headers = () =>
    headersWithCors({
      headers: new Headers(),
      req,
    })

  return fusedResponse({
    exact: async () => {
      const result = await findOperation(operationArgs)

      return Response.json(result, {
        headers: headers(),
        status: httpStatus.OK,
      })
    },
    headers,
    operation: 'find',
    operationArgs,
  })
}
