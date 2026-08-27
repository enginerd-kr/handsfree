import { describe, expect, it } from 'vitest';
import { AGENT_COLOUR, agentColour, BRAND, MASCOT, MASCOT_BLINK } from './theme.js';

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
