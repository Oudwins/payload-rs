import { registerBeforeChangeSuite } from './suite.js'

// The fields suite with sanitize's default validators unwrapped: the validation merge elision applies.
registerBeforeChangeSuite({
  configPath: '../../fields/config.ts',
  keepDefaultValidators: true,
  name: 'core-hooks-before-change: elision-fields',
})
