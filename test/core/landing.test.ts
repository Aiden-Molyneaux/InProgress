import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_GLOBS, filesOnRiskList, landingVerdict, riskGlobsOf, type LandingInput } from '../../src/core/landing';

const base: LandingInput = { action: 'merge', files: ['web/app.ts'], patchId: 'p1', riskGlobs: DEFAULT_RISK_GLOBS, publicRemote: false, landingOn: true, stepId: 1, yeses: [] };
const CLEAR = 'Clear to land';
const yes = (action: string, patchId = 'p1', stepId = 1) => ({ action, patchId, stepId });

/** P3's cases (spikes/lead-stage0/p3/test.mjs), named by their letters. The tweak lane waits for stage 2, so b and c are the same here. */
const cases: { name: string; input: Partial<LandingInput>; text: string }[] = [
  { name: 'a 20 lines in web', input: { files: ['web/app.ts'] }, text: CLEAR },
  { name: 'b 60 lines in web (no tweak lane: every change is standard)', input: { files: ['web/big.ts'] }, text: CLEAR },
  { name: 'd0 web only, his yes covers it', input: { files: ['web/app.ts'], yeses: [yes('merge')] }, text: CLEAR },
  {
    name: 'd schema grew after his yes',
    input: { files: ['web/app.ts', 'src/server/db/schema.ts'], patchId: 'p2', yeses: [yes('merge')] },
    text: "hold: this is Aiden's (changed since his yes)",
  },
  { name: 'e schema change, his yes for this patch', input: { files: ['src/server/db/schema.ts'], yeses: [yes('merge')] }, text: CLEAR },
  { name: 'f deploy script, no yes', input: { files: ['scripts/deploy.mjs'] }, text: "hold: this is Aiden's (it touches scripts/deploy.mjs)" },
  { name: 'g clean change, publish, no yes', input: { action: 'publish' }, text: "hold: this is Aiden's (a publish goes out in his name)" },
  { name: 'h clean change, publish, his yes was for a merge', input: { action: 'publish', yeses: [yes('merge')] }, text: "hold: this is Aiden's (a publish goes out in his name)" },
  { name: 'i clean change, publish, his yes was for this publish', input: { action: 'publish', yeses: [yes('publish')] }, text: CLEAR },
  { name: 'j clean change, push-public, no yes', input: { action: 'push-public' }, text: "hold: this is Aiden's (a push-public goes out in his name)" },
  { name: 'k clean change, deploy, no yes', input: { action: 'deploy' }, text: CLEAR },
];

describe('landingVerdict: P3 cases', () => {
  it.each(cases)('$name', ({ input, text }) => {
    const v = landingVerdict({ ...base, ...input });
    expect(v.text).toBe(text);
    expect(v.clear).toBe(text === CLEAR);
  });
});

describe('landingVerdict: the rules', () => {
  it("a yes for merge does not clear a deploy that is Aiden's", () => {
    const v = landingVerdict({ ...base, action: 'deploy', landingOn: false, yeses: [yes('merge')] });
    expect(v).toMatchObject({ clear: false, text: "hold: this is Aiden's (Landing is off)" });
  });
  it('a yes for the same action and patch id clears while Landing is off', () => {
    expect(landingVerdict({ ...base, landingOn: false, yeses: [yes('merge')] }).clear).toBe(true);
  });
  it('Landing off holds an ordinary change', () => {
    expect(landingVerdict({ ...base, landingOn: false }).text).toBe("hold: this is Aiden's (Landing is off)");
  });
  it('changed since his yes is said only when his yes was for this action on this step; otherwise the real reason', () => {
    const risky = { ...base, files: ['src/hooks/x.ts'], patchId: 'p2' };
    expect(landingVerdict({ ...risky, yeses: [yes('merge', 'p1', 1)] }).text).toBe("hold: this is Aiden's (changed since his yes)");
    expect(landingVerdict({ ...risky, yeses: [yes('merge', 'p1', 2)] }).text).toBe("hold: this is Aiden's (it touches src/hooks/x.ts)");
    expect(landingVerdict({ ...risky, yeses: [yes('deploy', 'p1', 1)] }).text).toBe("hold: this is Aiden's (it touches src/hooks/x.ts)");
  });
  it('a push to a public remote is a push-public: a yes for push does not clear it, one for push-public does', () => {
    const pub = { ...base, action: 'push' as const, publicRemote: true };
    expect(landingVerdict({ ...pub, yeses: [yes('push')] }).clear).toBe(false);
    expect(landingVerdict({ ...pub, yeses: [yes('push-public')] }).clear).toBe(true);
  });
  it('a push to a private remote is an ordinary change', () => {
    expect(landingVerdict({ ...base, action: 'push', publicRemote: false }).text).toBe(CLEAR);
  });
  it('a push to a remote that could not be read is held, and says so', () => {
    const v = landingVerdict({ ...base, action: 'push', publicRemote: null, remote: 'https://github.com/acme/w.git' });
    expect(v).toMatchObject({ clear: false, text: "hold: this is Aiden's (could not tell whether https://github.com/acme/w.git is public)" });
  });
  it('a reason found around the change (holdBecause) holds it', () => {
    expect(landingVerdict({ ...base, action: 'deploy', holdBecause: 'the live build is not behind main' }).text).toBe("hold: this is Aiden's (the live build is not behind main)");
  });
  it('the reason names the first two matching files', () => {
    const v = landingVerdict({ ...base, files: ['web/a.ts', 'src/hooks/a.ts', 'claude/b.md', 'src/hooks/c.ts'] });
    expect(v.text).toBe("hold: this is Aiden's (it touches src/hooks/a.ts, claude/b.md)");
  });
  it('a null patch id is never covered by a yes', () => {
    expect(landingVerdict({ ...base, files: ['claude/x.md'], patchId: null, yeses: [yes('merge')] }).clear).toBe(false);
  });
  it('a renamed risk file lists both paths, and the old one holds it', () => {
    expect(landingVerdict({ ...base, files: ['src/hooks/a.ts', 'web/a.ts'] }).clear).toBe(false);
  });
});

describe('risk globs', () => {
  const hit = (glob: string, file: string) => filesOnRiskList([file], [glob]).length === 1;
  it.each([
    ['src/server/db/**', 'src/server/db/deep/x.ts', true],
    ['scripts/deploy*.mjs', 'scripts/deploy-lib.mjs', true],
    ['scripts/deploy*.mjs', 'scripts/sub/deploy.mjs', false],
    ['src/server/db/**', 'src/server/dbx/a.ts', false],
    ['app(1)/**', 'app(1)/x.ts', true],
    ['app(1)/**', 'app1/x.ts', false],
    ['lib[0]/*.ts', 'lib[0]/a.ts', true],
    ['lib[0]/*.ts', 'lib0/a.ts', false],
    ['c++/**', 'c++/a.cpp', true],
    ['c++/**', 'ccc/a.cpp', false],
    ['a?b', 'a?b', true],
    ['a?b', 'axb', false],
    ['src/[x/**', 'src/[x/y.ts', true],
    ['src/(x/**', 'src/(x/y.ts', true],
    ['{a,b}/**', '{a,b}/y.ts', true],
    ['a.b', 'axb', false],
  ] as const)('%s on %s is %s, and never throws', (glob, file, expected) => {
    expect(hit(glob, file)).toBe(expected);
  });
  it('the match ignores case, as NTFS does', () => {
    expect(landingVerdict({ ...base, files: ['Src/Hooks/x.ts'] }).clear).toBe(false);
    expect(landingVerdict({ ...base, files: ['CLAUDE/skills/a.md'] }).clear).toBe(false);
  });
});

describe('riskGlobsOf', () => {
  it('is the P3 list when the playbook has no Risk lines', () => {
    expect(riskGlobsOf('Ship small.\nTest first.')).toEqual([...DEFAULT_RISK_GLOBS]);
  });
  it('a playbook with Risk lines adds to the defaults and never replaces them', () => {
    const globs = riskGlobsOf('Ship small.\nRisk: billing/**\n  Risk: infra/*.tf\r\nRisk:\n');
    expect(globs).toEqual([...DEFAULT_RISK_GLOBS, 'billing/**', 'infra/*.tf']);
    expect(landingVerdict({ ...base, riskGlobs: globs, files: ['src/hooks/x.ts'] }).clear).toBe(false);
    expect(landingVerdict({ ...base, riskGlobs: globs, files: ['billing/a/b.ts'] }).text).toBe("hold: this is Aiden's (it touches billing/a/b.ts)");
    expect(landingVerdict({ ...base, riskGlobs: globs, files: ['web/a.ts'] }).clear).toBe(true);
  });
});
