import { describe, expect, it } from 'vitest';
import { commandSegments, gitFolderOption, heldAction, heldActions, heldLineWatched, mergeTarget, playbookHeldLines, pushTarget } from '../../src/core/hold';

const action = (command: string, extra: string[] = []) => heldAction(command, extra)?.action;

describe('heldAction: P3 (spikes/lead-stage0/p3/hold-hook.cjs)', () => {
  // Each rule of the stage 0 hook, with the commands it held there.
  it.each([
    ['npm publish', 'publish'],
    ['pnpm publish --access public', 'publish'],
    ['yarn publish', 'publish'],
    ['cargo publish', 'publish'],
    ['twine upload dist/*', 'publish'],
    ['git push', 'push'],
    ['git push origin feature', 'push'],
    ['git push --force-with-lease', 'push'],
    ['git -C C:/repo push', 'push'],
    ['npm run deploy', 'deploy'],
    ['pnpm run release', 'deploy'],
    ['node scripts/deploy.mjs', 'deploy'],
    ['node scripts\\deploy-web.mjs', 'deploy'],
    ['gh repo create acme/widgets --public', 'repo'],
    ['gh repo delete acme/widgets --yes', 'repo'],
    ['gh repo edit --visibility public', 'repo'],
    ['gh release create v1.0.0', 'repo'],
    ['rm -rf ~/.inprogress', 'delete'],
    ['rm ~/.inprogress/inprogress.db', 'delete'],
  ])('%s is held as %s', (command, expected) => {
    expect(action(command)).toBe(expected);
  });

  it.each(['npm test', 'npm run build', 'git status', 'git log --oneline', 'git merge-base main HEAD', 'git pushx', 'gh pr view 12', 'gh release list', 'rm -rf dist', 'node scripts/build-to.mjs .build', 'npm run dev'])(
    'an ordinary command is not held: %s',
    (command) => {
      expect(heldAction(command)).toBeUndefined();
    },
  );

  it('a merge is named merge for the server to decide whether it goes into main', () => {
    expect(heldAction('git merge feature')).toEqual({ action: 'merge', segment: 'git merge feature', what: 'a merge into main' });
    expect(action('git merge --no-ff -m "land it" feature')).toBe('merge');
  });

  it('says what it does without the server, for the refusal when InProgress is not answering', () => {
    expect(heldAction('git push origin x')?.what).toBe('a push to a remote');
    expect(heldAction('npm publish')?.what).toBe('a publish of a package for anyone to install');
    expect(heldAction('rm -rf ~/.inprogress')?.what).toBe('a delete under the live home');
  });
});

describe('heldAction: compound commands and PowerShell', () => {
  it('finds a held command anywhere in a compound one', () => {
    expect(action('npm test && git push')).toBe('push');
    expect(action('git status; npm publish')).toBe('publish');
    expect(action('npm run build || npm run deploy')).toBe('deploy');
    expect(action('cat x | gh repo create a/b')).toBe('repo');
    expect(heldAction('git add -A && git commit -m x && git push origin feature')?.segment).toBe('git push origin feature');
  });

  it('lists every held command of a compound one, in order', () => {
    expect(heldActions('git merge feature && git push && npm test').map((m) => m.action)).toEqual(['merge', 'push']);
  });

  it('holds the PowerShell forms', () => {
    expect(action('git push origin main; Write-Host done')).toBe('push');
    expect(action('Remove-Item -Recurse -Force $HOME\\.inprogress\\resources')).toBe('delete');
    expect(action('remove-item C:\\Users\\a\\.inprogress\\token')).toBe('delete');
    expect(action('Set-Location C:\\repo; npm run deploy')).toBe('deploy');
  });

  it('a delete is held only when it names .inprogress, in the same command', () => {
    expect(action('rm -rf C:/Users/a/.inprogress')).toBe('delete');
    expect(action('rm -rf node_modules')).toBeUndefined();
    expect(action('Remove-Item -Recurse dist')).toBeUndefined();
    expect(action('rm -rf dist && ls ~/.inprogress')).toBeUndefined();
  });

  it('git push-ish text inside an echo string is still matched: the hook does not parse quotes', () => {
    expect(action('echo "git push"')).toBe('push');
    expect(action("echo 'npm publish'")).toBe('publish');
  });
});

describe('Held lines', () => {
  it('reads the playbook\'s Held lines', () => {
    expect(playbookHeldLines('Risk: billing/**\nHeld: gh pr merge\n  Held:   npm run seed-prod  \nHeld:\nnot Held: x')).toEqual(['gh pr merge', 'npm run seed-prod']);
  });

  it('holds a command that starts with a Held line, case ignored', () => {
    expect(heldAction('gh pr merge 12 --squash', ['gh pr merge'])).toMatchObject({ action: 'playbook', segment: 'gh pr merge 12 --squash', what: 'a command the playbook holds for Aiden (gh pr merge)' });
    expect(action('GH PR MERGE 12', ['gh pr merge'])).toBe('playbook');
    expect(action('npm test && gh pr merge 3', ['gh pr merge'])).toBe('playbook');
    expect(action('gh pr view 12', ['gh pr merge'])).toBeUndefined();
    expect(action('echo gh pr merge', ['gh pr merge'])).toBeUndefined();
  });

  it("P3's list comes before a Held line", () => {
    expect(action('git push', ['git push'])).toBe('push');
  });

  it('a Held line inside a watched family is watched; one outside is not', () => {
    expect(heldLineWatched('gh pr merge')).toBe(true);
    expect(heldLineWatched('git push --tags')).toBe(true);
    expect(heldLineWatched('Remove-Item C:/data')).toBe(true);
    expect(heldLineWatched('npm run seed-prod')).toBe(false);
    expect(heldLineWatched('curl -X DELETE https://x')).toBe(false);
  });
});

describe('reading a merge and a push', () => {
  it('splits a compound command on &&, ||, ; and |', () => {
    expect(commandSegments('a && b || c; d | e\nf')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('names the branch a merge merges, past its options', () => {
    expect(mergeTarget('git merge feature')).toBe('feature');
    expect(mergeTarget('git merge --no-ff -m "land it" feature')).toBe('feature');
    expect(mergeTarget('git -C ../main merge -s ort --no-edit lead-x')).toBe('lead-x');
    expect(mergeTarget('git merge')).toBeUndefined();
    expect(mergeTarget('git merge --abort')).toBeUndefined();
  });

  it('reads what a push sends, and refuses what it cannot read as one branch', () => {
    expect(pushTarget('git push')).toEqual({ ok: true, remote: 'origin' });
    expect(pushTarget('git push -u origin feature')).toEqual({ ok: true, remote: 'origin', branch: 'feature' });
    expect(pushTarget('git push origin HEAD')).toEqual({ ok: true, remote: 'origin' });
    expect(pushTarget('git push origin +refs/heads/x:refs/heads/x')).toEqual({ ok: true, remote: 'origin', branch: 'x' });
    expect(pushTarget('git push upstream x')).toEqual({ ok: true, remote: 'upstream', branch: 'x' });
    expect(pushTarget('git push origin x:main')).toMatchObject({ ok: false });
    expect(pushTarget('git push origin :x')).toMatchObject({ ok: false });
    expect(pushTarget('git push origin a b')).toMatchObject({ ok: false });
    expect(pushTarget('git push --all')).toMatchObject({ ok: false });
    expect(pushTarget('git push --tags origin')).toMatchObject({ ok: false });
  });

  it('reads the folder git -C names', () => {
    expect(gitFolderOption('git -C ../main merge x')).toBe('../main');
    expect(gitFolderOption('git -c a=b -C "C:/a b" push')).toBe('C:/a b');
    expect(gitFolderOption('git push')).toBeUndefined();
  });
});
