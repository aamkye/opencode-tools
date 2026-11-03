import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { openAiQuotaDataSchema } from "../lib/quota/openai.js"
import { zaiQuotaDataSchema } from "../lib/quota/zai.js"

const windowSchema = z.object({ usedPct: z.number(), remainingPct: z.number(), resetEpoch: z.number() })
const goDataSchema = z.object({ fiveHour: windowSchema, weekly: windowSchema, monthly: windowSchema })
const configSchema = z.object({
  workspaceId: z.string().regex(/^wrk_[A-Za-z0-9]+$/),
  workspaceToken: z.string().min(1).regex(/^[^\r\n]+$/),
}).strict()
const requestSchema = z.object({ provider: z.enum(["openai", "zai", "opencode-go"]), config: configSchema.optional() }).strict()
function fetchResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("success"), data }),
    z.object({ kind: z.literal("transient-failure") }),
    z.object({ kind: z.literal("authentication-required") }),
    z.object({ kind: z.literal("invalid-response") }),
  ])
}
const metadata = { configured: z.boolean(), connectionID: z.string().optional() }
const resultSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("openai"), ...metadata, result: fetchResultSchema(openAiQuotaDataSchema) }),
  z.object({ provider: z.literal("zai"), ...metadata, result: fetchResultSchema(zaiQuotaDataSchema) }),
  z.object({ provider: z.literal("opencode-go"), ...metadata, result: fetchResultSchema(goDataSchema) }),
])

export type QuotaRequest = z.infer<typeof requestSchema>
export type QuotaRpcResult = z.infer<typeof resultSchema>
export const QuotaRpc = Rpc.define({
  id: "aamkye.opencode-tools.quota",
  methods: { fetch: { input: requestSchema, output: resultSchema } },
  events: {},
})
