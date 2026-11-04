import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 24 },
  { kind: 'seven_day', percentUsed: 39.4 },
]

const usage = (cacheRead: number, cacheWrite: number) => ({
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

const turn = (u = usage(300_000, 2_000)) => ({
  answer: 'done',
  durationMs: 1_000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  usage: u,
})

const band = (surface: 'terminal' | 'desktop', bodyColumns = 120) => ({
  plugin: 'light',
  surface,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const)

// Hooks here stand for the engine: they answer the mod's calls.
function engine(on: On, clock = mock.clock(on), answer = () => ({
  startedAt: 0,
  context: { tokens: 340_000, window: 1_000_000, percent: 34 } as { tokens?: number; window: number; percent?: number },
  rateLimits: LIMITS as { kind: string; percentUsed: number; resetsAt?: string }[],
  cost: { usd: 12.4 },
})) {
  const seen = { toasts: [] as string[] }
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: answer() }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { ...seen, clock }
}

const start = { cwd: '/', surface: 'terminal' as const, isInteractive: true }

async function meterText($: Parameters<TestBody>[0], bodyColumns = 120) {
  const ui = await $.ui.mount(band('terminal', bodyColumns))
  const found = await ui.find({ key: 'light' })
  await ui.unmount()
  return found
}

test('the meter shows context, limits, cache and cost, on every surface', async ($, on) => {
  engine(on)
  await $.session.start(start)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    const text = (await ui.find({ key: 'light' }))?.text ?? ''
    expect(text).toBe(
      '░▒▓ CTX ▰▰▰▱▱▱▱▱▱▱ 340k 34% │ 5H ▰▱▱▱▱ 24% │ 7D ▰▰▱▱▱ 39% │ CACHE waiting for first reply │ $12.40 ▓▒░',
    )
    await ui.unmount()
  }
})

test('the meter is one centered row', async ($, on) => {
  engine(on)
  await $.session.start(start)

  const found = await meterText($)
  expect(found?.props).toMatchObject({ height: 1, justifyContent: 'center' })
})

test('cache reads as a plain share reused, or as rebuilt', async ($, on) => {
  engine(on)
  await $.session.start(start)

  await $.turn.complete(turn(usage(294_000, 6_000)))
  expect((await meterText($))?.text).toContain('CACHE ✔ 98% reused')

  await $.turn.complete(turn(usage(1_000, 300_000)))
  expect((await meterText($))?.text).toContain('CACHE ✘ rebuilt 300k')
})

test('a narrow terminal drops the bars and keeps the numbers', async ($, on) => {
  engine(on)
  await $.session.start(start)

  const text = (await meterText($, 60))?.text ?? ''
  expect(text).toContain('CTX 340k 34%')
  expect(text).not.toContain('▰')
})

test('new measurements redraw the meter', async ($, on) => {
  engine(on)
  await $.session.start(start)

  await $.session.measure({
    context: { tokens: 120_000, window: 1_000_000, percent: 12 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 85 }],
    cost: { usd: 2 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  const text = (await meterText($))?.text ?? ''
  expect(text).toContain('120k 12%')
  expect(text).toContain('5H ▰▰▰▰▱ 85%')
  expect(text).not.toContain('7D')
})

test('the meter shows no pop-ups', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start)

  await $.session.measure({
    context: { tokens: 900_000, window: 1_000_000, percent: 90 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 99 }],
    changed: ['context', 'rateLimits'],
  })
  await $.turn.complete(turn(usage(1_000, 300_000)))
  expect(seen.toasts).toEqual([])
})

test('before the first response the context reads as empty', async ($, on) => {
  engine(on, undefined, () => ({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } }))
  await $.session.start(start)

  expect((await meterText($))?.text).toContain('CTX ▱▱▱▱▱▱▱▱▱▱ 0 0%')
})

test('a window that reset while idle drops to zero without a new response', async ($, on) => {
  const { clock } = engine(on, mock.clock(on, { now: Date.parse('2026-11-04T10:00:00Z') }), () => ({
    startedAt: 0,
    context: { tokens: 340_000, window: 1_000_000, percent: 34 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 92, resetsAt: '2026-11-04T12:00:00Z' },
      { kind: 'seven_day', percentUsed: 39.4, resetsAt: '2026-11-08T00:00:00Z' },
    ],
    cost: { usd: 12.4 },
  }))
  await $.session.start(start)
  expect((await meterText($))?.text).toContain('5H ▰▰▰▰▰ 92%')

  await clock.advance(2 * 60 * 60 * 1000)
  const text = (await meterText($))?.text ?? ''
  expect(text).toContain('5H ▱▱▱▱▱ 0%')
  expect(text).toContain('7D ▰▰▱▱▱ 39%')
})

test('the meter waits an hour before re-reading usage while idle', async ($, on) => {
  let used = 24
  const { clock } = engine(on, undefined, () => ({ startedAt: 0, context: { tokens: 340_000, window: 1_000_000, percent: 34 }, rateLimits: [{ kind: 'five_hour', percentUsed: used }], cost: { usd: 12.4 } }))
  await $.session.start(start)

  used = 61
  await clock.advance(59 * 60 * 1000)
  expect((await meterText($))?.text).toContain('5H ▰▱▱▱▱ 24%')
  await clock.advance(60 * 60 * 1000)
  expect((await meterText($))?.text).toContain('5H ▰▰▰▱▱ 61%')
})
