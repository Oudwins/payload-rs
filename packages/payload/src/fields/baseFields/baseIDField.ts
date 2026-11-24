import ObjectIdImport from 'bson-objectid'

import type { TextField } from '../config/types.js'

import { registerPayloadOwnFunction } from '../config/payloadOwnFunctions.js'

const ObjectId = 'default' in ObjectIdImport ? ObjectIdImport.default : ObjectIdImport

export const baseIDField: TextField = {
  name: 'id',
  type: 'text',
  admin: {
    hidden: true,
  },
  defaultValue: registerPayloadOwnFunction(() => new ObjectId().toHexString(), {
    kind: 'rowIdDefaultValue',
  }),
  hooks: {
    beforeChange: [
      registerPayloadOwnFunction(({ value }) => value || new ObjectId().toHexString(), {
        kind: 'rowIdBeforeChange',
      }),
    ],
    // ID field values for arrays and blocks need to be unique when duplicating, as on postgres they are stored on the same table as primary keys.
    beforeDuplicate: [
      registerPayloadOwnFunction(() => new ObjectId().toHexString(), {
        kind: 'rowIdBeforeDuplicate',
      }),
    ],
  },
  label: 'ID',
}
