/**
 * Differential harnesses whose reference is built through the public factories
 * (`sqliteAdapter(args)`, `mongooseAdapter(args)`, Payload's own operations): the reference is
 * upstream TS only with `PAYLOAD_ENGINE=ts`, since leaving it unset selects the Rust engine.
 */
export const requireTsEngine = ({ file }: { file: string }) => {
  if (process.env.PAYLOAD_ENGINE !== 'ts') {
    throw new Error(
      `${file}: the reference must be upstream TS: run with PAYLOAD_ENGINE=ts (unset selects the Rust engine)`,
    )
  }
}
