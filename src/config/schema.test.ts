import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './schema.js';

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
});
