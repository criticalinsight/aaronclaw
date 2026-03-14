import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeHub } from '../src/knowledge-hub';

describe('KnowledgeHub', () => {
  const mockD1 = {
    prepare: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should contribute a pattern correctly', async () => {
    const hub = new KnowledgeHub(mockD1 as any);
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    mockD1.prepare.mockReturnValue(mockStmt);

    const pattern = {
      patternKey: 'test-pattern',
      category: 'test-cat',
      problemStatement: 'test problem',
      proposedAction: 'test action',
      expectedBenefit: 'test benefit',
    };

    await hub.contributePattern(pattern);

    expect(mockD1.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO global_patterns'));
    expect(mockStmt.bind).toHaveBeenCalledWith(
      pattern.patternKey,
      pattern.category,
      pattern.problemStatement,
      pattern.proposedAction,
      pattern.expectedBenefit
    );
  });

  it('should query knowledge correctly', async () => {
    const hub = new KnowledgeHub(mockD1 as any);
    const mockPatterns = [
      { pattern_key: 'p1', category: 'cat1', success_rate: 0.9 },
    ];
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockPatterns }),
    };
    mockD1.prepare.mockReturnValue(mockStmt);

    const results = await hub.queryKnowledge();

    expect(mockD1.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM global_patterns'));
    expect(results).toHaveLength(1);
  });
});
