import { describe, expect, it } from 'vitest';
import {
  HOLD_RULES,
  commandSegments,
  familyRe,
  folderInside,
  gitFolderOption,
  heldAction,
  heldActions,
  heldLineWatched,
  holdFamilies,
  isUpstreamOfMain,
  mergeTarget,
  mergeTargets,
  playbookHeldLines,
  pushTarget,
  splitCommand,
  type HoldTool,
} from '../../src/core/hold';

const action = (command: string, extra: string[] = []) => heldAction(command, extra)?.action;

describe('the if rules start the hook for every form the list holds', () => {
  /**
   * A model of the installed `if` rules: Claude Code tests each command of a compound one against `<Tool>(<pattern>)`, with
   * `*` any text. Every example of every rule must start a hook in its shell, and be held by that rule once it does.
   */
  const starts = (tool: HoldTool, command: string) => splitCommand(command).some((seg) => holdFamilies(tool).some((f) => familyRe(f).test(seg.raw)));
  for (const rule of HOLD_RULES) {
    for (const tool of ['Bash', 'PowerShell'] as const) {
      it.each(rule.examples[tool].map((e) => [e]))(`${tool}: %s starts the hook and is held as ${rule.action}`, (example) => {
        expect(starts(tool, example)).toBe(true);
        expect(heldAction(example)?.action).toBe(rule.action);
      });
    }
  }

  it('the families include the forms the review found missing', () => {
    expect(holdFamilies('Bash')).toEqual(expect.arrayContaining(['git -C *', 'git -c *', 'git --*', 'pnpm publish*', 'yarn publish*', 'cargo publish*', 'twine upload*', 'npm run release*', 'pnpm run deploy*', 'yarn deploy*', 'node *deploy*', 'rm *']));
    expect(holdFamilies('PowerShell')).toEqual(expect.arrayContaining(['rm *', 'del *', 'ri *', 'rmdir *', 'rd *', 'Remove-Item *']));
  });
});

describe('heldAction: P3 (spikes/lead-stage0/p3/hold-hook.cjs) and the rest of the list', () => {
  it.each(['npm test', 'npm run build', 'git status', 'git log --oneline', 'git merge-base main HEAD', 'git pushx', 'gh pr view 12', 'gh release list', 'rm -rf dist', 'node scripts/build-to.mjs .build', 'npm run dev'])(
    'an ordinary command is not held: %s',
    (command) => {
      expect(heldAction(command)).toBeUndefined();
    },
  );

  it('a merge is named merge for the server to decide whether it goes into main', () => {
    expect(heldAction('git merge feature', [], 'C:/repo')).toEqual({ action: 'merge', index: 0, segment: 'git merge feature', folder: 'C:/repo', what: 'a merge into main' });
  });

  it('gh pr merge is held as a merge of a pull request', () => {
    expect(action('gh pr merge 12 --squash')).toBe('pr-merge');
  });

  it('says what it does without the server, for the refusal when InProgress is not answering', () => {
    expect(heldAction('git push origin x')?.what).toBe('a push to a remote');
    expect(heldAction('npm publish')?.what).toBe('a publish of a package for anyone to install');
    expect(heldAction('rm -rf ~/.inprogress')?.what).toBe('a delete under the live home');
  });
});

describe('heldAction: compound commands, quotes and heredocs', () => {
  it('finds a held command anywhere in a compound one, with its place in the line', () => {
    expect(action('npm test && git push')).toBe('push');
    expect(action('git status; npm publish')).toBe('publish');
    expect(action('npm run build || npm run deploy')).toBe('deploy');
    expect(action('cat x | gh repo create a/b')).toBe('repo');
    expect(heldAction('git add -A && git commit -m x && git push origin feature')).toMatchObject({ index: 2, segment: 'git push origin feature' });
  });

  it('lists every held command of a compound one, in order, each with its place', () => {
    expect(heldActions('git merge feature && git push && npm test && git push origin other').map((m) => [m.action, m.index])).toEqual([
      ['merge', 0],
      ['push', 1],
      ['push', 3],
    ]);
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

  it('text inside a quoted string is not a command', () => {
    expect(action('echo "git push"')).toBeUndefined();
    expect(action('git commit -m "ready: npm run deploy after this; git push"')).toBeUndefined();
    expect(action("echo 'npm publish'")).toBeUndefined();
  });

  it('a heredoc body inside a quoted $(...) is not a command, and the gh command itself is read on its own words', () => {
    const command = `gh pr create --title "x" --body "$(cat <<'EOF'
Land it with git push, then npm run deploy.
(Merge with git merge main.)
EOF
)"`;
    expect(heldActions(command)).toEqual([]);
    expect(heldActions(`cat <<EOF > notes.md\ngit push\nEOF\nnpm test`)).toEqual([]);
    expect(action(`cat <<EOF > notes.md\ngit push\nEOF\ngit push`)).toBe('push');
  });

  it('a command that does not close is read as plain text, so nothing in it escapes the list', () => {
    expect(action('echo "unclosed && git push')).toBe('push');
    expect(action("cat <<EOF\nno end && git push")).toBe('push');
  });

  it('a bare $(...) or backticks run their command', () => {
    expect(action('echo $(git push)')).toBe('push');
    expect(action('echo `npm publish`')).toBe('publish');
  });

  it('splits on &&, ||, ;, |, & and line breaks', () => {
    expect(commandSegments('a && b || c; d | e\nf & g')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });
});

describe('the folder each command runs in', () => {
  const folders = (command: string, cwd = 'C:/wt') => heldActions(command, [], cwd).map((m) => m.folder);

  it('follows cd, Set-Location, sl, pushd and git -C, resolved against the session folder', () => {
    expect(folders('cd C:/personal/InProgress && git merge --ff-only topic')).toEqual(['C:/personal/InProgress']);
    expect(folders('cd ../main; git push')).toEqual(['C:/main']);
    expect(folders('Set-Location -Path C:\\repo; git push')).toEqual(['C:/repo']);
    expect(folders('sl C:/a; pushd b && git push')).toEqual(['C:/a/b']);
    expect(folders('git -C ../main merge x')).toEqual(['C:/main']);
    expect(folders('cd /c/personal/x && git push')).toEqual(['C:/personal/x']);
    expect(folders('git push')).toEqual(['C:/wt']);
  });

  it('a folder change it cannot read leaves the folder unknown', () => {
    expect(folders('cd $REPO && git push')).toEqual([null]);
    expect(folders('cd - && git push')).toEqual([null]);
    expect(folders('cd && git push')).toEqual([null]);
    expect(folders('pushd C:/a; popd; git push')).toEqual([null]);
    expect(folders('cd ~/x && git push')).toEqual([null]);
  });

  it('a folder is inside a root, case and slashes ignored', () => {
    expect(folderInside('C:\\Personal\\InProgress\\.claude\\worktrees\\x', 'c:/personal/InProgress')).toBe(true);
    expect(folderInside('C:/personal/InProgressX', 'C:/personal/InProgress')).toBe(false);
  });
});

describe('Held lines', () => {
  it("reads the playbook's Held lines", () => {
    expect(playbookHeldLines('Risk: billing/**\nHeld: gh pr merge\n  Held:   npm run seed-prod  \nHeld:\nnot Held: x')).toEqual(['gh pr merge', 'npm run seed-prod']);
  });

  it('holds a command that starts with a Held line, case ignored', () => {
    expect(heldAction('npm run seed-prod --force', ['npm run seed-prod'])).toMatchObject({ action: 'playbook', segment: 'npm run seed-prod --force', what: 'a command the playbook holds for Aiden (npm run seed-prod)' });
    expect(action('NPM RUN SEED-PROD', ['npm run seed-prod'])).toBe('playbook');
    expect(action('npm test && npm run seed-prod', ['npm run seed-prod'])).toBe('playbook');
    expect(action('npm run seed-dev', ['npm run seed-prod'])).toBeUndefined();
  });

  it('a Held line comes before the list: a match is always held, without a check', () => {
    expect(action('git push --force', ['git push --force'])).toBe('playbook');
    expect(action('git push', ['git push --force'])).toBe('push');
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
  it('names what a merge merges, past its options', () => {
    expect(mergeTarget('git merge feature')).toBe('feature');
    expect(mergeTarget('git merge --no-ff -m "land it" feature')).toBe('feature');
    expect(mergeTarget('git -C ../main merge -s ort --no-edit lead-x')).toBe('lead-x');
    expect(mergeTarget('git merge')).toBeUndefined();
    expect(mergeTarget('git merge --abort')).toBeUndefined();
    expect(mergeTargets('git merge a b')).toEqual(['a', 'b']);
    expect(mergeTarget('git merge a b')).toBeUndefined();
  });

  it("knows main's upstream", () => {
    expect(['origin/main', '@{u}', '@{upstream}'].map(isUpstreamOfMain)).toEqual([true, true, true]);
    expect(['origin/feature', 'main', 'feature'].map(isUpstreamOfMain)).toEqual([false, false, false]);
  });

  it('reads what a push sends, and refuses what it cannot read as one branch', () => {
    expect(pushTarget('git push')).toEqual({ ok: true, remote: 'origin' });
    expect(pushTarget('git push -u origin feature')).toEqual({ ok: true, remote: 'origin', branch: 'feature' });
    expect(pushTarget('git push origin HEAD')).toEqual({ ok: true, remote: 'origin' });
    expect(pushTarget('git push origin +refs/heads/x:refs/heads/x')).toEqual({ ok: true, remote: 'origin', branch: 'x' });
    expect(pushTarget('git push upstream x')).toEqual({ ok: true, remote: 'upstream', branch: 'x' });
    expect(pushTarget('git push --repo https://example.com/x.git')).toEqual({ ok: true, remote: 'https://example.com/x.git' });
    expect(pushTarget('git push --repo=other feature')).toEqual({ ok: true, remote: 'other', branch: 'feature' });
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

describe('a redirection is not an argument', () => {
  it.each(['git merge feat 2>&1', 'git merge feat >/dev/null', 'git merge feat > out.txt', 'git merge feat &>log', 'git merge feat 2>$null', 'git merge feat *> all.log'])('%s merges the one branch', (command) => {
    expect(splitCommand(command)).toHaveLength(1);
    expect(mergeTargets(command)).toEqual(['feat']);
    expect(mergeTarget(command)).toBe('feat');
    expect(heldAction(command)?.action).toBe('merge');
  });

  it('a push keeps its one remote and branch', () => {
    expect(pushTarget('git push origin feat 2>&1')).toEqual({ ok: true, remote: 'origin', branch: 'feat' });
    expect(pushTarget('git push 2>&1')).toEqual({ ok: true, remote: 'origin' });
    expect(pushTarget('git push > out.txt')).toEqual({ ok: true, remote: 'origin' });
    expect(pushTarget('git push &>log')).toEqual({ ok: true, remote: 'origin' });
    expect(pushTarget('git push origin feat 2>&1 >out.log')).toEqual({ ok: true, remote: 'origin', branch: 'feat' });
    expect(pushTarget('git push origin feat < in.txt')).toEqual({ ok: true, remote: 'origin', branch: 'feat' });
  });

  it('a & beside a redirection does not cut the command, a lone & still does', () => {
    expect(commandSegments('git push 2>&1 && git status')).toEqual(['git push 2>&1', 'git status']);
    expect(commandSegments('git push >&2; echo x')).toEqual(['git push >&2', 'echo x']);
    expect(commandSegments('sleep 1 & git push')).toEqual(['sleep 1', 'git push']);
  });

  it('a git -C folder is still read behind a redirection, and a quoted > stays a word', () => {
    expect(gitFolderOption('git -C ../x push 2>&1')).toBe('../x');
    expect(mergeTargets('git merge -m ">" feat')).toEqual(['feat']);
    expect(mergeTargets('git merge ">x"')).toEqual(['>x']);
  });
});

describe('the deploy rule holds the script and its variants (over-holding is the safe side)', () => {
  it.each(['npm run deploy', 'npm run release', 'npm run deploy && echo', 'pnpm run deploy;ls', 'yarn deploy | tee x', 'yarn run release', 'npm run deploy:prod', 'npm run deploy-prod', 'npm run deploy.sh', 'npm run deploy-check', 'npm run release:notes', 'yarn run release:notes'])('holds %s', (c) => {
    expect(action(c)).toBe('deploy');
  });
  it.each(['npm run deployer', 'npm run releases', 'npm run rollbacks', 'npm run deploymentnotes'])('does not hold %s, a longer word', (c) => {
    expect(action(c)).toBeUndefined();
  });
});
