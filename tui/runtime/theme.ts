import type { Plugin } from "@opencode/plugin/tui"

import type { PanelTheme } from "../presentation/compact-panel.js"

export function panelTheme(context: Plugin.Context): PanelTheme {
  return {
    text: context.theme.text.base,
    textMuted: context.theme.text.muted,
    success: context.theme.text.feedback.success.base,
    warning: context.theme.text.feedback.warning.base,
    error: context.theme.text.feedback.error.base,
  }
}
