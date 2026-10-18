// OpenCode 2 standalone SAIA rate-limit plugin.
//
// For hosts that configure the `saia` provider themselves and want only the
// limits observer and widget, not model discovery — the GWDG deployment ran
// the OpenCode 1 `saia-limits-server.js` this way. Installed as
// `<config>/plugins/saia-limits/server.js` by `install.sh --limits-only`. Do
// not install it beside the full SAIA plugin, which includes this observer.

import { createSaiaLimitsObserver, SAIA_PROVIDER_ID } from "./saia-limits-v2.js"

export default {
  id: "saia-limits-server",
  async setup(ctx) {
    const providerID =
      typeof ctx.options?.providerID === "string" && ctx.options.providerID ? ctx.options.providerID : SAIA_PROVIDER_ID
    return createSaiaLimitsObserver(ctx, {
      providerID,
      onWarning: (message) => console.warn(`[SAIA] ${message}`),
    })
  },
}
