import { describe, it, expect } from 'vitest';
import { INHERITED_RUN_ENV_KEYS, stripInheritedRunEnv } from './inheritedRunEnv';

describe('stripInheritedRunEnv', () => {
  it('strips both the orch token and the orch token file var', () => {
    expect(INHERITED_RUN_ENV_KEYS).toContain('CYBOFLOW_ORCH_TOKEN');
    expect(INHERITED_RUN_ENV_KEYS).toContain('CYBOFLOW_ORCH_TOKEN_FILE');
    const env: NodeJS.ProcessEnv = {
      CYBOFLOW_ORCH_TOKEN: 't',
      CYBOFLOW_ORCH_TOKEN_FILE: '/f',
      CYBOFLOW_DIR: '/keep',
    };
    stripInheritedRunEnv(env);
    expect(env).toEqual({ CYBOFLOW_DIR: '/keep' });
  });
});
