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

/**
 * `#440 Show each task's title…`: the claimed step as the line shows it, with its status once it is done, dropped or
 * blocked. The title is clipped as `clipLine` does (src/core/step-ref.ts): never between the halves of a surrogate pair.
 */
export function stepLine(step: ClaimedStep): string {
  const title = step.title.replace(/\s+/g, ' ').trim()
  let clipped = title
  if (title.length > TITLE_MAX) {
    const code = title.charCodeAt(TITLE_MAX - 2)
    clipped = `${title.slice(0, code >= 0xd800 && code <= 0xdbff ? TITLE_MAX - 2 : TITLE_MAX - 1)}…`
  }
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

// The line last shown, so an unchanged reread does not redraw it; null until the first reread, since after a reload the
// engine still pins the old module's line. The newest reread's number, so an older one that answers late never overwrites
// it. Whether the newest reread failed (an error or a non-ok answer), so a turn's end stops waiting on a server that is
// down. Whether the timer's last reread is still pending, so a hung server does not pile up a fetch every tick. A reload
// runs the module afresh, which starts them all over.
let shown: string | undefined | null = null
let latest = 0
let failing = false
let ticking = false

function show($: EngineInterface, line: string | undefined): void {
  if (line === shown) return
  shown = line
  $.ui.status(line)
}

/** Rereads the session's claim. A server that is down, slow to start or answering oddly clears the line; it never throws. */
async function refresh($: EngineInterface): Promise<void> {
  const mine = ++latest
  let line: string | undefined
  let failed = false
  try {
    const port = Number(await $.env.get('INPROGRESS_PORT'))
    const base = `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT}`
    const id = await $.session.id()
    const res = await $.http.fetch(`${base}/api/sessions/${encodeURIComponent(id)}/step`)
    failed = !res.ok
    line = res.ok ? lineFromBody(res.text) : undefined
  } catch {
    failed = true
    line = undefined
  }
  if (mine !== latest) return
  failing = failed
  show($, line)
}

/** A reread that holds the caller `TURN_WAIT_MS` at most; a hung one carries on in the background. */
function bounded($: EngineInterface): Promise<void> {
  return Promise.race([refresh($), $.clock.sleep(TURN_WAIT_MS)])
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Started here, the timer outlives this dispatch; a reload runs register again and starts a fresh one. Started before
    // the first reread, so a server that hangs at start still gets the timer's rereads.
    $.clock.every(REFRESH_MS, () => {
      if (ticking) return
      ticking = true
      void refresh($).finally(() => (ticking = false))
    })
    await bounded($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // The main loop's turns only: a subagent's end says nothing about the session's claim. While the server is failing,
    // the turn still rereads, so a recovered server shows at the next turn's end, but does not wait for it.
    if (e.agentId === undefined) {
      if (failing) void refresh($)
      else await bounded($)
    }
    return done
  })
}
