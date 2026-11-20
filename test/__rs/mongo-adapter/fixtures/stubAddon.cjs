/**
 * Engine addon stub for required.int.spec.ts: exports every live binding as a function that throws
 * when called (so a test proves nothing was initialized), except the names listed (comma
 * separated) in `RS_STUB_ADDON_MISSING`, read on every property access.
 */
const names = [
  'coreRuntime',
  'mongoLiveBinding',
  'mongoLiveQueryBinding',
  'mongoLiveTransformBinding',
  'mongoLiveJoinsBinding',
  'mongoLiveSchemaBinding',
  'mongoLiveWriteBinding',
  'MongoEngine',
]

for (const name of names) {
  Object.defineProperty(module.exports, name, {
    enumerable: true,
    get: () =>
      (process.env.RS_STUB_ADDON_MISSING ?? '').split(',').includes(name)
        ? undefined
        : () => {
            throw new Error(`stub addon: ${name} called`)
          },
  })
}
