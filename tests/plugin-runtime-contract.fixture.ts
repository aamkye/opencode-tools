import type { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"

import { defineTuiPlugin, type FeatureActivation, type ServiceFactory, type TuiFeatureContext } from "../tui/runtime/plugin.js"
import { panelTheme } from "../tui/runtime/theme.js"
import type { PanelTheme } from "../tui/presentation/compact-panel.js"

type Assert<T extends true> = T
type HasDisposeKey<T> = "dispose" extends keyof T ? true : false
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false

export type ObjectServiceFactoryMustExposeDispose = Assert<
  HasDisposeKey<ReturnType<ServiceFactory<{ id: number }>>>
>

export type NativeDefinition = Assert<Equal<ReturnType<typeof defineTuiPlugin>, Plugin.Definition>>
export type NativeActivation = Assert<Equal<
  FeatureActivation,
  (scope: TuiFeatureContext, api: Plugin.Context) => void | Plugin.Cleanup | Promise<void | Plugin.Cleanup>
>>
export type NativeCleanup = Assert<Equal<Parameters<TuiFeatureContext["onCleanup"]>, [Plugin.Cleanup]>>
export type NativeTheme = Assert<Equal<Parameters<typeof panelTheme>, [Plugin.Context]>>
export type PanelColors = Assert<Equal<PanelTheme[keyof PanelTheme], string | RGBA>>

export function inspectNativeContext(api: Plugin.Context) {
  // @ts-expect-error Native plugins do not expose V1 lifecycle registration.
  api.lifecycle.onDispose(() => {})
  // @ts-expect-error Native plugin theme tokens are not the V1 flat theme.
  api.theme.current
  return panelTheme(api)
}
