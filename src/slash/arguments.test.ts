import { describe, expect, it } from 'vitest';
import { parseArguments, substituteArguments } from './arguments.js';

describe('parseArguments', () => {
  it('splits on whitespace', () => {
    expect(parseArguments('foo bar  baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('keeps a quoted phrase whole, in either quote', () => {
    expect(parseArguments('foo "hello world" baz')).toEqual(['foo', 'hello world', 'baz']);
    expect(parseArguments("foo 'hello world'")).toEqual(['foo', 'hello world']);
  });

  it('keeps a quoted empty string', () => {
    expect(parseArguments('a "" b')).toEqual(['a', '', 'b']);
  });

  // Not `scanScript`: an operator someone typed is a character in a word here,
  // not a reason to stop reading.
  it('leaves shell punctuation alone', () => {
    expect(parseArguments('a|b >c')).toEqual(['a|b', '>c']);
  });

  it('is empty for nothing', () => {
    expect(parseArguments('   ')).toEqual([]);
  });
});

describe('substituteArguments', () => {
  it('puts the whole argument string in $ARGUMENTS', () => {
    expect(substituteArguments('Review $ARGUMENTS.', 'src/policy')).toBe('Review src/policy.');
  });

  it('resolves an index before the bare form', () => {
    expect(substituteArguments('$ARGUMENTS[1] then $ARGUMENTS', 'a b')).toBe('b then a b');
  });

  it('resolves the $n shorthand and leaves a missing one empty', () => {
    expect(substituteArguments('[$0][$1][$2]', 'a b')).toBe('[a][b][]');
  });

  it('resolves names from the frontmatter', () => {
    expect(substituteArguments('deploy $target from $branch', 'prod main', ['target', 'branch'])).toBe(
      'deploy prod from main',
    );
  });

  it('leaves a name that only looks like one alone', () => {
    expect(substituteArguments('$targets and $target', 'prod', ['target'])).toBe('$targets and prod');
  });

  // The fallback is what lets a command file be written as plain prose.
  it('appends the arguments when the body never asked for them', () => {
    expect(substituteArguments('Review the diff.', 'src')).toBe('Review the diff.\n\nARGUMENTS: src');
  });

  it('appends nothing when there were no arguments', () => {
    expect(substituteArguments('Review the diff.', '')).toBe('Review the diff.');
  });

  // A `$&` in an argument is two characters, not an instruction to the engine.
  it('does not let an argument address the replacement', () => {
    expect(substituteArguments('[$ARGUMENTS]', "$& $'")).toBe("[$& $']");
  });
});
