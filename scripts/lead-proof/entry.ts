// The hook proof's bundle entry: what hooks.mjs reads from the build, bundled by build-entry.mjs into <build>/dist/proof/core.js
// so the settings, the held families and the held-or-not answer are the build's own, never this checkout's. Not part of the app.
export { addInProgressHooks, HOOK_DEFS } from '../../src/cli/claude-config';
export { familyRe, heldActions, holdFamilies, splitCommand } from '../../src/core/hold';
