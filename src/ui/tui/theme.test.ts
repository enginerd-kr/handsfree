import { describe, expect, it } from 'vitest';
import { AGENT_COLOUR, agentColour, BRAND, MASCOT, MASCOT_BLINK, shimmer } from './theme.js';

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
