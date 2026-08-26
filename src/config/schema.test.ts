import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './schema.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('config schema', () => {
  it('applies safe defaults', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.agents.claude.permissionMode).toBe('acceptEdits');
    expect(cfg.agents.gemini.approvalMode).toBe('auto_edit');
    expect(cfg.agents.codex.sandbox).toBe('workspace-write');
    expect(cfg.llm.baseURL).toBe('http://localhost:1234/v1');
  });

  it('makes bypass modes unrepresentable in enums', () => {
    expect(() =>
      ConfigSchema.parse({ agents: { claude: { permissionMode: 'bypassPermissions' } } }),
    ).toThrow();
    expect(() => ConfigSchema.parse({ agents: { gemini: { approvalMode: 'yolo' } } })).toThrow();
    expect(() =>
      ConfigSchema.parse({ agents: { codex: { sandbox: 'danger-full-access' } } }),
    ).toThrow();
  });

  it.each([
    ['claude', '--dangerously-skip-permissions'],
    ['gemini', '--yolo'],
    ['gemini', '-y'],
    ['gemini', '--approval-mode=yolo'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox'],
    ['codex', '--sandbox=danger-full-access'],
  ])('rejects forbidden flag smuggled via %s extraArgs: %s', (agent, flag) => {
    expect(() => ConfigSchema.parse({ agents: { [agent]: { extraArgs: [flag] } } })).toThrow(
      /Forbidden flag/,
    );
  });

  it('allows benign extraArgs', () => {
    const cfg = ConfigSchema.parse({ agents: { claude: { extraArgs: ['--model', 'opus'] } } });
    expect(cfg.agents.claude.extraArgs).toEqual(['--model', 'opus']);
  });

  it.each([['Bash'], ['Bash(git:*)'], ['WebFetch'], ['WebSearch'], ['Task']])(
    'refuses to widen claude beyond file tools via allowedTools: %s',
    (tool) => {
      expect(() =>
        ConfigSchema.parse({ agents: { claude: { allowedTools: ['Read', tool] } } }),
      ).toThrow(/Forbidden tool/);
    },
  );

  it('allows narrowing the tool list', () => {
    const cfg = ConfigSchema.parse({ agents: { claude: { allowedTools: ['Read', 'Write'] } } });
    expect(cfg.agents.claude.allowedTools).toEqual(['Read', 'Write']);
  });

  it('defaults to a bounded LLM timeout and history window', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.llm.timeoutMs).toBeGreaterThan(0);
    expect(cfg.orchestrator.maxHistoryMessages).toBeGreaterThan(0);
  });

  it('accepts the example config shipped in the repo', () => {
    const file = path.join(repoRoot, 'handsfree.config.example.json');
    const cfg = ConfigSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(cfg.llm.timeoutMs).toBe(120_000);
    expect(cfg.orchestrator.maxHistoryMessages).toBe(40);
  });
});
