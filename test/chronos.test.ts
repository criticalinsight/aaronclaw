import { describe, it, expect, vi } from 'vitest';
import { resolveFactsAsOf } from '../src/reflection-engine';

describe('Chronos: Temporal Fact Auditing', () => {
  const mockDb = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    all: vi.fn()
  };

  const mockEnv = { AARONDB: mockDb };

  it('should reconstruct state as of a specific timestamp', async () => {
    const timestamp = '2026-03-14T12:00:00Z';
    
    mockDb.all.mockResolvedValueOnce({
      results: [
        {
          entity: 'domain:inventory',
          attribute: 'version',
          value_json: '1',
          operation: 'assert'
        },
        {
          entity: 'domain:inventory',
          attribute: 'status',
          value_json: '"active"',
          operation: 'assert'
        }
      ]
    });

    const state = await resolveFactsAsOf(mockEnv, timestamp);
    
    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('occurred_at_dt <= ?'));
    expect(mockDb.bind).toHaveBeenCalledWith(expect.any(String), timestamp);
    
    const inventory = state.get('domain:inventory');
    expect(inventory?.get('version')).toBe(1);
    expect(inventory?.get('status')).toBe('active');
  });

  it('should handle fact retractions in historical state', async () => {
    mockDb.all.mockResolvedValueOnce({
      results: [
        {
          entity: 'domain:inventory',
          attribute: 'version',
          value_json: '1',
          operation: 'assert'
        },
        {
          entity: 'domain:inventory',
          attribute: 'version',
          value_json: '1',
          operation: 'retract'
        },
        {
          entity: 'domain:inventory',
          attribute: 'version',
          value_json: '2',
          operation: 'assert'
        }
      ]
    });

    const state = await resolveFactsAsOf(mockEnv, 'some-timestamp');
    const inventory = state.get('domain:inventory');
    expect(inventory?.get('version')).toBe(2);
  });
});
