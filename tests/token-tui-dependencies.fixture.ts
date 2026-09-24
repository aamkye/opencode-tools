export { TOKEN_REPORT_COMMANDS } from "../lib/tokens/token-commands.js"
export { renderTokenReport } from "../lib/tokens/token-report-presenter.js"

export async function computeTokenReport(params: unknown, dependencies: unknown): Promise<unknown> {
  const compute = (globalThis as { __tokenTuiCompute?: (params: unknown, dependencies: unknown) => Promise<unknown> }).__tokenTuiCompute
  if (!compute) throw new Error("Controlled token report computation was not configured")
  return compute(params, dependencies)
}
