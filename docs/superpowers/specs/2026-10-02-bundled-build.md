# Bundled build: a faster cold start

Date: 2026-10-02. Status: approved by Aiden in chat on 2026-10-02. This note amends the build section of the
InProgress design spec (`2026-09-27-inprogress-design.md`). Tracked in the `inprogress` project as #60.

## Why

A session-start hook that finds the server down starts it and waits up to 5 s (#43). Fresh starts measured 1.8-3.8 s
under load and 4.4 s once, close enough to the window that a reboot-day start could miss its briefing.

Measured on 2026-10-02 (warm cache, a throwaway home, interleaved runs), the server loaded 325 CommonJS files from
node_modules on every start. About 570 ms of a ~900 ms start went to Node resolving, stat-ing and reading them. The
packages' own code ran in ~120 ms. After a reboot each of those files is a cold read and a Defender scan.

## Decision

- **Bundle the pure-JS dependencies** into all four entries (server, MCP, CLI, hooks): `noExternal` in
  `tsup.config.ts`. better-sqlite3 stays external because it loads a native binding from its own folder, so
  `node_modules` must still be present at run time.
- A **banner** gives each ESM bundle `require`, `__filename` and `__dirname`, which bundled CommonJS code expects.
  The only `__dirname` file lookups are pino's worker transports, which InProgress never uses (its logger writes
  through `pino.destination`).
- The server's **port check** tries a plain TCP connection before `fetch` (`portState` in `src/server/startup.ts`). A
  free port is answered without loading undici.
- `server.log` records **`Ready in N ms`** from process start, so the reboot case is measured.

| Server build | Median start | Slowest | CommonJS files loaded |
|---|---|---|---|
| Before | 902 ms | 1893 ms | 325 |
| Bundled | 506 ms | 771 ms | 16 |

The TCP port check removes undici from the start path (0 ms of undici frames in the profile, against 136 ms before
under the profiler); wall-clock timing on a busy machine was too noisy to show it.

## Guard

`test/smoke/bundle.test.ts` reads each built bundle and fails if it loads anything but Node built-ins and
better-sqlite3, so a new dependency can't silently go external again and better-sqlite3 can't be bundled by mistake.
In ESM output esbuild routes every real `require` through its `__require` shim; the test matches that and import
statements, because ajv and fast-json-stringify carry `require("…")` text inside strings for their standalone mode.

## Not done

- **Minify:** 23 ms more, and stack traces stop being readable.
- **Stub Fastify's schema compilers:** about 24 ms once bundled. The earlier 500 → 120 ms figure was mostly module
  loading, which bundling already removed.
- **Skip pino's hostname lookup:** pino calls `os.hostname()` (~26 ms) when its module loads, before any option is
  read, so it can't be avoided without patching pino.
- **V8 compile cache:** `module.enableCompileCache()` needs Node 22.1; the bundle's compile is ~90 ms. One line once
  Node is upgraded.
