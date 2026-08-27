/**
 * Small local models wrap JSON in prose, code fences, or a second copy of the
 * same object. Pulling out the first balanced object is more reliable than
 * asking them again to behave.
 */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Pulls the value of a `"message"` key out of JSON as it streams, so an answer
 * can be shown while the model is still writing it. Feed it raw reply text in
 * any chunking; it returns the decoded message characters each chunk adds.
 *
 * A key match, a `\uXXXX` escape, or any other token can be split across
 * chunks, so the whole thing is a character-at-a-time state machine. It reads
 * the first `"message"` key it sees — the planner's reply is one flat object,
 * so there is nothing deeper to be confused by.
 */
export class MessageStream {
  private static readonly KEY = '"message"';
  private state: 'seek' | 'colon' | 'quote' | 'string' | 'done' = 'seek';
  private matched = 0;
  private prev = '';
  /** A backslash escape being collected, `\` through `\uXXXX`. */
  private escape: string | undefined;

  push(text: string): string {
    let out = '';
    for (const ch of text) {
      switch (this.state) {
        case 'done':
          return out;
        case 'seek':
          this.seek(ch);
          break;
        case 'colon':
          if (!/\s/.test(ch)) {
            if (ch === ':') this.state = 'quote';
            else this.reseek(ch);
          }
          break;
        case 'quote':
          if (!/\s/.test(ch)) {
            if (ch === '"') this.state = 'string';
            else this.reseek(ch);
          }
          break;
        case 'string':
          out += this.decode(ch);
          break;
      }
      this.prev = ch;
    }
    return out;
  }

  private seek(ch: string): void {
    const wanted = MessageStream.KEY[this.matched]!;
    if (ch === wanted && (this.matched > 0 || this.prev !== '\\')) {
      this.matched++;
      if (this.matched === MessageStream.KEY.length) {
        this.state = 'colon';
        this.matched = 0;
      }
    } else {
      this.reseek(ch);
    }
  }

  /** A mismatch may itself be the quote that opens the real key. */
  private reseek(ch: string): void {
    this.state = 'seek';
    this.matched = ch === '"' && this.prev !== '\\' ? 1 : 0;
  }

  private decode(ch: string): string {
    if (this.escape !== undefined) {
      this.escape += ch;
      return this.finishEscape();
    }
    if (ch === '\\') {
      this.escape = '\\';
      return '';
    }
    if (ch === '"') {
      this.state = 'done';
      return '';
    }
    return ch;
  }

  private finishEscape(): string {
    const escape = this.escape!;
    const kind = escape[1]!;
    if (kind === 'u') {
      if (escape.length < 6) return '';
      this.escape = undefined;
      const code = Number.parseInt(escape.slice(2), 16);
      // Halves of a surrogate pair arrive as two escapes; emitting each half
      // lets plain string concatenation reassemble the character.
      return Number.isNaN(code) ? '' : String.fromCharCode(code);
    }
    this.escape = undefined;
    switch (kind) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      default:
        return kind;
    }
  }
}
