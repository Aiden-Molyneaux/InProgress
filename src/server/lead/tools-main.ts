import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '../../lib/client';
import { baseUrl } from '../../lib/home';
import { checkLeadToolsStart, createLeadToolsServer } from './tools';

/**
 * `node dist/lead/tools.js <slug>`: the lead's read-only tools over stdio. The runner starts it with the server's own
 * home and port in the environment; it refuses to start without them and never starts a server (a tool that finds none
 * answers so). stdout belongs to the protocol: only stderr is written to.
 */
async function main(): Promise<void> {
  const start = checkLeadToolsStart(process.env, process.argv.slice(2));
  if (!start.ok) {
    process.stderr.write(`${start.error}\n`);
    process.exitCode = 2;
    return;
  }
  const client = createClient({ baseUrl: baseUrl(start.port) });
  const server = createLeadToolsServer({ slug: start.slug, client, repo: start.repo, as: start.as, instructions: start.instructions });
  await server.connect(new StdioServerTransport());
}

void main();
