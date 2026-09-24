export type QuotaFetchResult<T> =
  | { kind: "success"; data: T }
  | { kind: "transient-failure" }
  | { kind: "authentication-required" }
  | { kind: "invalid-response" }

export function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function safeNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
