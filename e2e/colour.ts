/**
 * Colour, whether or not anyone is watching.
 *
 * The shots are taken with nothing attached to stdout, so chalk — and every
 * colour ink asks it for — would otherwise decide there is no terminal to
 * paint and hand back bare text. A screenshot of the UI in monochrome is a
 * screenshot of a different program, so this is imported first, before ink and
 * chalk are pulled in and read it.
 */
process.env['FORCE_COLOR'] = '3';
