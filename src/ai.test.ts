import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AIClient } from './ai';

describe('AIClient Review Strategies', () => {
  it('should clean JSON response with code blocks or surrounding text', () => {
    const ai = new AIClient({} as any, 'mock-model');
    const input1 = '```json\n{"summary": "ok", "comments": []}\n```';
    assert.strictEqual(ai.cleanJsonResponse(input1), '{"summary": "ok", "comments": []}');

    const input2 = 'Here is your json:\n{"summary": "ok"}\nHope this helps!';
    assert.strictEqual(ai.cleanJsonResponse(input2), '{"summary": "ok"}');
  });

  it('should return APPROVE directly when diffs are empty', async () => {
    const ai = new AIClient({} as any, 'mock-model');
    const result = await ai.reviewCode([]);
    assert.strictEqual(result.verdict, 'APPROVE');
    assert.strictEqual(result.riskLevel, 'LOW');
    assert.strictEqual(result.comments.length, 0);
  });

  it('should support UNIFIED mode in 1 single request', async () => {
    let callCount = 0;
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: async () => {
            callCount++;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Phát hiện lỗ hổng SQL Injection và N+1 query.',
                      verdict: 'REQUEST_CHANGES',
                      riskLevel: 'HIGH',
                      comments: [
                        {
                          path: 'src/user.ts',
                          line: 25,
                          severity: 'CRITICAL',
                          category: 'SECURITY',
                          text: 'SQL Injection qua biến id',
                          suggestion: 'db.query("SELECT * FROM users WHERE id = $1", [id])',
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const ai = new AIClient(mockOpenAI, 'test-model', 'unified');
    const diffs = [
      {
        new_path: 'src/user.ts',
        diff: '@@ -20,3 +20,4 @@\n- old\n+ const sql = "SELECT * FROM users WHERE id = " + id;\n+ db.query(sql);',
      },
    ];

    const result = await ai.reviewCode(diffs, {
      title: 'User query fix',
      author: 'dev',
      repoName: 'my-service',
      targetBranch: 'main',
    });

    assert.strictEqual(callCount, 1); // Exactly 1 request!
    assert.strictEqual(result.verdict, 'REQUEST_CHANGES');
    assert.strictEqual(result.riskLevel, 'HIGH');
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0]?.category, 'SECURITY');
  });

  it('should support MULTI_AGENT mode with multiple roles', async () => {
    let callCount = 0;
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: async (params: any) => {
            callCount++;
            const systemPrompt = params.messages[0].content;

            if (systemPrompt.includes('Tech Lead & Lead Reviewer')) {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        summary: 'MR có vấn đề cần xử lý.',
                        verdict: 'COMMENT',
                        riskLevel: 'MEDIUM',
                        comments: [
                          {
                            path: 'src/auth.ts',
                            line: 10,
                            severity: 'WARNING',
                            category: 'BUG',
                            text: 'Possible null dereference',
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }

            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      analysis: 'Role check',
                      comments: [
                        {
                          path: 'src/auth.ts',
                          line: 10,
                          severity: 'WARNING',
                          category: 'BUG',
                          text: 'Possible null dereference',
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const ai = new AIClient(mockOpenAI, 'test-model', 'multi_agent');
    const diffs = [
      {
        new_path: 'src/auth.ts',
        diff: '@@ -1,3 +1,3 @@\n- a\n+ b',
      },
    ];

    const result = await ai.reviewCode(diffs, {
      title: 'Bug fix',
      author: 'dev',
      repoName: 'my-service',
      targetBranch: 'main',
    });

    assert.strictEqual(callCount, 5); // 4 roles + 1 lead
    assert.strictEqual(result.verdict, 'COMMENT');
    assert.strictEqual(result.riskLevel, 'MEDIUM');
  });
});
