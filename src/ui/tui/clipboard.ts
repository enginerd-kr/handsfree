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
import fs from 'node:fs';
import path from 'node:path';

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

/**
 * The image on the clipboard, if there is one, written as a PNG under
 * `dir` — the path the prompt then attaches. Each platform is asked through
 * its own tool, and a clipboard holding no image, or a machine with no tool,
 * answers with nothing rather than an error: ctrl+v with text on the
 * clipboard is not a mistake, it is just not an image.
 */
export async function readClipboardImage(dir: string): Promise<string | undefined> {
  const file = path.join(dir, `clipboard-${Date.now()}.png`);
  const command = imageReader(file);
  if (!command) return undefined;
  fs.mkdirSync(dir, { recursive: true });
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(command.command, command.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const out = command.toFile ? fs.createWriteStream(file) : undefined;
    if (out) child.stdout.pipe(out);
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (out) out.end(() => resolve(code === 0));
      else resolve(code === 0);
    });
  });
  const written = ok && fs.existsSync(file) && fs.statSync(file).size > 0;
  if (!written) fs.rmSync(file, { force: true });
  return written ? file : undefined;
}

/** The platform's way of getting a PNG off the clipboard into `file`. */
function imageReader(file: string): { command: string; args: string[]; toFile: boolean } | undefined {
  switch (process.platform) {
    case 'darwin':
      return {
        command: 'osascript',
        args: [
          '-e',
          'set png to the clipboard as «class PNGf»',
          '-e',
          `set f to open for access POSIX file "${file}" with write permission`,
          '-e',
          'set eof f to 0',
          '-e',
          'write png to f',
          '-e',
          'close access f',
        ],
        toFile: false,
      };
    case 'win32':
      return {
        command: 'powershell',
        args: [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i -eq $null) { exit 1 }; $i.Save('${file.replace(/'/g, "''")}')`,
        ],
        toFile: false,
      };
    default:
      if (process.env['WAYLAND_DISPLAY'])
        return { command: 'wl-paste', args: ['-t', 'image/png'], toFile: true };
      if (process.env['DISPLAY'])
        return {
          command: 'xclip',
          args: ['-selection', 'clipboard', '-t', 'image/png', '-o'],
          toFile: true,
        };
      return undefined;
  }
}
