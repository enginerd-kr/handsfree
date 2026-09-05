// Isolate configuration without changing HOME or reading the user's agents.
require('node:os').homedir = () => require('node:path').join(process.cwd(), 'home');
process.argv.splice(1, 1);
// Let Ink exercise its input lifecycle over the test's pipe.
if (process.argv.length === 2) {
  process.stdin.isTTY = true;
  process.stdin.setRawMode = () => process.stdin;
}
import(require('node:url').pathToFileURL(process.argv[1]).href);
