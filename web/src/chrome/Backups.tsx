import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BACKUP_BUSY, type BackupLevel, type BackupStatus } from '../../../src/core/backups';
import { api } from '../api';
import { Eyebrow } from '../parts/Eyebrow';
import { Frame } from '../parts/Frame';
import { restoreCommands, worstLevel, worstNote } from './backupsLogic';

/** How often the open panel asks again while someone else's backup holds the lock. */
const POLL_MS = 3000;
/** How long a Copy button reads Copied. */
const COPIED_MS = 1500;
/** How often the footer's mark is read again while the window stays open. */
const MARK_MS = 60 * 60 * 1000;

const MARK: Record<BackupLevel, string> = { ok: '●', warn: '▲', fail: '✕' };

/**
 * The Backups button in the footer, with a mark for the worst thing doctor's Backups check would say, and the panel it
 * opens: a modal dialog (as GoTo's) with the newest snapshot, push and drill, Back up now, Open backups folder, and the
 * commands that restore. Restoring is the CLI's: it needs InProgress stopped, so the window only shows the commands.
 */
export function Backups() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** An open panel is waiting on a status read. */
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const backUpButton = useRef<HTMLButtonElement>(null);
  /** Set at once on a click, before the state shows it: a second click in the same moment starts nothing. */
  const started = useRef(false);
  const copyTimer = useRef(0);

  /** Reads the status; `visible` shows "Reading…" meanwhile (an open panel's own read, not the mark's or the poll's). */
  const refresh = useCallback(async (visible = false) => {
    if (visible) setReading(true);
    try {
      setStatus(await api.backups());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (visible) setReading(false);
    }
  }, []);

  // For the footer's mark: once now, then hourly and whenever the window is shown again, so it never sits stale for days.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), MARK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // The last result stays through a close and reopen; only a new run clears it.
  const show = () => {
    setOpen(true);
    void refresh(true);
  };

  /** Closes the panel; focus goes back to the footer button. The dialog closes first: while modal, the rest of the window is inert. */
  const close = () => {
    if (dialog.current?.open) dialog.current.close();
    setOpen(false);
    button.current?.focus();
  };

  useLayoutEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) {
      d.showModal();
      // On the dialog itself, not its first button: Enter twice from the footer must not start a backup.
      d.focus();
    }
  }, [open]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  // Someone else's run (a tick, or the CLI): look again until its lock is gone.
  const othersRun = open && !running && !!status?.busy;
  useEffect(() => {
    if (!othersRun) return;
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [othersRun, refresh]);

  const backUp = async () => {
    if (started.current) return;
    started.current = true;
    // The button is about to be disabled, which drops its focus to the page: park it on the dialog, so Escape still reaches it.
    dialog.current?.focus();
    setRunning(true);
    setResult(null);
    const answer = await api.backUpNow();
    started.current = false;
    setRunning(false);
    // Enabled again after this render. Focus goes back to the button only if it is still where the run parked it.
    window.setTimeout(() => {
      if (document.activeElement === dialog.current) backUpButton.current?.focus();
    }, 0);
    if (answer === 'reload') {
      setResult({ text: 'The server restarted: reload the window.', ok: false });
    } else if (typeof answer === 'string') {
      setResult({ text: answer, ok: false });
    } else {
      setStatus(answer.status);
      setResult({ text: answer.result.message, ok: answer.result.status === 'ok' });
    }
  };

  const openFolder = async () => {
    const answer = await api.openBackupsFolder();
    if (answer !== 'ok') setResult({ text: answer === 'reload' ? 'The server restarted: reload the window.' : answer, ok: false });
  };

  const copy = (command: string) => {
    // A refused write (no clipboard permission) leaves the button as it was; the command is on screen to select.
    navigator.clipboard.writeText(command).then(
      () => {
        setCopied(command);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
      },
      () => undefined,
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    // Every key stays in here: the app's own keys would otherwise act under the panel.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const level = status ? worstLevel(status) : null;
  const busy = running || !!status?.busy;
  // A lock held now outranks an older result: the result is from before it.
  const line = running ? '' : status?.busy ? BACKUP_BUSY : (result?.text ?? '');
  return (
    <>
      <button
        ref={button}
        className="ip-backups-btn"
        data-level={level ?? 'none'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status ? (worstNote(status) ?? 'Backups: all well') : 'Backups'}
        onClick={() => (open ? close() : show())}
      >
        {level && <span aria-hidden="true">{MARK[level]} </span>}
        Backups
        {level === 'fail' && <span aria-hidden="true"> FAIL</span>}
      </button>
      <dialog
        ref={dialog}
        className="ip-backups"
        aria-label="Backups"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        // Escape is ours (keydown above); this covers a focus the keydown does not reach.
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        // However the dialog closes, the state follows.
        onClose={() => setOpen(false)}
        // A press on the backdrop is a press on the dialog itself, outside its box; one on its own scrollbar is inside it.
        onMouseDown={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const outside = e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
          if (e.target === e.currentTarget && outside) {
            e.preventDefault();
            close();
          }
        }}
      >
        {open && (
          <>
            <Frame />
            <div className="ip-backups-body">
              <Eyebrow as="h2" glyph="//">
                Backups
              </Eyebrow>
              {error && <p className="ip-backups-error">Could not read the backups: {error}</p>}
              {reading && <p className="ip-backups-note">Reading…</p>}
              {status && (
                <dl className="ip-backups-rows">
                  {status.rows.map((r) => (
                    <div key={r.label} className="ip-backups-row" data-level={r.level}>
                      <dt>{r.label}</dt>
                      <dd>
                        {r.value}
                        {r.level !== 'ok' && <span className="ip-backups-flag"> {r.level === 'fail' ? 'FAIL' : 'WARN'}</span>}
                        {r.note && <span className="ip-backups-note">{r.note}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="ip-backups-actions">
                <button ref={backUpButton} className="ip-btn" disabled={busy || !status} onClick={() => void backUp()}>
                  {running ? 'Backing up…' : 'Back up now'}
                </button>
                <button className="ip-btn" onClick={() => void openFolder()}>
                  Open backups folder
                </button>
                <button className="ip-btn" onClick={close}>
                  Close
                </button>
              </div>
              <div className="ip-backups-result" role="status" data-tone={result && !result.ok ? 'alarm' : undefined}>
                {line}
              </div>
              {status && (
                <section aria-label="Restore" className="ip-backups-restore">
                  <Eyebrow as="h3" glyph="//">
                    Restore
                  </Eyebrow>
                  <p className="ip-backups-note">Restore runs in the CLI, with InProgress stopped.</p>
                  {restoreCommands(status).map((c) => (
                    <div key={c.command} className="ip-backups-cmd">
                      <code>{c.command}</code>
                      {c.detail && <span className="ip-backups-note">{c.detail}</span>}
                      <button className="ip-btn" aria-label={`Copy ${c.command}`} onClick={() => copy(c.command)}>
                        {copied === c.command ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </section>
              )}
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
