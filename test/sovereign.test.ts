import { describe, it, expect, vi } from 'vitest';
import { 
  auditInfrastructureDrift, 
  rebalanceInfrastructure, 
  getSovereignMetrics 
} from '../src/sovereign-engine';
import * as WiringEngine from '../src/wiring-engine';

vi.mock('../src/wiring-engine', () => ({
  discoverResources: vi.fn(),
  generateWranglerConfig: vi.fn()
}));

describe('Sovereign: Infrastructural Self-Assembly', () => {
  const mockEnv = {};
  const mockCurrentState = new Map<string, Map<string, any>>([
    ['domain:inventory', new Map<string, any>([['status', 'active']])]
  ]);

  it('should detect drift if a domain has no matching D1 substrate', async () => {
    // Mock discoverResources to return NO D1 bindings
    vi.mocked(WiringEngine.discoverResources).mockReturnValue({
      d1: [],
      kv: [],
      vectorize: [],
      ai: false
    });

    const drift = await auditInfrastructureDrift(mockEnv, mockCurrentState);
    expect(drift).toBe(true);
  });

  it('should NOT detect drift if all domains have matching D1 substrate', async () => {
    // Mock discoverResources to return a matching D1 binding
    vi.mocked(WiringEngine.discoverResources).mockReturnValue({
      d1: ['aaronclaw-d1-inventory'],
      kv: [],
      vectorize: [],
      ai: false
    });

    const drift = await auditInfrastructureDrift(mockEnv, mockCurrentState);
    expect(drift).toBe(false);
  });

  it('should trigger rebalancing when drift is detected', async () => {
    vi.mocked(WiringEngine.discoverResources).mockReturnValue({
      d1: [],
      kv: [],
      vectorize: [],
      ai: false
    });

    const result = await rebalanceInfrastructure(mockEnv, mockCurrentState);
    expect(result.status).toBe('rebalancing');
    expect(result.action).toBe('generate-migration-pr');
    expect((result.report as string[])[0]).toContain('Missing substrate for domain: inventory');
  });

  it('should return stable status if no drift is detected', async () => {
    vi.mocked(WiringEngine.discoverResources).mockReturnValue({
      d1: ['aaronclaw-d1-inventory'],
      kv: [],
      vectorize: [],
      ai: false
    });

    const result = await rebalanceInfrastructure(mockEnv, mockCurrentState);
    expect(result.status).toBe('stable');
  });

  it('should calculate sovereign metrics correctly', () => {
    vi.mocked(WiringEngine.discoverResources).mockReturnValue({
      d1: ['d1-1', 'd1-2'],
      kv: ['kv-1'],
      vectorize: [],
      ai: true
    });

    const metrics = getSovereignMetrics(mockEnv, true);
    expect(metrics.nodes).toBe(4); // 2 D1 + 1 KV + 1 Worker
    expect(metrics.unhealthyNodes).toBe(1);
    expect(metrics.driftDetected).toBe(true);
  });
});
