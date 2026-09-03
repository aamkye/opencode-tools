import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

declare const api: TuiPluginApi

async function createTokenReportSession(): Promise<string | undefined> {
  const result = await api.client.session.create({
    body: { title: "Token Reports" },
  })
  return result.data?.id
}

void createTokenReportSession()
