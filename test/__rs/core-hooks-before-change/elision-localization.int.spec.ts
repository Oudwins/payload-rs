import { registerBeforeChangeSuite } from './suite.js'

// The localization suite with sanitize's default validators unwrapped: the validation merge elision
// applies (and is skipped for locale-keyed values).
registerBeforeChangeSuite({
  configPath: '../../localization/config.ts',
  keepDefaultValidators: true,
  name: 'core-hooks-before-change: elision-localization',
})
