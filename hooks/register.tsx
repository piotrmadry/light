import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, SessionContextUsage, SessionCost, SessionRateLimit, Timer, TurnUsage } from 'claude-code'

import type { MeterView } from '../types'

// Absolute size matters more than percent on a 1M window: every request re-sends the whole context.
const BIG_CONTEXT = 200_000
const WARM_CONTEXT = 100_000
const LIMIT_WARN = 50
const LIMIT_BAD = 80
const WIDE_COLUMNS = 90
// Limits only move when a response reports them: a timer at the next reset catches the window starting over
// while idle, and an hourly re-read catches anything else.
const REFRESH_MS = 60 * 60 * 1000

type Snapshot = { context?: SessionContextUsage; rateLimits: SessionRateLimit[]; cost?: SessionCost }
type Meter = { snap: Snapshot; lastTurn?: TurnUsage; atReset?: Timer }
type Level = 'success' | 'warning' | 'error'

const view = atom({ plugin: 'light', key: 'view' } as const, null)

const LIMIT_LABEL: Record<string, string> = { five_hour: '5H', seven_day: '7D' }

export function tokens(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`
}

function inputOf(u: TurnUsage) {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

// A window past its reset time starts over at zero, even before a response says so.
function percentOf(r: SessionRateLimit, now: number) {
  const resetsAt = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
  return resetsAt <= now ? 0 : r.percentUsed
}

export function toView(m: Meter, now: number): MeterView {
  const u = m.lastTurn
  const input = u ? inputOf(u) : 0
  return {
    tokens: m.snap.context?.tokens,
    percent: m.snap.context?.percent,
    limits: m.snap.rateLimits
      .filter(r => LIMIT_LABEL[r.kind])
      .map(r => ({ label: LIMIT_LABEL[r.kind] ?? r.kind, percent: percentOf(r, now) })),
    cacheReused: u && input > 0 ? Math.round((100 * u.cache_read_input_tokens) / input) : undefined,
    cacheRebuilt: u && input > 0 && u.cache_creation_input_tokens > 0.5 * input ? u.cache_creation_input_tokens : undefined,
    usd: m.snap.cost?.usd,
  }
}

function levelOf(value: number, warnAt: number, badAt: number): Level {
  return value >= badAt ? 'error' : value >= warnAt ? 'warning' : 'success'
}

export function bar(percent: number, cells: number) {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return { filled: '▰'.repeat(filled), empty: '▱'.repeat(cells - filled) }
}

async function draw($: Engine, m: Meter) {
  const now = await $.clock.now()
  const next = toView(m, now)
  await update($, view, prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))

  const resets = m.snap.rateLimits.map(r => (r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt))).filter(t => t > now)
  m.atReset?.cancel()
  m.atReset = resets.length > 0 ? $.clock.after(Math.min(...resets) - now, () => void measure($, m)) : undefined
}

async function measure($: Engine, m: Meter) {
  const usage = await $.session.usage()
  m.snap = { context: usage.context, rateLimits: usage.rateLimits, cost: usage.cost }
  await draw($, m)
}

export const register: Register = on => {
  const m: Meter = { snap: { rateLimits: [] } }
  let refresh: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    m.lastTurn = undefined
    await measure($, m)
    refresh?.cancel()
    refresh = $.clock.every(REFRESH_MS, () => void measure($, m))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage && inputOf(e.usage) > 0) {
      m.lastTurn = e.usage
      await draw($, m)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    m.snap = { context: e.context, rateLimits: e.rateLimits, cost: e.cost }
    await draw($, m)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || v === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const isWide = e.props.bodyColumns >= WIDE_COLUMNS
    const sep = <Text dimColor> │ </Text>
    const gauge = (percent: number, cells: number, level: Level) => {
      const b = bar(percent, cells)
      return (
        <Text>
          {' '}
          <Text color={level}>{b.filled}</Text>
          <Text dimColor>{b.empty}</Text>
        </Text>
      )
    }

    // Before the first response there is no context to measure yet: read it as empty.
    const t = v.tokens ?? 0
    const ctxLevel = levelOf(t, WARM_CONTEXT, BIG_CONTEXT)
    const cache =
      v.cacheReused === undefined ? (
        <Text dimColor>waiting for first reply</Text>
      ) : v.cacheRebuilt !== undefined ? (
        <Text color="error">✘ rebuilt {tokens(v.cacheRebuilt)}</Text>
      ) : (
        <Text color={v.cacheReused >= 80 ? 'success' : 'warning'}>✔ {v.cacheReused}% reused</Text>
      )

    // One centered Text that truncates, so the band never takes more than one row.
    return (
      <Box key="light" height={1} width="100%" justifyContent="center">
        <Text wrap="truncate-end">
          <Text color="claude">░▒▓ </Text>
          <Text bold>CTX</Text>
          {isWide ? gauge(v.percent ?? 0, 10, ctxLevel) : null}
          <Text color={ctxLevel} bold> {tokens(t)}</Text>
          <Text dimColor> {v.percent ?? 0}%</Text>
          {v.limits.map(l => (
            <Text>
              {sep}
              <Text bold>{l.label}</Text>
              {isWide ? gauge(l.percent, 5, levelOf(l.percent, LIMIT_WARN, LIMIT_BAD)) : null}
              <Text color={levelOf(l.percent, LIMIT_WARN, LIMIT_BAD)}> {Math.round(l.percent)}%</Text>
            </Text>
          ))}
          {sep}
          <Text bold>CACHE </Text>
          {cache}
          {v.usd === undefined ? null : (
            <Text>
              {sep}
              <Text dimColor>${v.usd.toFixed(2)}</Text>
            </Text>
          )}
          <Text color="claude"> ▓▒░</Text>
        </Text>
      </Box>
    )
  })
}
