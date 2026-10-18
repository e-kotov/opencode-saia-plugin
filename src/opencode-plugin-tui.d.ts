// Minimal declaration of `@opencode/plugin/tui` for this repository's `npm run
// tsc`. OpenCode 2 supplies the real module to plugins at runtime, and it is
// not a dependency here; tui.tsx was type-checked against the published
// @opencode/plugin 2.0.32 declarations separately. Not installed.
declare module "@opencode/plugin/tui" {
  export namespace Plugin {
    type Context = any
    interface Definition {
      readonly id: string
      readonly setup: (context: Context) => unknown
    }
  }
}
