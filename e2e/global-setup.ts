const BASE_URL = process.env.HANDSFREE_LLM_BASE_URL ?? 'http://localhost:1234/v1';

export default async function setup(): Promise<void> {
  // TUI-only visual runs don't touch the LLM; let them run without an endpoint.
  if (process.env.HANDSFREE_E2E_SKIP_LLM_CHECK === '1') return;
  // The build already ran via the pnpm script; here we just fail fast on the endpoint.
  try {
    const res = await fetch(new URL('models', BASE_URL + '/').toString(), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(
      `E2e needs a live OpenAI-compatible endpoint at ${BASE_URL} (${(err as Error).message}). ` +
        'Start LM Studio (or Ollama) or set HANDSFREE_LLM_BASE_URL / HANDSFREE_LLM_MODEL.',
    );
  }
}
