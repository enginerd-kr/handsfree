import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Config } from '../config/schema.js';
import { createRuntime } from '../runtime.js';

export interface AgentReport {
  agentId: string;
  ok: boolean;
  launch: string;
  detail: string;
  protocolVersion?: number;
  loadSession?: boolean;
  promptCapabilities?: string[];
  authMethods?: string[];
}

/**
 * Adapters live outside this repository and change on their own schedule, so
 * "does it still work" is a first-class command rather than something you find
 * out during a task. Every check is a real ACP handshake: spawn, initialize,
 * read the capabilities back, shut down.
 */
export async function doctor(config: Config, log: (line: string) => void): Promise<AgentReport[]> {
  const runtime = createRuntime({ config, llm: undefined });
  const reports: AgentReport[] = [];

  log(`handsfree — ACP v${PROTOCOL_VERSION}`);
  log(`workspace ${runtime.workspace.dir}`);
  log('');

  for (const agentId of runtime.pool.available()) {
    const profile = config.agents[agentId]!;
    const launch = [profile.command, ...profile.args].join(' ');
    try {
      const connection = await runtime.pool.connection(agentId);
      const prompt = connection.capabilities.promptCapabilities ?? {};
      const report: AgentReport = {
        agentId,
        ok: true,
        launch,
        detail: connection.description,
        protocolVersion: PROTOCOL_VERSION,
        loadSession: connection.capabilities.loadSession === true,
        promptCapabilities: Object.entries(prompt)
          .filter(([, enabled]) => enabled === true)
          .map(([name]) => name),
        authMethods: connection.authMethods.map((method) => method.name || method.id),
      };
      reports.push(report);
      log(`  ok    ${agentId.padEnd(8)} ${report.detail}`);
      log(`        launch: ${launch}`);
      log(`        resume: ${report.loadSession ? 'session/load' : 'not supported'}`);
      if (report.promptCapabilities && report.promptCapabilities.length > 0) {
        log(`        prompt: ${report.promptCapabilities.join(', ')}`);
      }
      if (report.authMethods && report.authMethods.length > 0) {
        log(`        auth:   ${report.authMethods.join(', ')}`);
      }
    } catch (err) {
      reports.push({ agentId, ok: false, launch, detail: (err as Error).message });
      log(`  FAIL  ${agentId.padEnd(8)} ${(err as Error).message}`);
      log(`        launch: ${launch}`);
    }
    log('');
  }

  const caps = config.capabilities;
  log('handsfree provides:');
  log(`  fs/read_text_file   ${caps.readTextFile ? 'yes' : 'no'}`);
  log(`  fs/write_text_file  ${caps.writeTextFile ? 'yes' : 'no'}`);
  log(
    `  terminal/*          ${caps.terminal ? 'yes' : 'no'}` +
      (caps.terminal ? ` (${config.policy.exec.mode})` : ' — agents cannot run commands'),
  );

  await runtime.close();
  return reports;
}
