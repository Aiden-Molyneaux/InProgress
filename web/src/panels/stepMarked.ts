import { Marked } from 'marked';

/** The ids the step-ref extension turns into links, set around each parse (a parse is synchronous). */
let knownStep: (id: number) => boolean = () => false;

/** A Markdown reader that also links `#<digits>` at a word start, outside code, to the step it names (see `stepRefs`). */
const stepMarked = new Marked({
  extensions: [
    {
      name: 'stepRef',
      level: 'inline',
      // Not after `&`: that is a numeric entity (`&#39;`), which marked leaves for the browser to read.
      start: (src: string) => /(?<![\w#&])#\d/.exec(src)?.index,
      tokenizer(this: { lexer: { state: { inLink: boolean } } }, src: string) {
        // Inside a link's text a nested <a> would empty the outer link.
        if (this.lexer.state.inLink) return undefined;
        const m = /^#(\d+)(?!\w)/.exec(src);
        if (!m || !knownStep(Number(m[1]))) return undefined;
        return { type: 'stepRef', raw: m[0], id: Number(m[1]) };
      },
      renderer: (token) => `<a href="#step-${token.id}" data-step="${token.id}">#${token.id}</a>`,
    },
  ],
});

/** Markdown to unsanitised HTML, with the `#id` of every step `has` knows as a `data-step` link. */
export function parseWithStepRefs(text: string, has: (id: number) => boolean): string {
  knownStep = has;
  try {
    return stepMarked.parse(text, { async: false }) as string;
  } finally {
    knownStep = () => false;
  }
}
