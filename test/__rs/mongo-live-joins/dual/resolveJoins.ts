import { resolveJoins as upstream } from '../../../../packages/db-mongodb/src/utilities/resolveJoins.js'
import { dualRun } from '../dual.js'

export type { ResolveJoinsArgs } from '../../../../packages/db-mongodb/src/utilities/resolveJoins.js'

export const resolveJoins: typeof upstream = (args) => dualRun('resolveJoins', upstream, args)
