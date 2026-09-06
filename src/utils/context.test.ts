import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractTechStackSummary } from './context';

describe('Context Utilities', () => {
  it('should extract key dependencies from current package.json', () => {
    const summary = extractTechStackSummary();
    assert.ok(summary.includes('Tech Stack:'));
    assert.ok(summary.includes('express') || summary.includes('openai') || summary.includes('typescript'));
  });

  it('should return empty string if package.json does not exist in path', () => {
    const summary = extractTechStackSummary('/non-existent-path-12345');
    assert.strictEqual(summary, '');
  });
});
