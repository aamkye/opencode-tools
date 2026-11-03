import { z } from "zod"
import type { QuotaFetchResult } from "./types.js"

export const rateLimitWindowSchema = z.object({
  used_percent: z.number(),
  limit_window_seconds: z.number(),
  reset_after_seconds: z.number(),
  reset_at: z.number().optional(),
})
export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>

export const openAiQuotaDataSchema = z.object({
  planType: z.string(),
  primary: rateLimitWindowSchema,
  secondary: rateLimitWindowSchema.nullable(),
  codeReview: rateLimitWindowSchema.nullable(),
  limitReached: z.boolean(),
  creditsBalance: z.string().nullable(),
  creditsUnlimited: z.boolean(),
})
export type OpenAiQuotaData = z.infer<typeof openAiQuotaDataSchema>
export type OpenAiAuthEntry = { access: string; expires?: number; accountId?: string }

const usageResponseSchema = z.object({
  plan_type: z.string().optional(),
  rate_limit: z.object({
    primary_window: rateLimitWindowSchema,
    secondary_window: rateLimitWindowSchema.nullish(),
    limit_reached: z.boolean().optional(),
  }),
  code_review_rate_limit: z.object({ primary_window: rateLimitWindowSchema.nullish() }).nullish(),
  credits: z.object({ balance: z.string().nullish(), unlimited: z.boolean().optional() }).nullish(),
})

function derivePlanLabel(planType: string | undefined): string {
  const raw = (planType || "").toLowerCase()
  if (raw.includes("pro") && !raw.includes("lite")) return "Pro"
  if (raw.includes("plus")) return "Plus"
  if (raw.includes("lite")) return "Pro Lite"
  if (planType) return planType.charAt(0).toUpperCase() + planType.slice(1)
  return "OpenAI"
}

function decodeJwtAccountId(token: string): string | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"))
    const id: unknown = data?.["https://api.openai.com/auth"]?.chatgpt_account_id
    return typeof id === "string" ? id : null
  } catch {
    return null
  }
}

export async function fetchOpenAiQuota(auth: OpenAiAuthEntry, signal?: AbortSignal): Promise<QuotaFetchResult<OpenAiQuotaData>> {
  if (!auth.access || (auth.expires && auth.expires < Date.now())) return { kind: "authentication-required" }
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.access}`,
      "User-Agent": "OpenCode-Quota-Toast/1.0",
    }
    const accountId = auth.accountId || decodeJwtAccountId(auth.access)
    if (accountId) headers["ChatGPT-Account-Id"] = accountId
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal })
    if (response.status === 401 || response.status === 403) return { kind: "authentication-required" }
    if (!response.ok) return { kind: "transient-failure" }
    let payload: unknown
    try { payload = await response.json() } catch { return { kind: "invalid-response" } }
    const parsed = usageResponseSchema.safeParse(payload)
    if (!parsed.success) return { kind: "invalid-response" }
    const data = parsed.data
    return { kind: "success", data: {
      planType: derivePlanLabel(data.plan_type),
      primary: data.rate_limit.primary_window,
      secondary: data.rate_limit.secondary_window ?? null,
      codeReview: data.code_review_rate_limit?.primary_window ?? null,
      limitReached: Boolean(data.rate_limit.limit_reached),
      creditsBalance: data.credits?.balance ?? null,
      creditsUnlimited: Boolean(data.credits?.unlimited),
    } }
  } catch {
    // Error objects can include headers/tokens; never send or log them.
    if (!signal?.aborted) console.error("[quota-openai] fetchQuota error:")
    return { kind: "transient-failure" }
  }
}
