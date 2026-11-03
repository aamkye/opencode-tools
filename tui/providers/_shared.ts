export const DEFAULT_REFRESH_INTERVAL_MS = 10_000
export const EXHAUSTED_POLL_MS = 300_000
export const TICK_MS = 1_000
export const FETCH_TIMEOUT_MS = 20_000
export const STALE_MAX_MS = 10 * 60 * 1_000

export { clampPct, safeNumber } from "../../lib/quota/types.js"

export function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  ;(timer as { unref?: () => void }).unref?.()
}

export function providerRefreshInterval(options: { refreshIntervalMs?: number }): number {
  return typeof options.refreshIntervalMs === "number"
    && Number.isFinite(options.refreshIntervalMs)
    && options.refreshIntervalMs > 0
    ? options.refreshIntervalMs
    : DEFAULT_REFRESH_INTERVAL_MS
}
