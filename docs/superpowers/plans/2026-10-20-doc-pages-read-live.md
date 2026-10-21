# #528 Doc pages read live from a repo path

Step #528, phase #525. Spec: `docs/superpowers/specs/2026-10-20-library-and-docs-design.md`, sections "Pages" (lines
59-170) and "#528" (lines 343-357). Handoff r366. Branch `claude/dazzling-cray-17900a`, worktree
`.claude/worktrees/dazzling-cray-17900a`. Labels data and ui.

## Bar (phase 0)

C1 to C8 are the spec's eight #528 criteria, in order. Owner check depth: a list.

- C1 Register a `doc` with purpose `library` or `page`: refused with a typed 400 naming the rule unless the path is
  absolute and local, under one of the project's bindings, `.md/.markdown/.html/.htm`, a regular file of 2 MB or less.
- C2 `GET /api/resources/:id/body` returns `{ format, text, front, sha, fresh }`. Edit the file, reopen the viewer: the
  edit shows.
- C3 Move the file: `404 page-missing`; the viewer says the page is gone and shows its last path.
- C4 Markdown renders through `Markdown`. HTML renders in `<iframe sandbox="allow-scripts">`, no `allow-same-origin`,
  under the CSP. The test page's `fetch` fails and its click handler works.
- C5 The frame grows to the page's height; a non-numeric `postMessage` is ignored.
- C6 Migration 15 adds `confirmed_sha` and `confirmed_at`; `min_reader_version` stays 1; registration sets both.
- C7 The strip shows the commit count to `covers` since `confirmed_sha`; Still accurate resets it to 0. No `covers`, no
  strip.
- C8 A secret-shaped line: `422 page-has-secret` with the line number; the viewer never shows the text.

## Judgment calls (name them in the receipt)

- **Frame route.** An `srcdoc` frame inherits the window's CSP (`default-src 'self'`), which blocks the page's inline
  scripts and Google Fonts. So the HTML goes in through `GET /api/resources/:id/frame`, served with its own header CSP
  (the spec's policy plus `sandbox allow-scripts`, `frame-ancestors 'self'`, `base-uri 'none'`, `form-action 'none'`), the
  spec's meta tag injected after `<head>` (prepending before a doctype would drop the page into quirks mode), and a small
  height reporter script. The iframe keeps `sandbox="allow-scripts"`. The JSON body route still returns the HTML text.
- **A git repository is a sixth registration rule**: `confirmed_sha` needs a HEAD. A path inside a linked worktree is
  refused too (the spec reads pages from the main checkout).
- **Secret prefixes need a body**: a prefix only counts when 16+ key characters follow it (AKIA: exactly 16 upper/digits),
  so a page that names `sk-` as a prefix is not refused.
- Markdown front matter is stripped from `text`; line numbers in the 422 count from the file's first line.
- "How it was confirmed" is derived: `confirmed_at == created_at` reads "at registration", else "confirmed". No column.
- Confirm has two routes on one repo function: `POST /api/resources/:id/confirm` (token, for the scribe and #531) and
  `POST /api/ui/resources/:id/confirm` (the window's guard).

## Server tasks

1. `src/core/types.ts`: `RESOURCE_PURPOSES` gains `library`, `page`; `PAGE_PURPOSES`; `ResourceMeta.confirmedSha`,
   `confirmedAt`; `PageFront { covers; shelf: 'pages'|'roster'; templates }`; `PageBody { format; text; front; sha;
   fresh: { count: number | null; confirmedSha; confirmedAt } | null }`.
2. `src/server/db/schema.ts`: migration 15, two nullable columns, `min_reader_version` 1.
3. `src/server/errors.ts`: `ApiError` takes an optional `extra` object; the handler in `app.ts` spreads it into the body
   (`code`, `line`).
4. `src/server/pages.ts` (new): sync rules (`checkPageRules`: purpose/kind/content, local absolute, extension, binding);
   async `inspectPage` (stat, size, repo top level, not a linked worktree, HEAD); `parseFront` (md YAML subset, HTML meta);
   `scanSecrets`; `readPageBody` (rules again, 404 `page-missing`, 422 `page-has-secret`, freshness with a cache keyed by
   resource, confirmed sha, HEAD and covers); `frameHtml` (CSP meta, height script); `confirmPage`.
   `isLocalAbsolutePath` moves out of `routes/ui.ts` into `src/lib/paths.ts`.
5. `src/server/repo/resources.ts`: META and `toMeta` carry the two columns; `addResource` runs `checkPageRules` and writes
   `confirmed_sha`, `confirmed_at` from the input; `updateResource` re-runs the rules and takes new confirmation when the
   patch makes or re-points a page; `setConfirmation`.
6. Routes: `write.ts` POST/PATCH resources call `inspectPage` first for pages; `read.ts` adds `/body` and `/frame`;
   confirm routes.
7. `src/mcp/server.ts`: the `purpose` describe strings name `library` and `page` (and that pages take no snapshot_file).

## Web tasks

8. `web/src/api.ts`: `pageBody(id)` returning the body or `{ status, code, line, error }`; `confirmPage(id)` via postUi.
9. `web/src/panels/ResourceViewer.tsx`: a page (purpose library/page with a path) fetches the body. Strip under the
   title per the mock r359 (`.fresh`: count or "confirm again" in orange, muted when 0, the confirmed line, covers chips,
   Still accurate hidden at 0). Body: Markdown, or `PageFrame`, or the gone or secret message.
10. `web/src/panels/PageFrame.tsx` (new): label row (path, "sandboxed frame · scripts on · no network · no same-origin"),
    the iframe, height from `message` events whose source is the frame and whose data is a finite number.
11. Styles beside the viewer's own.

## Tests

- Unit `test/server/pages.test.ts`: each registration rule's 400; body read and live edit; moved file 404; secret 422 with
  the line, and prose naming a prefix passes; md and HTML front matter; freshness count, Still accurate to 0, no covers
  means `fresh: null`, rewritten history means `count: null`; the frame route's CSP header and injected meta.
- `test/server/migration15.test.ts`: columns, `min_reader_version` 1.
- e2e (`test/e2e/ui.spec.ts`): one test per feature: a markdown page reads live (C2, C4 md); an HTML page in its sandbox
  (C4, C5); freshness and Still accurate (C7); a moved page and a secret page (C3, C8). A temp git repo bound to the
  seeded project drives them.
