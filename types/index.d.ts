export type Gauge = { label: string; percent: number }

export type MeterView = {
  // Input tokens the last response was answered over, and that as a share of the window.
  tokens?: number
  percent?: number
  limits: Gauge[]
  // Share of the last turn's input read back from the prompt cache (0-100).
  cacheReused?: number
  // Tokens the last turn had to write to the cache again; set only when it rebuilt.
  cacheRebuilt?: number
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'light': { view: MeterView | null }
  }
}
