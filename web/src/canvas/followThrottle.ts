/** Follow moves the camera at most once per interval, to the newest target. */
const FOLLOW_INTERVAL_MS = 1500;
/** The snapshot that holds a brand-new node lands ~150 ms after its event, so the first try waits at least this long. */
const FIRST_TRY_MS = 350;
const RETRY_MS = 300;
const MAX_TRIES = 4;

export interface FollowThrottle {
  /** A live event's node. The newest one wins, and a move that is already waiting keeps its slot. */
  push: (target: number) => void;
  /** Drops the waiting move, if there is one. */
  cancel: () => void;
}

export interface FollowThrottleOptions {
  /** Centres the camera on the node. False while the node isn't laid out yet (its snapshot hasn't landed). */
  move: (target: number) => boolean;
  /** When the camera last moved, for any reason (Date.now() ms). */
  lastMove: () => number;
}

/** Follow's scheduler: a true throttle, so a burst of events can't keep pushing the move back. */
export function createFollowThrottle({ move, lastMove }: FollowThrottleOptions): FollowThrottle {
  let target: number | undefined;
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = (ms: number) => {
    timer = setTimeout(fire, ms);
  };
  const fire = () => {
    timer = undefined;
    if (target === undefined) return;
    // Another camera move (Home, N, a session chip) restarts the interval as well.
    const left = FOLLOW_INTERVAL_MS - (Date.now() - lastMove());
    if (left > 0) return wait(left);
    if (move(target) || ++tries >= MAX_TRIES) target = undefined;
    else wait(RETRY_MS);
  };
  return {
    push(next) {
      if (next !== target) tries = 0;
      target = next;
      if (timer === undefined) wait(Math.max(FIRST_TRY_MS, FOLLOW_INTERVAL_MS - (Date.now() - lastMove())));
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      target = undefined;
    },
  };
}
