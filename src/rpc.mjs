// RPC contract between the SAIA rate-limit observer and the limits widget.
//
// A plain object rather than `Rpc.define(...)`, an identity function that only
// rejects error names starting with `rpc.`; importing `@opencode/plugin/rpc`
// would stop the Node test suite loading this module.
//
// A session's record is `{ limits, subagentLimits, subagents }`:
//   limits          the remaining windows seen on this session's own requests
//   subagentLimits  the newest limits seen in one of its child sessions
//   subagents       child sessions that used SAIA, by session ID
//
// opencode-kiconnect-status reads `subagents` from here to avoid printing the
// shared "Subagents" sidebar heading twice; keep the field name stable.

export const SaiaLimitsRpc = {
  id: "saia-limits",
  methods: {
    limits: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object" },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, record: { type: "object" } },
        required: ["sessionID"],
      },
    },
  },
}
