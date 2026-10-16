import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const TITLE = "Show each task's title next to its id, in agent text and a status line"

/**
 * The engine beneath the mod: session `s-1`, a server whose answer `reply` sets (a thrown Error stands for one that is
 * down; while `hold` has set a gate, each fetch answers only once that gate opens), and every status line the mod pins,
 * in order. Returns the fetched URLs and the lines.
 */
function world(on: On, env: Record<string, string> = {}) {
  const urls: string[] = []
  const lines: (string | undefined)[] = []
  let reply: { status: number; text: string } | Error = { status: 200, text: JSON.stringify({ step: null }) }
  let gate: Promise<void> | undefined
  mock.env(on, env)
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 's-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('http.fetch', async ($, e) => {
    urls.push(e.url)
    // The answer as it stood when asked, so a fetch held at the gate answers what the server said then.
    const r = reply
    const held = gate
    if (held) await held
    if (r instanceof Error) throw r
    return { value: { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, text: r.text } }
  })
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  const answer = (r: typeof reply) => {
    reply = r
  }
  const step = (id: number, title: string, status = 'active') => answer({ status: 200, text: JSON.stringify({ step: { id, title, status } }) })
  const hold = (g: Promise<void> | undefined) => {
    gate = g
  }
  return { urls, lines, clock, answer, step, hold }
}

const START = { cwd: 'C:/work', surface: null, isInteractive: false } as const
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

test("shows the claimed step's id and title at session start, read for this session from the live server", async ($, on) => {
  const w = world(on)
  w.step(440, TITLE)
  await $.session.start(START)
  expect(w.urls).toEqual(['http://127.0.0.1:4317/api/sessions/s-1/step'])
  expect(w.lines).toEqual(["#440 Show each task's title next to its id, in agent t…"])
})

test('flattens a multi-line title, keeps a short one whole, and names a step that is no longer open', async ($, on) => {
  const w = world(on)
  w.step(7, 'Fix\n  the   export', 'done')
  await $.session.start(START)
  expect(w.lines).toEqual(['#7 Fix the export · done'])
})

test('reads INPROGRESS_PORT when it names a port, as the CLI and hooks do', async ($, on) => {
  const w = world(on, { INPROGRESS_PORT: '4405' })
  await $.session.start(START)
  expect(w.urls).toEqual(['http://127.0.0.1:4405/api/sessions/s-1/step'])
})

test('shows nothing for no claim, and clears quietly when the server is down, errs or answers something else', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  // No claim at start: the line was never set, so nothing is pinned.
  expect(w.lines).toEqual([])
  for (const bad of [new Error('connect ECONNREFUSED'), { status: 500, text: '{}' }, { status: 200, text: '<html>' }, { status: 200, text: '{"step":{"id":"x"}}' }]) {
    w.step(440, TITLE)
    await w.clock.advance(30_000)
    w.answer(bad)
    await w.clock.advance(30_000)
  }
  expect(w.lines).toEqual(Array.from({ length: 4 }, () => ["#440 Show each task's title next to its id, in agent t…", undefined]).flat())
})

test('rereads every half minute, and pins the line again only when it changed', async ($, on) => {
  const w = world(on)
  w.step(440, TITLE)
  await $.session.start(START)
  await w.clock.advance(30_000)
  await w.clock.advance(30_000)
  expect(w.urls).toHaveLength(3)
  w.step(441, 'Next one')
  await w.clock.advance(30_000)
  expect(w.lines).toEqual(["#440 Show each task's title next to its id, in agent t…", '#441 Next one'])
})

test("rereads at the end of the main loop's turn, not a subagent's", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.step(441, 'Claimed mid-turn')
  await $.turn.complete({ ...TURN, agentId: 'sub-1' })
  expect(w.urls).toHaveLength(1)
  await $.turn.complete(TURN)
  expect(w.urls).toHaveLength(2)
  expect(w.lines).toEqual(['#441 Claimed mid-turn'])
})

test("a hung server holds the turn's end two seconds at most, and its late answer never overwrites a newer one", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  let open!: () => void
  w.hold(new Promise<void>((resolve) => (open = resolve)))
  w.step(440, TITLE)
  let ended = false
  const turn = $.turn.complete(TURN).then(() => (ended = true))
  await w.clock.advance(1_999)
  expect(ended).toBe(false)
  await w.clock.advance(1)
  await turn
  expect(w.lines).toEqual([])
  // The server is back: the next turn reads the newer claim, then the hung fetch answers with the older one.
  w.hold(undefined)
  w.step(441, 'Newer')
  await $.turn.complete(TURN)
  open()
  await w.clock.settle()
  expect(w.urls).toHaveLength(3)
  expect(w.lines).toEqual(['#441 Newer'])
})
