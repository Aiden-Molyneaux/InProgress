// usage: node guard-cli.mjs [--live <dir>] <path>...  Exits 2, naming the path, when one lies under the live InProgress home
// (~/.inprogress, or --live for a test); 0 otherwise. Makes nothing. run.sh calls it before anything is written.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { refuseLiveHome } from './guard.mjs';

const args = process.argv.slice(2);
let live = join(homedir(), '.inprogress');
if (args[0] === '--live') {
  live = args[1] ?? '';
  args.splice(0, 2);
}
if (live === '' || args.length === 0) {
  console.error('usage: guard-cli.mjs [--live <dir>] <path>...');
  process.exit(2);
}
try {
  refuseLiveHome(args, live);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
