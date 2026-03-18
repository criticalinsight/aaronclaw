import { describe, it, expect, beforeEach } from 'vitest';
import { resolveFactsAsOf } from '../src/reflection-engine';

describe('Subs Onboarding Verification', () => {
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      AARONDB: {
        prepare: (query: string) => ({
          bind: (...args: any[]) => ({
            all: async () => {
              if (query.includes('aarondb_facts')) {
                return {
                  results: [
                    { entity: 'project:subs', attribute: 'type', value_json: '"managed-project"' },
                    { entity: 'project:subs', attribute: 'repoUrl', value_json: '"https://github.com/criticalinsight/subs.git"' }
                  ]
                };
              }
              return { results: [] };
            },
            run: async () => ({ success: true })
          }),
          all: async () => ({ results: [] })
        })
      }
    };
  });

  it('should resolve managed-project status for subs', async () => {
    const timestamp = new Date().toISOString();
    const state = await resolveFactsAsOf(mockEnv, timestamp);
    const project = state.get('project:subs');
    
    expect(project).toBeDefined();
    expect(project?.get('type')).toBe('managed-project');
    expect(project?.get('repoUrl')).toBe('https://github.com/criticalinsight/subs.git');
  });
});
