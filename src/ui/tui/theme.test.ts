import { describe, expect, it } from 'vitest';
import {
  AGENT_COLOUR,
  agentColour,
  BRAND,
  columns,
  MASCOT,
  MASCOT_BLINK,
  MASCOT_STAGE,
  SAYINGS,
  shimmer,
  stage,
} from './theme.js';

describe('the welcome mark', () => {
  // The header is a fixed number of rows of a fixed width — that is what a
  // click's row is measured against — so a blink may only swap glyphs.
  it('keeps its shape while it blinks', () => {
    expect(MASCOT_BLINK).toHaveLength(MASCOT.length);
    expect(MASCOT_BLINK.map((line) => [...line].length)).toEqual(
      MASCOT.map((line) => [...line].length),
    );
  });
});

describe('the mark on its stage', () => {
  const span = [...MASCOT[0]].length;

  it('sits in place at home', () => {
    expect(stage(MASCOT, 0)).toEqual([...MASCOT]);
  });

  // What crosses the edge is gone, not wrapped: the columns that remain are
  // the tail of the row, in order.
  it('clips at the left edge and nothing else', () => {
    const walked = stage(MASCOT, -3);
    for (const [index, line] of walked.entries()) {
      expect(line).toBe([...MASCOT[index]!].slice(3).join(''));
    }
  });

  it('is clean out of sight a full span off', () => {
    for (const line of stage(MASCOT, -span)) expect(line.trim()).toBe('');
  });

  it('steps right without losing a cell', () => {
    const walked = stage(MASCOT, 4);
    for (const [index, line] of walked.entries()) expect(line).toBe('    ' + MASCOT[index]);
  });

  // The word rides the middle row; the megaphone is the column between mark
  // and word, a slash above and below opening toward the word.
  it('throws a saying to the right behind a megaphone flare', () => {
    const spoken = stage(MASCOT, 0, '말만해', 'right');
    expect(spoken[0]).toBe(`${MASCOT[0]}/`);
    expect(spoken[1]).toBe(`${MASCOT[1]} 말만해`);
    expect(spoken[2]).toBe(`${MASCOT[2]}\\`);
  });

  it('throws a saying to the left behind a mirrored flare', () => {
    const spoken = stage(MASCOT, 7, '허리업', 'left');
    expect(spoken[0]).toBe(`${' '.repeat(6)}\\${MASCOT[0]}`);
    expect(spoken[1]).toBe(`허리업 ${MASCOT[1]}`);
    expect(spoken[2]).toBe(`${' '.repeat(6)}/${MASCOT[2]}`);
  });

  // The stage is sized off the sayings themselves — hangul at two columns a
  // glyph — with room for the widest one on each side of the mark, so a word
  // goes out wherever the mark stands without it shuffling to make space.
  it('gives every saying room on both sides of the mark', () => {
    expect(columns('Hi')).toBe(2);
    expect(columns('허리업')).toBe(6);
    for (const saying of SAYINGS) {
      expect(span + 2 * (1 + columns(saying))).toBeLessThanOrEqual(MASCOT_STAGE);
    }
  });
});

describe('an agent colour', () => {
  // Ids come from the config, so a profile named for its adapter has to land
  // on the same colour as the plain name.
  it('follows the maker, however the config named the agent', () => {
    expect(agentColour('claude')).toBe(AGENT_COLOUR.claude);
    expect(agentColour('claude-code-acp')).toBe(AGENT_COLOUR.claude);
    expect(agentColour('Gemini CLI')).toBe(AGENT_COLOUR.gemini);
    expect(agentColour('codex')).toBe(AGENT_COLOUR.codex);
  });

  it('falls back to the house accent for an agent it has no colour for', () => {
    expect(agentColour('some-other-agent')).toBe(BRAND);
  });
});

describe('the shimmer band', () => {
  const WORD = 'Working…';
  const CYCLE = [...WORD].length + 20;
  const ticks = Array.from({ length: CYCLE }, (_, tick) => shimmer(WORD, tick));

  // The band only recolours the word; a split that dropped or duplicated a
  // code point would show up on screen as the word changing shape mid-sweep.
  it('never alters the word it crosses', () => {
    for (const { before, band, after } of ticks) {
      expect(before + band + after).toBe(WORD);
    }
  });

  it('stays a glint rather than a highlight', () => {
    for (const { band } of ticks) expect([...band].length).toBeLessThanOrEqual(3);
  });

  // Most of a cycle is the gap between passes, and the word has to sit in one
  // piece through it.
  it('leaves the word whole between passes', () => {
    expect(ticks.filter(({ band }) => band === '').length).toBeGreaterThan(CYCLE / 2);
  });

  it('sweeps right to left', () => {
    const positions = ticks.map(({ before, band }) => (band ? [...before].length : -1));
    const passing = positions.filter((position) => position >= 0);
    expect(passing).toEqual([...passing].sort((a, b) => b - a));
    expect(passing.at(0)).toBe([...WORD].length - 1);
    expect(passing.at(-1)).toBe(0);
  });
});
