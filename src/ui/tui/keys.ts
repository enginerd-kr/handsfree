/**
 * Whether `input` is a terminal's answer to Ink's kitty keyboard query,
 * `ESC[?flags u`, as Ink delivers it: without the escape byte. Ink reads the
 * answer to decide whether to switch the protocol on, but reads it on a
 * second path that also hands it to `useInput` — and a prompt that took it
 * would open every run with `[?0u` already typed.
 */
export function isKittyQueryReply(input: string): boolean {
  return /^\[\?\d+u$/.test(input);
}

/** Terminal responses can arrive at an input editor but are never typed text. */
export function isTerminalReport(input: string): boolean {
  return isKittyQueryReply(input) || /^\[\d+;\d+R$/.test(input) || /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}
