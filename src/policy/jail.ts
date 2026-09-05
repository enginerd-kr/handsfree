import fs from 'node:fs';
import path from 'node:path';

export type JailVerdict =
  | { ok: true; path: string; real: string }
  | { ok: false; reason: string };

/** Resolves paths for host operations and workspace-relative display. */
export class Jail {
  private readonly roots: string[];

  constructor(
    roots: string[],
  ) {
    if (roots.length === 0) throw new Error('A jail needs at least one root.');
    this.roots = roots.map((root) => canonicalise(path.resolve(root)));
  }

  get primaryRoot(): string {
    return this.roots[0]!;
  }

  /** Path relative to the first root, for display only. */
  display(target: string): string {
    const rel = path.relative(this.primaryRoot, target);
    return rel === '' ? '.' : rel;
  }

  check(target: string): JailVerdict {
    if (typeof target !== 'string' || target === '') {
      return { ok: false, reason: 'empty path' };
    }
    if (target.includes('\0')) {
      return { ok: false, reason: 'path contains a null byte' };
    }
    if (!path.isAbsolute(target)) {
      // ACP requires absolute paths. A relative one means we and the agent
      // disagree about the base directory, and guessing is how escapes happen.
      return { ok: false, reason: `path is not absolute: ${target}` };
    }

    // Containment is decided on the resolved path alone. Checking the literal
    // string first would reject honest paths whose root reaches the workspace
    // through a symlink — `/tmp` and `/var` on macOS, a linked home directory —
    // and it would catch nothing that resolving does not catch anyway.
    const normalised = path.normalize(target);
    const { existing, rest } = deepestExisting(normalised);
    let realExisting: string;
    try {
      realExisting = fs.realpathSync(existing);
    } catch (err) {
      return { ok: false, reason: `cannot resolve ${existing}: ${(err as Error).message}` };
    }
    const real = rest.length > 0 ? path.join(realExisting, ...rest) : realExisting;
    return { ok: true, path: normalised, real };
  }

}

function canonicalise(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    // The workspace may not exist yet; the lexical path is the best we have and
    // check() re-resolves against reality on every call anyway.
    return dir;
  }
}

/** Split a path into its deepest existing ancestor and the segments below it. */
function deepestExisting(target: string): { existing: string; rest: string[] } {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    if (fs.existsSync(current)) return { existing: current, rest: rest.reverse() };
    const parent = path.dirname(current);
    if (parent === current) return { existing: current, rest: rest.reverse() };
    rest.push(path.basename(current));
    current = parent;
  }
}
