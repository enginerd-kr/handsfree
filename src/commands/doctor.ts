import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { orchestrationModel, type Config } from '../config/schema.js';
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
  executionAllowed?: boolean;
  executionProblem?: string;
}

/**
 * Adapters live outside this repository and change on their own schedule, so
 * "does it still work" is a first-class command rather than something you find
 * out during a task. Every check is a real ACP handshake: spawn, initialize,
 * read the capabilities back, shut down.
 */
export async function doctor(
  config: Config,
  log: (line: string) => void,
  options: { attachTo?: string } = {},
): Promise<AgentReport[]> {
  // Attached to the same directory a real run would use, so the workspace this
  // prints is the one you would actually get rather than a sandbox nobody asked
  // for. A diagnostic that reports somewhere else is a diagnostic that lies.
  const runtime = createRuntime({
    config,
    llm: undefined,
    ...(options.attachTo === undefined ? {} : { attachTo: options.attachTo }),
  });
  const reports: AgentReport[] = [];

  const orchestration = config.orchestration;
  const planner = orchestrationModel(config);
  log(`handsfree — ACP v${PROTOCOL_VERSION}`);
  log(`workspace ${runtime.workspace.dir}`);
  log(
    orchestration.provider === 'acp'
      ? `orchestration: ${orchestration.acp.agent} over ACP${planner ? ` on ${planner}` : ''}`
      : `orchestration: ${orchestration.local.model} at ${orchestration.local.baseURL}`,
  );
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
        executionAllowed: !runtime.pool.executionProblem(agentId),
        executionProblem: runtime.pool.executionProblem(agentId),
      };
      reports.push(report);
      log(`  ok    ${agentId.padEnd(8)} ${report.detail}`);
      log(`        launch: ${launch}`);
      if (report.executionProblem) log(`        execution blocked: ${report.executionProblem}`);
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
      (caps.terminal ? ' (host-managed)' : ' — no host terminal; native adapter tools may differ'),
  );
  log(
    `  elicitation/create  ${caps.elicitation ? 'yes (form)' : 'no'}` +
      (caps.elicitation ? '' : ' — agents cannot stop and ask you anything'),
  );

  await runtime.close();
  return reports;
}
