/**
 * The transcript's speaker vocabulary, borrowed from the Claude Code CLI: a
 * pointer for the line you typed, a filled circle for something handsfree did,
 * and an elbow for the result hanging off the circle above it.
 */

/** ⏺ sits on the text baseline on macOS; ● is the portable fallback. */
export const BULLET = process.platform === 'darwin' ? '⏺' : '●';
export const POINTER = '❯';
export const ELBOW = '⎿';

/** Columns the bullet gutter occupies, so wrapped text keeps its indent. */
export const BULLET_WIDTH = 2;
/** Columns the `  ⎿  ` gutter occupies — result text aligns under the bullet's text. */
export const ELBOW_WIDTH = 5;
