import type { PayloadHandler } from '../../config/types.js'

import { getRequestCollectionWithID } from '../../utilities/getRequestEntity.js'
import { headersWithCors } from '../../utilities/headersWithCors.js'
import { httpStatus } from '../../utilities/httpStatus.js'
import { parseParams } from '../../utilities/parseParams/index.js'
import { findByIDOperation } from '../operations/findByID.js'
import { fusedResponse } from './fusedResponse.js'

export const findByIDHandler: PayloadHandler = async (req) => {
  const { data: dataArg } = req
  const { id, collection } = getRequestCollectionWithID(req)

  const { data, depth, draft, flattenLocales, joins, populate, select, trash } = parseParams({
    ...req.query,
    ...dataArg,
  })

  const operationArgs = {
    id,
    collection,
    data,
    depth,
    draft,
    flattenLocales,
    joins,
    populate,
    req,
    select,
    trash,
  }
  const headers = () =>
    headersWithCors({
      headers: new Headers(),
      req,
    })

  return fusedResponse({
    exact: async () => {
      const result = await findByIDOperation(operationArgs)

      return Response.json(result, {
        headers: headers(),
        status: httpStatus.OK,
      })
    },
    headers,
    operation: 'findByID',
    operationArgs,
  })
}
