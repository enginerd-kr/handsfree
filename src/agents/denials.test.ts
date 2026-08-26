import { describe, expect, it } from 'vitest';
import { findDenialPhrases } from './denials.js';

describe('findDenialPhrases', () => {
  it('flags a bare refusal', () => {
    expect(findDenialPhrases('I am not allowed to run shell commands.')).not.toEqual([]);
    expect(findDenialPhrases('The tool call was denied: permission denied.')).not.toEqual([]);
  });

  it('ignores a denial the agent routed around', () => {
    // The task succeeded. Calling this "blocked" costs a needless rephrase retry.
    expect(
      findDenialPhrases("I couldn't run the shell command, so I created notes.txt directly."),
    ).toEqual([]);
    expect(
      findDenialPhrases('Running git requires approval, so I wrote the file instead.'),
    ).toEqual([]);
  });

  it('still flags a refusal in a report that also describes other work', () => {
    const text = 'I created notes.txt.\nI was not allowed to execute the build command.';
    expect(findDenialPhrases(text)).not.toEqual([]);
  });

  it('returns nothing for ordinary success prose', () => {
    expect(findDenialPhrases('Created notes.txt with the requested contents.')).toEqual([]);
  });

  it('deduplicates a refusal phrased twice', () => {
    const text = 'Permission denied.\nPermission denied.';
    expect(findDenialPhrases(text)).toHaveLength(1);
  });
});
