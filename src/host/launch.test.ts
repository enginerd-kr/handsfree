import { describe, expect, it } from 'vitest';
import { AgentProfileSchema } from '../config/schema.js';
import { childEnv } from './launch.js';

const profile = (env: Record<string, string | null> = {}) =>
  AgentProfileSchema.parse({ command: 'agent', env });

describe('childEnv', () => {
  it('passes the parent environment through untouched by default', () => {
    const env = childEnv(profile(), undefined, { HTTPS_PROXY: 'http://proxy.corp:8080', PATH: '/bin' });
    expect(env['HTTPS_PROXY']).toBe('http://proxy.corp:8080');
    expect(env['PATH']).toBe('/bin');
    expect(env['NO_COLOR']).toBe('1');
  });

  it('sets a configured variable under exactly the name it was given', () => {
    const env = childEnv(profile(), { HTTPS_PROXY: 'http://proxy.corp:8080', NODE_EXTRA_CA_CERTS: '/corp.pem' }, {});
    expect(env['HTTPS_PROXY']).toBe('http://proxy.corp:8080');
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/corp.pem');
    // Nothing is renamed or duplicated on the way through.
    expect('https_proxy' in env).toBe(false);
    expect('HTTP_PROXY' in env).toBe(false);
  });

  it('removes a variable the config sets to null', () => {
    // This — not a shell alias — is how "no proxy for the agents" is expressed.
    const env = childEnv(profile(), { HTTPS_PROXY: null, no_proxy: null }, {
      HTTPS_PROXY: 'http://proxy.corp:8080',
      no_proxy: 'localhost',
      PATH: '/bin',
    });
    expect('HTTPS_PROXY' in env).toBe(false);
    expect('no_proxy' in env).toBe(false);
    expect(env['PATH']).toBe('/bin');
  });

  it('lets the profile env win over the config env', () => {
    const env = childEnv(
      profile({ HTTPS_PROXY: 'http://other:3128' }),
      { HTTPS_PROXY: 'http://proxy.corp:8080', https_proxy: 'http://proxy.corp:8080' },
      {},
    );
    expect(env['HTTPS_PROXY']).toBe('http://other:3128');
    expect(env['https_proxy']).toBe('http://proxy.corp:8080');
  });

  it('removes a variable the profile env sets to null', () => {
    const env = childEnv(profile({ HTTPS_PROXY: null }), undefined, {
      HTTPS_PROXY: 'http://proxy.corp:8080',
    });
    expect('HTTPS_PROXY' in env).toBe(false);
  });
});
