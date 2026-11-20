import { buildJoinAggregation as upstream } from '../../../../packages/db-mongodb/src/utilities/buildJoinAggregation.js'
import { dualRun } from '../dual.js'

export const buildJoinAggregation: typeof upstream = (args) => dualRun('buildJoinAggregation', upstream, args)
