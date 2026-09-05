import fs from 'node:fs';
import path from 'node:path';
import {
  RequestError,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import type { HostContext } from './context.js';

/**
 * Declaring the filesystem capability is what turns the workspace boundary from
 * a promise into a mechanism: an agent that wants a file asks us for it, and
 * this is the only code that touches the disk on its behalf.
 */
export function createFsHandlers(host: HostContext) {
  return {
    async readTextFile(
      params: ReadTextFileRequest,
      signal?: AbortSignal,
    ): Promise<ReadTextFileResponse> {
      const decision = await host.policy.resolve(
        {
          kind: 'fs.read',
          agentId: host.agentId,
          sessionId: params.sessionId,
          path: params.path,
        },
        { ...(signal ? { signal } : {}) },
      );
      if (decision.verdict === 'deny') {
        throw denied('read', params.path, decision.reason);
      }

      let content: string;
      try {
        content = fs.readFileSync(params.path, 'utf8');
      } catch (err) {
        // A file that is not there yet reads as empty. Agents check for an
        // existing file before creating one, and an error here does not make
        // them careful — it makes them give up on the mediated path and reach
        // for their own shell, which is the one place we cannot see. The write
        // that follows still has to pass the gate, and the record below keeps
        // the leniency from being silent.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw RequestError.internalError(`${params.path}: ${(err as Error).message}`);
        }
        host.transcript.append({
          type: 'note',
          level: 'info',
          text: `read ${host.jail.display(params.path)} — does not exist yet, returned empty`,
        });
        return { content: '' };
      }
      return { content: slice(content, params.line ?? null, params.limit ?? null) };
    },

    async writeTextFile(
      params: WriteTextFileRequest,
      signal?: AbortSignal,
    ): Promise<Record<string, never>> {
      const decision = await host.policy.resolve(
        {
          kind: 'fs.write',
          agentId: host.agentId,
          sessionId: params.sessionId,
          path: params.path,
          bytes: Buffer.byteLength(params.content, 'utf8'),
        },
        { ...(signal ? { signal } : {}) },
      );
      if (decision.verdict === 'deny') {
        throw denied('write', params.path, decision.reason);
      }

      try {
        writeAtomic(params.path, params.content);
      } catch (err) {
        throw RequestError.internalError(`${params.path}: ${(err as Error).message}`);
      }
      host.transcript.append({
        type: 'note',
        level: 'info',
        text: `wrote ${host.jail.display(params.path)}`,
      });
      return {};
    },
  };
}

function denied(action: string, target: string, reason: string | undefined): RequestError {
  // The agent is told plainly that the host refused, so it can adapt instead of
  // retrying the same call or reporting a phantom filesystem error.
  return new RequestError(
    -32000,
    `handsfree denied ${action} of ${target}${reason ? `: ${reason}` : ''}`,
  );
}

/** A write that either lands whole or not at all, even if we are killed mid-way. */
function writeAtomic(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.handsfree-${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, target);
}

export function slice(content: string, line: number | null, limit: number | null): string {
  if (line === null && limit === null) return content;
  const lines = content.split('\n');
  const start = Math.max((line ?? 1) - 1, 0);
  const end = limit === null ? lines.length : start + limit;
  return lines.slice(start, end).join('\n');
}
