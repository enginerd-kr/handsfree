import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(file) && !file.includes('.test.') ? [file] : [];
  });
}

// Each area may use earlier areas. Peers remain independent; local imports
// within an area are checked for cycles separately, including type-only edges.
const areas = [
  ['contracts/', 'debug.ts', 'version.ts'],
  ['config/'], ['policy/'], ['workspace/'], ['host/'], ['models/'],
  ['orchestrator/usage/', 'orchestrator/results/'],
  ['orchestrator/context/'], ['orchestrator/execution/'], ['orchestrator/conversation/'],
  ['runtime.ts'], ['ui/', 'servers/'], ['commands/'], ['main.ts'],
];
const areaOf = (file: string) => {
  const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
  for (const [layer, prefixes] of areas.entries()) {
    const area = prefixes.find((prefix) => prefix.endsWith('/') ? relative.startsWith(prefix) : relative === prefix);
    if (area) return { area, layer };
  }
  throw new Error(`Assign a responsibility to src/${relative} in the architecture test`);
};

const files = sourceFiles(sourceRoot);
const graph = new Map(files.map((file) => [file, new Set<string>()]));
for (const file of files) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const add = (id: string) => {
    if (!id.startsWith('.')) return;
    const target = path.resolve(path.dirname(file), id);
    const resolved = [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx')].find((candidate) => graph.has(candidate));
    if (!resolved) throw new Error(`Unresolved source dependency in ${file}: ${id}`);
    graph.get(file)!.add(resolved);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

describe('source architecture', () => {
  it('keeps infrastructure independent of orchestration and entry points', () => {
    const violations: string[] = [];
    for (const [file, dependencies] of graph) {
      const from = areaOf(file);
      for (const dependency of dependencies) {
        const to = areaOf(dependency);
        if (from.area !== to.area && from.layer <= to.layer) {
          violations.push(`${path.relative(sourceRoot, file)} -> ${path.relative(sourceRoot, dependency)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('has no circular source imports, including types and lazy entry points', () => {
    const visited = new Set<string>();
    const active: string[] = [];
    const visit = (file: string) => {
      if (active.includes(file)) throw new Error(`Circular import: ${[...active, file].map((entry) => path.relative(sourceRoot, entry)).join(' -> ')}`);
      if (visited.has(file)) return;
      active.push(file);
      for (const dependency of graph.get(file)!) visit(dependency);
      active.pop();
      visited.add(file);
    };
    for (const file of files) visit(file);
    expect(visited.size).toBe(files.length);
  });
});
