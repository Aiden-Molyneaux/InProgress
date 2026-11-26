// A stand-in for the t3 CLI in the exam: `thread list` answers an empty list, `thread show` finds no thread, and `thread
// start` and `thread send` are refused, so no verdict reaches a thread. The exam sets T3CODE_CLI_PATH to t3-standin.cmd
// (Windows) or t3-standin.sh, which run this.
const args = process.argv.slice(2);
if (args[0] === 'thread' && args[1] === 'list') {
  process.stdout.write('[]\n');
} else if (args[0] === 'thread' && args[1] === 'show') {
  process.stderr.write('no such thread (the exam has no T3 Code)\n');
  process.exitCode = 1;
} else {
  process.stderr.write(`refused: the exam sends nothing (${args.slice(0, 2).join(' ')})\n`);
  process.exitCode = 1;
}
