/**
 * The system clipboard.
 *
 * A drag on the transcript ends here. The platform's own tool carries the text
 * when the machine has one — it works even in terminals that never heard of
 * OSC 52 — and the escape that asks the terminal itself to hold the text is
 * the road taken when no tool answers, which also happens to be the one that
 * crosses an SSH connection.
 */
import { spawn } from 'node:child_process';

/**
 * Every escape sequence: CSI with its parameters, and the BEL-terminated
 * strings (title changes, hyperlinks) that carry free text inside them.
 */
const ANSI =
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;

/** The words with their styling gone — what a clipboard should hold. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** The platform's clipboard writer, where it has one. */
function tool(): { command: string; args: string[] } | undefined {
  switch (process.platform) {
    case 'darwin':
      return { command: 'pbcopy', args: [] };
    case 'win32':
      return { command: 'clip', args: [] };
    default:
      if (process.env['WAYLAND_DISPLAY']) return { command: 'wl-copy', args: [] };
      if (process.env['DISPLAY']) return { command: 'xclip', args: ['-selection', 'clipboard'] };
      return undefined;
  }
}

/**
 * Puts `text` on the clipboard, silently: the UI already says what was copied,
 * and there is no better place than a paste to find out it did not arrive.
 */
export function copyToClipboard(text: string, stdout?: NodeJS.WriteStream): void {
  const osc52 = () =>
    stdout?.write(`\u001B]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`);
  const writer = tool();
  if (!writer) {
    osc52();
    return;
  }
  const child = spawn(writer.command, writer.args, { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', osc52);
  // A missing tool surfaces on the pipe as well as the child; one road to the
  // fallback is enough.
  child.stdin.on('error', () => {});
  // clip.exe reads the console's own codepage unless a BOM says Unicode.
  child.stdin.end(process.platform === 'win32' ? Buffer.from(`\uFEFF${text}`, 'utf16le') : text);
}
