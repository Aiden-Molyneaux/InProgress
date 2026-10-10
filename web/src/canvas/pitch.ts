import { AGENT_LINE, CARD_GAP, CARD_PAD, COMMAND_LINE, DONE_LINE, FOLD_ROW, INDENT, NODE_H, READERS_LINE, ROW, STACK_HEAD, TASK_ROW } from '../../../src/core/layout';

/**
 * Layout's pitch as CSS custom properties, one per exported constant. Canvas writes them once, on `div.ip-canvas`,
 * and the canvas rules in styles.css read them for every fixed height, so a card's DOM can't drift from the heights
 * layout spaces it by. test/web/pitch.test.ts holds the stylesheet to it.
 */
export const PITCH: Record<string, string> = {
  '--node-h': `${NODE_H}px`,
  '--card-gap': `${CARD_GAP}px`,
  '--row': `${ROW}px`,
  '--fold-row': `${FOLD_ROW}px`,
  '--agent-line': `${AGENT_LINE}px`,
  '--readers-line': `${READERS_LINE}px`,
  '--command-line': `${COMMAND_LINE}px`,
  '--done-line': `${DONE_LINE}px`,
  '--task-row': `${TASK_ROW}px`,
  '--card-pad': `${CARD_PAD}px`,
  '--indent': `${INDENT}px`,
  '--stack-head': `${STACK_HEAD}px`,
};
