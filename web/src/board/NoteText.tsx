import { splitRefs } from './text';

/** Plain note text where a `#id` of a known step is a button that opens that step's Details. */
export function NoteText({ text, has, onOpen }: { text: string; has: (id: number) => boolean; onOpen: (id: number) => void }) {
  return (
    <>
      {splitRefs(text, has).map((run, i) =>
        run.kind === 'text' ? (
          run.text
        ) : (
          <button key={i} type="button" className="ip-ref" data-act onClick={() => onOpen(run.id)}>
            {run.text}
          </button>
        ),
      )}
    </>
  );
}
