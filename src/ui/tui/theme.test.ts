import { describe, expect, it } from 'vitest';
import {
  AGENT_COLOUR,
  agentColour,
  BRAND,
  BRIEFINGS,
  columns,
  MASCOT,
  MASCOT_STAGE,
  mascot,
  SAYINGS,
  shimmer,
  stage,
  type Look,
  type Stance,
} from './theme.js';

/**
 * A row of quadrant blocks flipped end to end, each glyph swapped for the one
 * that is its own reflection — what the mark would look like in a mirror.
 */
const REFLECT: Record<string, string> = {
  '▛': '▜',
  '▜': '▛',
  '▙': '▟',
  '▟': '▙',
  '▌': '▐',
  '▐': '▌',
  '▘': '▝',
  '▝': '▘',
  '▖': '▗',
  '▗': '▖',
};
function reflect(line: string): string {
  return [...line]
    .reverse()
    .map((glyph) => REFLECT[glyph] ?? glyph)
    .join('');
}

describe('the welcome mark', () => {
  const stances: Stance[] = ['stand', 'easy', 'sit', 'air'];
  const looks: Look[] = ['ahead', 'left', 'right'];

  // The header is a fixed number of rows of a fixed width — that is what a
  // click's row is measured against — so a blink or a pose may only swap
  // glyphs, never a row or a cell.
  it('keeps its shape through every stance, eyes open, shut, or turned', () => {
    for (const stance of stances) {
      for (const shut of [false, true]) {
        for (const look of looks) {
          const posed = mascot(stance, shut, look);
          expect(posed).toHaveLength(MASCOT.length);
          expect(posed.map((line) => [...line].length)).toEqual(
            MASCOT.map((line) => [...line].length),
          );
        }
      }
    }
  });

  it('stands by default, the mark the header opens with', () => {
    expect(mascot()).toEqual([...MASCOT]);
  });

  // A blink is the two corner holes of the top row filling in — the head is
  // the only row that changes, wherever the stance has put it.
  it('shuts only its eyes in any stance', () => {
    for (const stance of stances) {
      const open = mascot(stance);
      const shut = mascot(stance, true);
      const changed = open.filter((line, row) => line !== shut[row]);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toContain('▛');
    }
  });

  // Sitting, the whole mark drops a row — head on the middle row, body on the
  // ground, feet tucked out of sight — and the top row goes empty. The row it
  // comes to rest on is the arms-down body opened up either side of its
  // middle: legs with the ground showing through between them, which is the
  // only thing at this size that tells a sat mark from one that merely stands
  // a row lower.
  it('sits a row lower on legs with the floor showing between them', () => {
    const [top, middle, bottom] = mascot('sit');
    const dropped = [...mascot('easy')[1]];
    const seated = [...bottom];
    expect(top.trim()).toBe('');
    expect(middle).toBe(mascot()[0]);
    // The arms and the shoulder either side of the hole are the arms and
    // shoulders the mark drops at ease; only the belly between them opens.
    expect(seated.slice(0, 3)).toEqual(dropped.slice(0, 3));
    expect(seated.slice(-3)).toEqual(dropped.slice(-3));
    expect(seated.slice(3, -3).join('')).toBe('▀█▀');
  });

  // Mid-jump the feet leave the bottom row entirely; the head and body hold
  // their standing rows, so only the ground opens up beneath the mark.
  it('leaves the ground row empty mid-jump', () => {
    const [top, middle, bottom] = mascot('air');
    expect(bottom.trim()).toBe('');
    expect(top).toBe(mascot()[0]);
    expect(middle).toBe(mascot()[1]);
  });

  // A glance is the eyes and nothing else: the head is the only row that may
  // differ, whatever the mark is standing or sitting on.
  it('turns only its head to look aside', () => {
    for (const stance of stances) {
      for (const look of ['left', 'right'] as const) {
        const ahead = mascot(stance);
        const aside = mascot(stance, false, look);
        const changed = ahead.filter((line, row) => line !== aside[row]);
        expect(changed).toHaveLength(1);
      }
    }
  });

  // The two glances are one face turned, not two faces: each is the other in
  // a mirror, and looking straight out is its own reflection.
  it('looks left and right by the same quadrant', () => {
    expect(reflect(mascot('stand', false, 'left')[0])).toBe(mascot('stand', false, 'right')[0]);
    expect(reflect(MASCOT[0])).toBe(MASCOT[0]);
  });

  // Shut, there are no eyes to turn — the head that closed on a glance is the
  // head that closed looking straight out.
  it('shows the same shut eyes whichever way it was looking', () => {
    for (const look of looks) expect(mascot('stand', true, look)).toEqual(mascot('stand', true));
  });

  // At ease only the arms move: the nubs at the body's edges drop from the
  // top half of their cells to the bottom half.
  it('drops only its arms at ease', () => {
    const stand = mascot();
    const easy = mascot('easy');
    expect(easy[0]).toBe(stand[0]);
    expect(easy[2]).toBe(stand[2]);
    expect(easy[1]).not.toBe(stand[1]);
    expect([...easy[1]].slice(1, -1).join('')).toBe([...stand[1]].slice(1, -1).join(''));
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

  // The stage is sized off the sayings themselves — counted in columns, so a
  // wide glyph counts for the two it takes — with room for the widest one on
  // each side of the mark, so a word goes out wherever the mark stands without
  // it shuffling to make space. A briefing is a saying like any other and has
  // to fit the same room.
  it('gives every saying room on both sides of the mark', () => {
    expect(columns('Hi')).toBe(2);
    expect(columns('허리업')).toBe(6);
    for (const saying of [...SAYINGS, ...Object.values(BRIEFINGS).flat()]) {
      expect(span + 2 * (1 + columns(saying))).toBeLessThanOrEqual(MASCOT_STAGE);
    }
  });
});

describe('what the mark says', () => {
  it('never repeats itself in the idle sayings', () => {
    expect(new Set(SAYINGS).size).toBe(SAYINGS.length);
  });

  // Every phase the transcript can report has to have words for it — a phase
  // that came back empty would put the mark's megaphone up around nothing.
  it('has a handful of wordings for every phase of a turn', () => {
    for (const [phase, words] of Object.entries(BRIEFINGS)) {
      expect(words.length, phase).toBeGreaterThan(1);
      expect(new Set(words).size, phase).toBe(words.length);
      for (const word of words) expect(word.trim(), phase).not.toBe('');
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
