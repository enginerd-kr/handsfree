/**
 * The system clipboard, read for the one thing the terminal cannot paste on
 * its own: an image. Text is the terminal's business — the transcript sits in
 * its scrollback, so its own selection copies it, and its own paste types it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
