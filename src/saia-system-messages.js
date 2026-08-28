// SAIA's Qwen 3.5, 3.6, and 3.8 deployments reject requests carrying more than one leading
// system message, while OpenCode sends its prompt as several fragments. This is a
// deliberate allowlist of the deployments known to have that constraint, not a prefix
// match: a future qwen3.9 will not be merged until it is confirmed to need it.
const STRICT_QWEN_MODEL = /^qwen3\.(?:5|6|8)-/

export function normalizeSaiaQwenSystemMessages(model, system) {
  if (model?.providerID !== "saia" || !STRICT_QWEN_MODEL.test(model.id ?? "")) return

  const merged = system.filter((message) => message.trim().length > 0).join("\n\n")
  system.length = 0
  if (merged) system.push(merged)
}
