import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const REPORT_DIR = fileURLToPath(new URL('../../e2e-report', import.meta.url));
export const DATA_DIR = path.join(REPORT_DIR, 'data');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');

export interface Attachment {
  kind: 'screenshot' | 'video' | 'log';
  name: string;
  /** Path relative to the report dir (screenshots/videos), or inline content (logs). */
  path?: string;
  content?: string;
  frameCount?: number;
  durationMs?: number;
}

export interface TestManifest {
  /** Absolute test file path — matched against vitest's moduleId. */
  file: string;
  /** Full test name — matched against vitest's fullName. */
  test: string;
  attachments: Attachment[];
  finalScreenText?: string;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Identity of the currently running vitest test. */
export function currentTest(): { file: string; test: string; slug: string } {
  const state = expect.getState();
  const file = state.testPath ?? 'unknown';
  const test = state.currentTestName ?? 'unknown';
  return { file, test, slug: `${slugify(path.basename(file))}--${slugify(test)}` };
}

function manifestPath(slug: string): string {
  return path.join(DATA_DIR, `${slug}.json`);
}

function loadOrCreate(slug: string, file: string, test: string): TestManifest {
  const p = manifestPath(slug);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) as TestManifest;
  return { file, test, attachments: [] };
}

export function saveAttachment(att: Attachment, finalScreenText?: string): void {
  const { file, test, slug } = currentTest();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const manifest = loadOrCreate(slug, file, test);
  manifest.attachments.push(att);
  if (finalScreenText !== undefined) manifest.finalScreenText = finalScreenText;
  fs.writeFileSync(manifestPath(slug), JSON.stringify(manifest, null, 2));
}

/** Write a binary asset for the current test; returns its report-relative path. */
export function writeAsset(name: string, data: Buffer): string {
  const { slug } = currentTest();
  const dir = path.join(ASSETS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return path.relative(REPORT_DIR, file);
}

/** Attach a plain-text log (e.g. headless stdout) to the current test's report entry. */
export function attachLog(name: string, content: string): void {
  try {
    saveAttachment({ kind: 'log', name, content });
  } catch {
    // Reporting must never fail a test.
  }
}
