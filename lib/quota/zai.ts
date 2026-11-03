import { z } from "zod"
import { clampPct, safeNumber, type QuotaFetchResult } from "./types.js"

const absoluteQuotaSchema = z.object({
  usedPct: z.number(), remainingPct: z.number(), nextResetEpoch: z.number(), used: z.number(), total: z.number(),
})
const usageDetailSchema = z.object({ modelCode: z.string(), usage: z.number() })
export const zaiQuotaDataSchema = z.object({
  level: z.string(), tokenUsedPct: z.number(), tokenRemainingPct: z.number(), tokenNextResetEpoch: z.number(),
  tokenAbsolute: absoluteQuotaSchema.nullable(),
  weeklyLimit: z.object({ usedPct: z.number(), remainingPct: z.number(), nextResetEpoch: z.number(), absolute: absoluteQuotaSchema.nullable() }).nullable(),
  timeLimit: absoluteQuotaSchema.extend({ usageDetails: z.array(usageDetailSchema) }).nullable(),
})
export type AbsoluteQuota = z.infer<typeof absoluteQuotaSchema>
export type ZaiQuotaData = z.infer<typeof zaiQuotaDataSchema>

// Preserve safeNumber's numeric-string normalization at the parser, with
// numeric-only DTOs across RPC.
const numericValueSchema = z.union([z.number(), z.string(), z.null()]).optional()
const limitSchema = z.object({
  type: z.string(), unit: z.number(), percentage: numericValueSchema, nextResetTime: numericValueSchema,
  usage: numericValueSchema, currentValue: numericValueSchema, usageDetails: z.array(usageDetailSchema).optional(),
})
const quotaApiResponseSchema = z.object({
  code: z.number(), data: z.object({ limits: z.array(limitSchema), level: z.string().optional() }).optional(),
})

export async function fetchZaiQuota(apiKey: string, signal?: AbortSignal): Promise<QuotaFetchResult<ZaiQuotaData>> {
  const ownedController = signal ? null : new AbortController()
  const requestSignal = signal ?? ownedController!.signal
  const timeout = ownedController ? setTimeout(() => ownedController.abort(), 20_000) : null
  try {
    const response = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
      method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: requestSignal,
    })
    if (response.status === 401 || response.status === 403) return { kind: "authentication-required" }
    if (!response.ok) return { kind: "transient-failure" }
    let payload: unknown
    try { payload = await response.json() } catch { return { kind: "invalid-response" } }
    const parsed = quotaApiResponseSchema.safeParse(payload)
    if (!parsed.success) return { kind: "invalid-response" }
    if (parsed.data.code === 401 || parsed.data.code === 403) return { kind: "authentication-required" }
    if (parsed.data.code !== 200 || !parsed.data.data) return { kind: "invalid-response" }
    const { limits, level } = parsed.data.data
    const rawLevel = level || "Unknown"
    const tokenLimits = limits.filter((limit) => limit.type === "TOKENS_LIMIT")
    const token = tokenLimits.find((limit) => limit.unit === 3) ?? tokenLimits[0]
    const weekly = tokenLimits.find((limit) => limit.unit === 6 && limit !== token)
    const time = limits.find((limit) => limit.type === "TIME_LIMIT")
    const absolute = (limit: z.infer<typeof limitSchema>, usedPct: number): AbsoluteQuota | null => {
      const total = safeNumber(limit.usage, 0)
      if (total <= 0) return null
      return {
        usedPct, remainingPct: clampPct(100 - usedPct), nextResetEpoch: safeNumber(limit.nextResetTime, 0),
        used: safeNumber(limit.currentValue, Math.round(total * usedPct / 100)), total,
      }
    }
    const tokenUsedPct = token ? clampPct(safeNumber(token.percentage, 0)) : 0
    return { kind: "success", data: {
      level: rawLevel.charAt(0).toUpperCase() + rawLevel.slice(1).toLowerCase(),
      tokenUsedPct, tokenRemainingPct: clampPct(100 - tokenUsedPct),
      tokenNextResetEpoch: token ? safeNumber(token.nextResetTime, 0) : 0,
      tokenAbsolute: token ? absolute(token, tokenUsedPct) : null,
      weeklyLimit: weekly ? {
        usedPct: clampPct(safeNumber(weekly.percentage, 0)), remainingPct: clampPct(100 - safeNumber(weekly.percentage, 0)),
        nextResetEpoch: safeNumber(weekly.nextResetTime, 0), absolute: absolute(weekly, clampPct(safeNumber(weekly.percentage, 0))),
      } : null,
      timeLimit: time ? {
        usedPct: clampPct(safeNumber(time.percentage, 0)), remainingPct: clampPct(100 - safeNumber(time.percentage, 0)),
        nextResetEpoch: safeNumber(time.nextResetTime, 0), total: safeNumber(time.usage, 0), used: safeNumber(time.currentValue, 0),
        usageDetails: time.usageDetails ?? [],
      } : null,
    } }
  } catch {
    if (!requestSignal.aborted) console.error("[quota-zai] fetchQuota error:")
    return { kind: "transient-failure" }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
