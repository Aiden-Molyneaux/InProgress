#!/usr/bin/env node
import { ApiClientError } from '../lib/client';
import { runCli } from './commands';

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    // The hint says what to do next, e.g. `inprogress start` when the server is unreachable.
    if (err instanceof ApiClientError && typeof err.hint === 'string') console.error(err.hint);
    process.exit(1);
  },
);
