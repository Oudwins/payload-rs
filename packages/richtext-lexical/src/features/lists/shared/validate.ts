import type { SerializedListItemNode, SerializedListNode } from '@lexical/list'

import { registerPayloadOwnFunction } from 'payload/internal'

import type { NodeValidation } from '../../typesServer.js'

import { ALLOWED_LIST_TAGS } from './constants.js'

export const listItemValidation: NodeValidation<SerializedListItemNode> =
  registerPayloadOwnFunction<NodeValidation<SerializedListItemNode>>(
    ({ node }) => {
      if (typeof node.value !== 'number' || !Number.isFinite(node.value)) {
        return 'List item value must be a finite number.'
      }

      return true
    },
    { kind: 'lexicalNodeValidation', validation: 'listItem' },
  )

export const listValidation: NodeValidation<SerializedListNode> = registerPayloadOwnFunction<
  NodeValidation<SerializedListNode>
>(({ node }) => (ALLOWED_LIST_TAGS.has(node.tag) ? true : 'List tag must be one of ol, ul.'), {
  kind: 'lexicalNodeValidation',
  validation: 'list',
})
