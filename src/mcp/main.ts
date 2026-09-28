import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureServer } from '../lib/ensure-server';
import { baseUrl, homeDir } from '../lib/home';
import { appendLog } from '../lib/log';
import { createFreshClient } from './client';
import { createMcpServer } from './server';

async function main(): Promise<void> {
  const url = baseUrl();
  // stdout belongs to the MCP protocol: never print here.
  await ensureServer({ baseUrl: url, waitMs: 3000 }).catch((err) => appendLog(join(homeDir(), 'hooks.log'), `mcp ensureServer: ${String(err)}`));
  const server = createMcpServer(createFreshClient(url));
  await server.connect(new StdioServerTransport());
}

void main();
