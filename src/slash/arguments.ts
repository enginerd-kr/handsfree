/**
 * Splits an argument string the way a shell would, so a quoted phrase survives
 * as one argument.
 *
 * Not `scanScript` from the policy engine: that one exists to stop at anything
 * a shell would interpret and hands back a truncated token list with the
 * operator it found. Correct for judging a command, wrong for splitting
 * arguments, where a `|` someone typed is just a character in a word.
 */
export function parseArguments(args: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  // A quoted empty string is an argument; an empty gap between spaces is not.
  let started = false;

  for (const char of args) {
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || token !== '') tokens.push(token);
      token = '';
      started = false;
      continue;
    }
    token += char;
  }
  if (started || token !== '') tokens.push(token);
  return tokens;
}

/**
 * Puts the arguments into the body of a command file.
 *
 * The order is load-bearing. `$ARGUMENTS[0]` has to be settled before the bare
 * `$ARGUMENTS`, or the index is left dangling on the end of the whole argument
 * string; `$1` has to come after the indexed form for the same reason.
 *
 * A body with no placeholder at all still gets the arguments — appended under a
 * heading rather than dropped. That fallback is what lets someone write a
 * command file as plain prose and have `/review src` mean something.
 *
 * Every replacement goes through a function, so a `$&` in an argument is a
 * dollar and an ampersand rather than an instruction to the regex engine.
 */
export function substituteArguments(
  body: string,
  args: string,
  argNames: readonly string[] = [],
): string {
  const parsed = parseArguments(args);
  let out = body;

  for (const [index, name] of argNames.entries()) {
    // `$name`, but not `$names` and not `$name[0]` — those are someone else's.
    const pattern = new RegExp(`\\$${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\[\\w])`, 'g');
    out = out.replace(pattern, () => parsed[index] ?? '');
  }
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, index: string) => parsed[Number(index)] ?? '');
  out = out.replace(/\$(\d+)(?!\w)/g, (_, index: string) => parsed[Number(index)] ?? '');
  out = out.replaceAll('$ARGUMENTS', () => args);

  if (out === body && args !== '') out = `${out}\n\nARGUMENTS: ${args}`;
  return out;
}
