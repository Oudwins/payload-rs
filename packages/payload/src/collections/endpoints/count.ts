import type { PayloadHandler } from '../../config/types.js'

import { getRequestCollection } from '../../utilities/getRequestEntity.js'
import { httpStatus } from '../../utilities/httpStatus.js'
import { parseParams } from '../../utilities/parseParams/index.js'
import { countOperation } from '../operations/count.js'
import { fusedResponse } from './fusedResponse.js'

export const countHandler: PayloadHandler = async (req) => {
  const collection = getRequestCollection(req)

  const { trash, where } = parseParams(req.query)

  const operationArgs = {
    collection,
    req,
    trash,
    where,
  }

  return fusedResponse({
    exact: async () => {
      const result = await countOperation(operationArgs)

      return Response.json(result, {
        status: httpStatus.OK,
      })
    },
    headers: () => new Headers(),
    operation: 'count',
    operationArgs,
  })
}
