import { describe, expect, it } from 'vitest';
import { isUnder, normalizePath } from '../../src/lib/paths';

describe('normalizePath', () => {
  it('converts backslashes and strips the trailing slash', () => {
    expect(normalizePath('C:\\personal\\InGame\\')).toBe('C:/personal/InGame');
  });
  it('converts Git Bash drive paths', () => {
    expect(normalizePath('/c/personal/InGame')).toBe('C:/personal/InGame');
    expect(normalizePath('/c')).toBe('C:/');
  });
  it('upper-cases the drive letter and keeps drive roots', () => {
    expect(normalizePath('c:/x/')).toBe('C:/x');
    expect(normalizePath('C:\\')).toBe('C:/');
  });
  it('leaves posix paths alone apart from the trailing slash', () => {
    expect(normalizePath('/home/aiden/')).toBe('/home/aiden');
  });
  it('collapses repeated separators but keeps the leading // of a UNC path', () => {
    expect(normalizePath('C:\\\\personal\\\\InGame')).toBe('C:/personal/InGame');
    expect(normalizePath('C://x//y//')).toBe('C:/x/y');
    expect(normalizePath('C:\\\\')).toBe('C:/');
    expect(normalizePath('/c//personal')).toBe('C:/personal');
    expect(normalizePath('\\\\server\\share\\\\repo')).toBe('//server/share/repo');
    expect(normalizePath('///server//share')).toBe('//server/share');
  });
});

describe('isUnder', () => {
  it('matches the folder itself and anything below it, case-insensitively', () => {
    expect(isUnder('C:/personal/InGame', 'C:/personal/InGame')).toBe(true);
    expect(isUnder('C:\\personal\\InGame\\docs', 'c:/personal/ingame')).toBe(true);
  });
  it('does not match sibling folders sharing a prefix', () => {
    expect(isUnder('C:/personal/InGameX', 'C:/personal/InGame')).toBe(false);
  });
  it('matches a cwd written with doubled separators', () => {
    expect(isUnder('C:\\\\personal\\\\InGame\\\\docs', 'C:/personal/InGame')).toBe(true);
    expect(isUnder('C:/personal/InGame/docs', 'C://personal//InGame')).toBe(true);
  });
});
