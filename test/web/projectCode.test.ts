import { describe, expect, it } from 'vitest';
import { projectCode } from '../../web/src/page/projectCode';
import { scrambled } from '../../web/src/page/scrambled';

describe('projectCode', () => {
  it('takes each word\'s first letter, then the next consonants', () => {
    expect(projectCode('InProgress')).toBe('IPR');
    expect(projectCode('InThink')).toBe('ITH');
    expect(projectCode('my-api')).toBe('MAP');
    expect(projectCode('Shipwright')).toBe('SHP');
  });

  it('splits on underscores and takes no more than three words', () => {
    expect(projectCode('road_to_market_now')).toBe('RTM');
  });

  it('fills from the other letters, then pads, when the name is short', () => {
    expect(projectCode('Go')).toBe('GOX');
    expect(projectCode('Aoi')).toBe('AOI');
  });

  it('puts the count of clashing earlier projects, plus one, in the third place', () => {
    expect(projectCode('InProgress', ['Other'])).toBe('IPR');
    expect(projectCode('InProgress', ['InProgress'])).toBe('IP2');
    expect(projectCode('InProgress', ['InProgress', 'In-Progress', 'Other'])).toBe('IP3');
  });

  it('keeps three characters past nine clashes', () => {
    expect(projectCode('InProgress', Array(9).fill('InProgress'))).toBe('I10');
    expect(projectCode('InProgress', Array(99).fill('InProgress'))).toBe('100');
  });
});

describe('scrambled', () => {
  const random = () => 0;
  it('keeps the settled letters and spaces and scrambles the rest', () => {
    expect(scrambled('Road to', 0, random)).toBe('AAAA AA');
    expect(scrambled('Road to', 3, random)).toBe('RoaA AA');
    expect(scrambled('Road to', 7, random)).toBe('Road to');
  });
});
