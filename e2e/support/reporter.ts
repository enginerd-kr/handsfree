import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';
import { DATA_DIR, REPORT_DIR, type TestManifest } from './reportStore.js';

interface ReportedTest {
  name: string;
  state: string;
  durationMs: number;
  errors: string[];
  manifest?: TestManifest;
}

/**
 * Vitest reporter that assembles a Playwright-style HTML report at
 * e2e-report/index.html from test results + the screenshots/videos/logs that
 * TuiSession and attachLog() drop into e2e-report/data during the run.
 */
export default class HtmlReporter implements Reporter {
  onTestRunStart(): void {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const manifests: TestManifest[] = fs.existsSync(DATA_DIR)
      ? fs
          .readdirSync(DATA_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')) as TestManifest)
      : [];

    const files: { file: string; tests: ReportedTest[] }[] = [];
    for (const mod of testModules) {
      const tests: ReportedTest[] = [];
      for (const test of mod.children.allTests()) {
        tests.push(toReported(test, mod, manifests));
      }
      if (tests.length > 0) files.push({ file: relToRoot(mod.moduleId), tests });
    }

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'index.html'), renderHtml(files));
    // eslint-disable-next-line no-console
    console.log(`\nHTML report: ${path.join(REPORT_DIR, 'index.html')}`);
  }
}

function toReported(test: TestCase, mod: TestModule, manifests: TestManifest[]): ReportedTest {
  const result = test.result();
  return {
    name: test.fullName,
    state: result.state,
    durationMs: test.diagnostic()?.duration ?? 0,
    errors: (result.errors ?? []).map((e) => e.stack || e.message || String(e)),
    manifest: manifests.find((m) => m.file === mod.moduleId && m.test === test.fullName),
  };
}

function relToRoot(moduleId: string): string {
  return path.relative(path.join(REPORT_DIR, '..'), moduleId);
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const STATE_BADGE: Record<string, { label: string; cls: string }> = {
  passed: { label: 'PASS', cls: 'pass' },
  failed: { label: 'FAIL', cls: 'fail' },
  skipped: { label: 'SKIP', cls: 'skip' },
  pending: { label: 'PENDING', cls: 'skip' },
};

function renderTest(t: ReportedTest): string {
  const badge = STATE_BADGE[t.state] ?? STATE_BADGE.pending;
  const shots = (t.manifest?.attachments ?? []).filter((a) => a.kind === 'screenshot');
  const videos = (t.manifest?.attachments ?? []).filter((a) => a.kind === 'video');
  const logs = (t.manifest?.attachments ?? []).filter((a) => a.kind === 'log');

  const parts: string[] = [
    `<article class="test">`,
    `<header><span class="badge ${badge.cls}">${badge.label}</span>` +
      `<h3>${esc(t.name)}</h3><span class="dur">${fmtMs(t.durationMs)}</span></header>`,
  ];

  for (const err of t.errors) parts.push(`<pre class="error">${esc(err)}</pre>`);

  if (shots.length > 0) {
    parts.push(
      `<div class="label">Screenshots</div><div class="shots">`,
      ...shots.map(
        (s) =>
          `<figure><a href="${esc(s.path ?? '')}" target="_blank"><img loading="lazy" src="${esc(s.path ?? '')}" alt="${esc(s.name)}"></a><figcaption>${esc(s.name)}</figcaption></figure>`,
      ),
      `</div>`,
    );
  }
  for (const v of videos) {
    parts.push(
      `<div class="label">Video <span class="meta">${v.frameCount ?? '?'} frames · ${fmtMs(v.durationMs ?? 0)} · loops</span></div>`,
      `<div class="video"><img src="${esc(v.path ?? '')}" alt="session recording"></div>`,
    );
  }
  if (t.manifest?.finalScreenText) {
    parts.push(
      `<details><summary>Final screen (text)</summary><pre class="term">${esc(t.manifest.finalScreenText)}</pre></details>`,
    );
  }
  for (const log of logs) {
    parts.push(`<details><summary>${esc(log.name)}</summary><pre class="term">${esc(log.content ?? '')}</pre></details>`);
  }
  parts.push(`</article>`);
  return parts.join('\n');
}

function renderHtml(files: { file: string; tests: ReportedTest[] }[]): string {
  const all = files.flatMap((f) => f.tests);
  const passed = all.filter((t) => t.state === 'passed').length;
  const failed = all.filter((t) => t.state === 'failed').length;
  const skipped = all.length - passed - failed;
  const total = fmtMs(all.reduce((a, t) => a + t.durationMs, 0));

  const body = files
    .map((f) => `<section><h2>${esc(f.file)}</h2>${f.tests.map(renderTest).join('\n')}</section>`)
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>handsfree e2e report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0f1117; color: #d8dee9; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #7c869c; margin-bottom: 16px; }
  .summary { display: flex; gap: 8px; margin-bottom: 28px; flex-wrap: wrap; }
  .chip { padding: 4px 12px; border-radius: 999px; font-weight: 600; font-size: 13px; background: #1b1f2a; }
  .chip.pass { color: #9ece6a; } .chip.fail { color: #f7768e; } .chip.skip { color: #e0af68; }
  section h2 { font-size: 13px; color: #7c869c; font-weight: 600; letter-spacing: .04em;
    border-bottom: 1px solid #232838; padding-bottom: 6px; margin: 28px 0 12px; }
  .test { background: #151926; border: 1px solid #232838; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .test header { display: flex; align-items: center; gap: 10px; }
  .test h3 { font-size: 14px; margin: 0; flex: 1; font-weight: 600; }
  .badge { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 5px; letter-spacing: .05em; }
  .badge.pass { background: #1c2e1f; color: #9ece6a; }
  .badge.fail { background: #331b22; color: #f7768e; }
  .badge.skip { background: #33291b; color: #e0af68; }
  .dur { color: #7c869c; font-size: 12px; }
  .label { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: #7c869c; text-transform: uppercase; letter-spacing: .06em; }
  .label .meta { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .shots { display: flex; gap: 10px; flex-wrap: wrap; }
  .shots figure { margin: 0; width: 240px; }
  .shots img { width: 100%; border-radius: 6px; border: 1px solid #232838; display: block; }
  .shots figcaption { font-size: 12px; color: #7c869c; margin-top: 4px; text-align: center; }
  .video img { max-width: 100%; border-radius: 8px; border: 1px solid #232838; }
  pre.error { background: #241318; border: 1px solid #46232c; color: #f7768e; padding: 10px 12px;
    border-radius: 8px; overflow-x: auto; font-size: 12px; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: #7c869c; font-size: 13px; }
  pre.term { background: #10131c; border: 1px solid #232838; padding: 10px 12px; border-radius: 8px;
    overflow-x: auto; font: 12px/1.45 Menlo, Consolas, monospace; }
</style></head>
<body><div class="wrap">
<h1>handsfree e2e report</h1>
<div class="sub">${esc(new Date().toLocaleString())}</div>
<div class="summary">
  <span class="chip pass">${passed} passed</span>
  <span class="chip fail">${failed} failed</span>
  <span class="chip skip">${skipped} skipped</span>
  <span class="chip">${total} total</span>
</div>
${body}
</div></body></html>
`;
}
