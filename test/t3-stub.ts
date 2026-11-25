import type { SenderT3, StartOptions } from '../src/server/lead/sends';
import { T3Unavailable, type T3Message, type T3Thread } from '../src/server/t3';

/**
 * A stand-in for T3 Code, in process: stage 0's stub-t3.mjs (lead-plans:spikes/lead-stage0/p2) as the sender's four calls.
 * Like the stub it deliberately does not dedupe: a start or a send made twice makes two. `down` answers every call as T3
 * Code not running (nothing reaches it). `nextStart` and `nextSend` pick how the next one goes wrong, once.
 */
export type StartFault =
  /** Made, with its title and first message, and answered. */
  | 'ok'
  /** Made, with its title and first message, but the answer is lost (a timeout). */
  | 'lost'
  /** Made, but with no title and no first message, and the answer is lost: no lookup can find it. */
  | 'lost-bare'
  /** Made, with its title and first message, and the answer never comes: the process died waiting. */
  | 'hang';
export type SendFault = 'ok' | 'lost' | 'hang';

interface StubThread {
  threadId: string;
  project: string;
  title: string;
  messages: T3Message[];
  updatedAt: string;
}

export class StandInT3 implements SenderT3 {
  readonly threads: StubThread[] = [];
  down = false;
  nextStart: StartFault = 'ok';
  nextSend: SendFault = 'ok';
  /** How many starts and sends reached it. */
  starts = 0;
  sends = 0;
  private n = 0;

  private refuseIfDown(what: string): void {
    if (this.down) throw new T3Unavailable(`t3 thread ${what} failed: exit 1: T3 Code is not running`);
  }

  private toThread(t: StubThread): T3Thread {
    return {
      threadId: t.threadId,
      projectId: t.project,
      title: t.title,
      link: `t3://thread/${t.threadId}`,
      status: 'idle',
      runtimeMode: 'full-access',
      settled: true,
      archived: false,
      pendingRequestCount: 0,
      updatedAt: t.updatedAt,
      createdBy: 'cli',
      creationSource: 'cli',
    };
  }

  async list(project: string): Promise<T3Thread[]> {
    this.refuseIfDown('list');
    return this.threads.filter((t) => t.project === project).map((t) => this.toThread(t));
  }

  async show(threadId: string): Promise<{ thread: T3Thread; messages: T3Message[] }> {
    this.refuseIfDown('show');
    const t = this.threads.find((x) => x.threadId === threadId);
    if (t === undefined) throw new T3Unavailable(`t3 thread show failed: exit 1: no thread ${threadId}`);
    return { thread: this.toThread(t), messages: [...t.messages] };
  }

  async start(project: string, message: string, opts: StartOptions): Promise<{ threadId: string }> {
    this.refuseIfDown('start');
    this.starts++;
    const fault = this.nextStart;
    this.nextStart = 'ok';
    const t: StubThread = { threadId: `th_${++this.n}`, project, title: fault === 'lost-bare' ? '' : (opts.title ?? ''), messages: [], updatedAt: new Date(this.n * 1000).toISOString() };
    if (fault !== 'lost-bare') t.messages.push({ role: 'user', text: message });
    this.threads.push(t);
    if (fault === 'hang') return new Promise(() => undefined);
    if (fault !== 'ok') throw new T3Unavailable('t3 thread start failed: timed out after 60 s', true);
    return { threadId: t.threadId };
  }

  async send(threadId: string, message: string): Promise<void> {
    this.refuseIfDown('send');
    const t = this.threads.find((x) => x.threadId === threadId);
    if (t === undefined) throw new T3Unavailable(`t3 thread send failed: exit 1: no thread ${threadId}`);
    this.sends++;
    const fault = this.nextSend;
    this.nextSend = 'ok';
    t.messages.push({ role: 'user', text: message });
    if (fault === 'hang') return new Promise(() => undefined);
    if (fault === 'lost') throw new T3Unavailable('t3 thread send failed: timed out after 60 s', true);
  }

  /** How many threads and messages it holds, as the stub's /stats. */
  stats(): { threads: number; messages: number } {
    return { threads: this.threads.length, messages: this.threads.reduce((n, t) => n + t.messages.length, 0) };
  }
}
