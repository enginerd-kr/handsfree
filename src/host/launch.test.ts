import { describe, expect, it } from 'vitest';
import { AgentProfileSchema, ProxySchema } from '../config/schema.js';
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

  it('sets both spellings of a configured proxy variable', () => {
    const env = childEnv(profile(), ProxySchema.parse({ https: 'http://proxy.corp:8080' }), {});
    expect(env['HTTPS_PROXY']).toBe('http://proxy.corp:8080');
    expect(env['https_proxy']).toBe('http://proxy.corp:8080');
    // Keys the config does not mention stay inherited, i.e. absent here.
    expect('HTTP_PROXY' in env).toBe(false);
  });

  it('removes both spellings when the config says ""', () => {
    // This — not a shell alias — is how "no proxy for the agents" is expressed.
    const env = childEnv(profile(), ProxySchema.parse({ https: '', noProxy: '' }), {
      HTTPS_PROXY: 'http://proxy.corp:8080',
      https_proxy: 'http://proxy.corp:8080',
      no_proxy: 'localhost',
    });
    expect('HTTPS_PROXY' in env).toBe(false);
    expect('https_proxy' in env).toBe(false);
    expect('no_proxy' in env).toBe(false);
  });

  it('lets the profile env win over the proxy block', () => {
    const env = childEnv(
      profile({ HTTPS_PROXY: 'http://other:3128' }),
      ProxySchema.parse({ https: 'http://proxy.corp:8080' }),
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
