import { createSignal, For, Show } from "solid-js"

import {
  acquireQuotaProviderHub,
  defineTuiPlugin,
  homeQuotaPercentParts,
  homeQuotaStatusRole,
  panelTheme,
  type PanelTheme,
  type HomeQuotaSummary,
  pluginDescriptor,
  type QuotaProviderAdapter,
} from "../shared/opencode-tools-shared.js"

function HomeQuotaLine(props: { summary: HomeQuotaSummary; theme: () => PanelTheme }) {
  const primary = () => homeQuotaPercentParts(props.summary)[0]
  const secondary = () => homeQuotaPercentParts(props.summary)[1]

  return (
    <box flexDirection="row" justifyContent="center">
      <text fg={props.theme().textMuted}>{props.summary.provider}: {props.summary.plan}; </text>
      <text fg={props.theme()[homeQuotaStatusRole(primary().pct)]}>{primary().text}</text>
      <Show when={secondary()}>
        {(value) => <><text fg={props.theme().textMuted}>/</text><text fg={props.theme()[homeQuotaStatusRole(value().pct)]}>{value().text}</text></>}
      </Show>
    </box>
  )
}

function HomeQuotaLines(props: {
  providers: () => readonly QuotaProviderAdapter[]
  theme: () => PanelTheme
}) {
  return (
    <box flexDirection="column">
      <For each={props.providers()}>
        {(provider) => <Show when={provider.home()}>{(item) => <HomeQuotaLine summary={item()} theme={props.theme} />}</Show>}
      </For>
    </box>
  )
}

const plugin = defineTuiPlugin(pluginDescriptor("home"), (context, api) => {
  const hub = acquireQuotaProviderHub({ ...context, api }, { consumer: "home" })
  const [hubProviders, setHubProviders] = createSignal(hub.value.providers())
  context.onCleanup(hub.value.subscribe(() => setHubProviders(hub.value.providers())))
  const providers = (): readonly QuotaProviderAdapter[] => hubProviders()
    .filter((provider) => provider.id === "zai" || provider.id === "openai")

  context.onCleanup(api.ui.slot({
    append: "home.footer.status",
    render: () => <HomeQuotaLines providers={providers} theme={() => panelTheme(api)} />,
  }))
})

export default plugin
