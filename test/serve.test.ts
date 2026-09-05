import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  client,
  methods,
  PROTOCOL_VERSION,
  type CreateElicitationResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { ConfigSchema } from '../src/config/schema.js';
import { createServeApp } from '../src/servers/acp.js';
import { fakeAgent } from './fake-agent.js';
import { scriptedModel } from './harness.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

describe('handsfree as an ACP agent', () => {
  it('drives a turn for an editor and reports back over the protocol', async () => {
    const project = tempDir('handsfree-project-');
    const root = tempDir('handsfree-root-');
    const sub = fakeAgent({ script: () => [{ do: 'say', text: 'wrote it' }] });

    const config = ConfigSchema.parse({
      workspaceRoot: root,
      agents: { claude: { command: 'unused' } },
    });
    config.workspaceRoot = root;

    const served = createServeApp(config, {
      llm: scriptedModel([
        JSON.stringify({
          action: 'call',
          tool: 'agent',
          input: { agent: 'claude', description: 'create notes.txt', prompt: 'Create notes.txt containing hello' },
        }),
        JSON.stringify({ action: 'answer', message: 'Created notes.txt.' }),
      ]),
      createTarget: () => sub.target(),
    });

    const updates: SessionNotification[] = [];
    const result = await client({ name: 'editor' })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params);
      })
      .connectWith(served.app, async (ctx) => {
        const initialized = await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        expect(initialized.agentInfo?.name).toBe('handsfree');

        const session = await ctx.request(methods.agent.session.new, {
          cwd: project,
          mcpServers: [],
        });
        return ctx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'make notes.txt' }],
        });
      });

    await served.dispose();

    expect(result.stopReason).toBe('end_turn');
    const kinds = updates.map((notification) => notification.update.sessionUpdate);
    expect(kinds).toContain('tool_call');
    // The task goes to the editor as a tool call, titled the way the planner titled it.
    const call = updates.find((notification) => notification.update.sessionUpdate === 'tool_call');
    expect(call?.update).toMatchObject({ toolCallId: 'task-1', title: 'claude: create notes.txt' });
    expect(kinds).toContain('agent_message_chunk');

    const text = updates
      .map((notification) =>
        notification.update.sessionUpdate === 'agent_message_chunk' &&
        notification.update.content.type === 'text'
          ? notification.update.content.text
          : '',
      )
      .join('');
    expect(text).toContain('Created notes.txt.');

    // The editor's project directory is the workspace; the record is not in it.
    expect(fs.existsSync(path.join(project, '.handsfree'))).toBe(false);
  });

  it('asks the editor when a rule cannot decide, and honours a refusal', async () => {
    const project = tempDir('handsfree-project-');
    const root = tempDir('handsfree-root-');
    const answers: string[] = [];
    const sub = fakeAgent({
      script: () => [
        {
          do: 'ask',
          title: 'Do something unusual',
          kind: 'other',
          onAnswer: (id) => answers.push(id),
        },
      ],
    });

    const config = ConfigSchema.parse({
      workspaceRoot: root,
      agents: { claude: { command: 'unused' } },
    });
    config.workspaceRoot = root;

    const served = createServeApp(config, {
      llm: scriptedModel([
        JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', prompt: 'Do the unusual thing' } }),
        JSON.stringify({ action: 'answer', message: 'It was refused.' }),
      ]),
      createTarget: () => sub.target(),
    });

    const asked: string[] = [];
    await client({ name: 'editor' })
      .onNotification(methods.client.session.update, () => {})
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        asked.push(ctx.params.toolCall.title ?? '');
        const reject = ctx.params.options.find((option) => option.kind === 'reject_once')!;
        return { outcome: { outcome: 'selected' as const, optionId: reject.optionId } };
      })
      .connectWith(served.app, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await ctx.request(methods.agent.session.new, {
          cwd: project,
          mcpServers: [],
        });
        return ctx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'do it' }],
        });
      });

    await served.dispose();

    expect(asked[0]).toContain('Do something unusual');
    expect(answers).toEqual(['no']);
  });

  it('offers the permission modes to the editor, and takes the one it sets', async () => {
    const project = tempDir('handsfree-project-');
    const root = tempDir('handsfree-root-');
    const answers: string[] = [];
    const sub = fakeAgent({
      script: () => [
        {
          do: 'ask',
          title: 'Do something unusual',
          kind: 'other',
          onAnswer: (id) => answers.push(id),
        },
      ],
    });

    const config = ConfigSchema.parse({
      workspaceRoot: root,
      agents: { claude: { command: 'unused' } },
    });
    config.workspaceRoot = root;

    const served = createServeApp(config, {
      llm: scriptedModel([
        JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', prompt: 'Do the unusual thing' } }),
        JSON.stringify({ action: 'answer', message: 'Done.' }),
      ]),
      createTarget: () => sub.target(),
    });

    const asked: string[] = [];
    const modeUpdates: string[] = [];
    await client({ name: 'editor' })
      .onNotification(methods.client.session.update, (ctx) => {
        if (ctx.params.update.sessionUpdate === 'current_mode_update') {
          modeUpdates.push(ctx.params.update.currentModeId);
        }
      })
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        asked.push(ctx.params.toolCall.title ?? '');
        const reject = ctx.params.options.find((option) => option.kind === 'reject_once')!;
        return { outcome: { outcome: 'selected' as const, optionId: reject.optionId } };
      })
      .connectWith(served.app, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await ctx.request(methods.agent.session.new, {
          cwd: project,
          mcpServers: [],
        });
        // The same two the terminal walks with shift+tab, opening in ask.
        expect(session.modes?.currentModeId).toBe('ask');
        expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual([
          'ask',
          'bypass',
        ]);

        // A mode handsfree does not have is refused, and nothing moves.
        await expect(
          ctx.request(methods.agent.session.setMode, { sessionId: session.sessionId, modeId: 'yolo' }),
        ).rejects.toThrow(/unknown mode/);

        await ctx.request(methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: 'bypass',
        });
        return ctx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'do it' }],
        });
      });

    await served.dispose();

    // In bypass the question never reaches the editor: the sub-agent gets its
    // single-use yes from the mode.
    expect(modeUpdates).toEqual(['bypass']);
    expect(asked).toEqual([]);
    expect(answers).toEqual(['once']);
  });

  it('carries a sub-agent’s own question up to an editor that renders forms', async () => {
    const project = tempDir('handsfree-project-');
    const root = tempDir('handsfree-root-');
    const answers: CreateElicitationResponse[] = [];
    const sub = fakeAgent({
      script: () => [
        {
          do: 'elicit',
          message: 'Rewrite the module or patch it?',
          schema: {
            type: 'object',
            properties: {
              approach: { type: 'string', title: 'Which approach?', enum: ['rewrite', 'patch'] },
            },
            required: ['approach'],
          },
          onAnswer: (response) => answers.push(response),
        },
      ],
    });

    const config = ConfigSchema.parse({
      workspaceRoot: root,
      agents: { claude: { command: 'unused' } },
    });
    config.workspaceRoot = root;

    const served = createServeApp(config, {
      llm: scriptedModel([
        JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', prompt: 'Fix the module' } }),
        JSON.stringify({ action: 'answer', message: 'Patched it.' }),
      ]),
      createTarget: () => sub.target(),
    });

    const questions: string[] = [];
    await client({ name: 'editor' })
      .onNotification(methods.client.session.update, () => {})
      .onRequest(methods.client.elicitation.create, (ctx) => {
        questions.push(ctx.params.message);
        return { action: 'accept' as const, content: { approach: 'patch' } };
      })
      .connectWith(served.app, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { elicitation: { form: {} } },
        });
        const session = await ctx.request(methods.agent.session.new, {
          cwd: project,
          mcpServers: [],
        });
        return ctx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'fix it' }],
        });
      });

    await served.dispose();

    expect(questions[0]).toContain('Rewrite the module or patch it?');
    expect(answers).toEqual([{ action: 'accept', content: { approach: 'patch' } }]);
  });

  it('cancels the question when the editor never said it could show one', async () => {
    const project = tempDir('handsfree-project-');
    const root = tempDir('handsfree-root-');
    const answers: CreateElicitationResponse[] = [];
    const sub = fakeAgent({
      script: () => [
        {
          do: 'elicit',
          message: 'Rewrite the module or patch it?',
          schema: { type: 'object', properties: { approach: { type: 'string' } } },
          onAnswer: (response) => answers.push(response),
        },
      ],
    });

    const config = ConfigSchema.parse({
      workspaceRoot: root,
      agents: { claude: { command: 'unused' } },
    });
    config.workspaceRoot = root;

    const served = createServeApp(config, {
      llm: scriptedModel([
        JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', prompt: 'Fix the module' } }),
        JSON.stringify({ action: 'answer', message: 'Could not ask.' }),
      ]),
      createTarget: () => sub.target(),
    });

    await client({ name: 'editor' })
      .onNotification(methods.client.session.update, () => {})
      .connectWith(served.app, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await ctx.request(methods.agent.session.new, {
          cwd: project,
          mcpServers: [],
        });
        return ctx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'fix it' }],
        });
      });

    await served.dispose();

    expect(answers).toEqual([{ action: 'cancel' }]);
  });
});
