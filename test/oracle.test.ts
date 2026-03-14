import { describe, it, expect } from 'vitest';
import { 
  projectVirtualState, 
  calculateVirtualComplection, 
  simulateDomainSynthesis 
} from '../src/oracle-engine';

describe('Oracle: Predictive Simulation', () => {
  const mockCurrentState = new Map<string, Map<string, any>>([
    ['domain:inventory', new Map<string, any>([['status', 'active'], ['version', 1]])]
  ]);

  it('should project virtual state correctly', () => {
    const changes = [
      { entity: 'domain:inventory', attribute: 'status', value: 'simulated' },
      { entity: 'domain:finance', attribute: 'status', value: 'proposed' }
    ];

    const virtual = projectVirtualState(mockCurrentState, changes);
    
    expect(virtual.get('domain:inventory')?.get('status')).toBe('simulated');
    expect(virtual.get('domain:inventory')?.get('version')).toBe(1);
    expect(virtual.get('domain:finance')?.get('status')).toBe('proposed');
    // Ensure original state is untouched (immutability)
    expect(mockCurrentState.get('domain:inventory')?.get('status')).toBe('active');
  });

  it('should calculate virtual complection based on coupling', () => {
    const coupledState = new Map<string, Map<string, any>>([
      ['domain:inventory', new Map<string, any>([['refs', 'domain:finance']])],
      ['domain:finance', new Map<string, any>([['status', 'active']])]
    ]);

    const score = calculateVirtualComplection(coupledState);
    // 15 for coupling + (2 * 2 attributes) = 19
    expect(score).toBe(19);
  });

  it('should return a reject verdict for extreme complection increases', async () => {
    // Current state is simple
    const state = new Map([['domain:core', new Map([['status', 'active']]) ]]);
    
    // Propose an extremely complex domain (mocked in simulateDomainSynthesis)
    // For test purposes, let's just assert the logic in simulateDomainSynthesis
    const declaration = { 
      domain: 'extreme-chaos',
      // The heuristic in calculateVirtualComplection will see strings and count attributes
      // 150+ delta triggers reject.
      // Let's create enough attributes to spike breadth.
      attributes: Array.from({length: 200}, (_, i) => ({ name: `attr${i}`, type: 'string' }))
    };

    const result = await simulateDomainSynthesis(state, declaration);
    expect(result.verdict).toBe('reject');
    expect(result.riskAssessment).toContain('threshold exceeded');
  });
});
