import { getTranslation } from '@payloadcms/translations'

import type { PayloadHandler } from '../../config/types.js'

import { getRequestCollection } from '../../utilities/getRequestEntity.js'
import { headersWithCors } from '../../utilities/headersWithCors.js'
import { httpStatus } from '../../utilities/httpStatus.js'
import { parseParams } from '../../utilities/parseParams/index.js'
import { createOperation } from '../operations/create.js'
import { fusedWriteResponse } from './fusedResponse.js'

export const createHandler: PayloadHandler = async (req) => {
  const collection = getRequestCollection(req)

  const { autosave, depth, draft, populate, publishAllLocales, select } = parseParams(req.query)

  const operationArgs = {
    autosave,
    collection,
    data: req.data!,
    depth,
    draft,
    populate,
    publishAllLocales,
    req,
    select,
  }

  return fusedWriteResponse({
    exact: () => createOperation(operationArgs),
    headers: () =>
      headersWithCors({
        headers: new Headers(),
        req,
      }),
    message: () =>
      req.t('general:successfullyCreated', {
        label: getTranslation(collection.config.labels.singular, req.i18n),
      }),
    operation: 'create',
    operationArgs,
    status: httpStatus.CREATED,
  })
}
