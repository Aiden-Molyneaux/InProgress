import type { EngineInterface, Register } from 'claude-code'

/** The live InProgress server's port when INPROGRESS_PORT names none (src/lib/home.ts). */
const DEFAULT_PORT = 4317
/** How often the line rereads the claim: a claim made mid-turn shows within this, or at the turn's end. */
const REFRESH_MS = 30_000
/** How long a turn's end waits for the reread before it lets the turn finish. */
const TURN_WAIT_MS = 2_000
/** How much of the title the line keeps, as the briefing's other step names do (src/core/step-ref.ts). */
const TITLE_MAX = 50

interface ClaimedStep {
  id: number
  title: string
  status: string
}

/** `#440 Show each task's title…`: the claimed step as the line shows it, with its status when the step is no longer open. */
export function stepLine(step: ClaimedStep): string {
  const title = step.title.replace(/\s+/g, ' ').trim()
  const clipped = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title
  const closed = step.status === 'done' || step.status === 'dropped' || step.status === 'blocked' ? ` · ${step.status}` : ''
  return `${clipped ? `#${step.id} ${clipped}` : `#${step.id}`}${closed}`
}

/** The line for a `GET /api/sessions/:id/step` body: undefined for no claim, or a body that is not the route's shape. */
export function lineFromBody(text: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  const step = (body as { step?: unknown } | null)?.step as Partial<ClaimedStep> | null | undefined
  if (!step || typeof step.id !== 'number' || typeof step.title !== 'string' || typeof step.status !== 'string') return undefined
  return stepLine(step as ClaimedStep)
}

// The line last shown, so an unchanged reread does not redraw it, and the newest reread's number, so an older one that
// answers late never overwrites it. A reload runs the module afresh, which starts both over.
let shown: string | undefined
let latest = 0

function show($: EngineInterface, line: string | undefined): void {
  if (line === shown) return
  shown = line
  $.ui.status(line)
}

/** Rereads the session's claim. A server that is down, slow to start or answering oddly clears the line; it never throws. */
async function refresh($: EngineInterface): Promise<void> {
  const mine = ++latest
  let line: string | undefined
  try {
    const port = Number(await $.env.get('INPROGRESS_PORT'))
    const base = `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT}`
    const id = await $.session.id()
    const res = await $.http.fetch(`${base}/api/sessions/${encodeURIComponent(id)}/step`)
    line = res.ok ? lineFromBody(res.text) : undefined
  } catch {
    line = undefined
  }
  if (mine === latest) show($, line)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    // Started here, the timer outlives this dispatch; a reload runs register again and starts a fresh one.
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // The main loop's turns only: a subagent's end says nothing about the session's claim.
    if (e.agentId === undefined) await Promise.race([refresh($), $.clock.sleep(TURN_WAIT_MS)])
    return done
  })
}
