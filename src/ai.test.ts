import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AIClient } from './ai';

describe('AIClient Multi-Agent Review', () => {
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

  it('should run multi-role reviews and consolidate comments', async () => {
    // Mock OpenAI client
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: async (params: any) => {
            const systemPrompt = params.messages[0].content;
            
            // 1. Lead Consolidator (Check first to avoid substring collision)
            if (systemPrompt.includes('Tech Lead & Lead Reviewer')) {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        summary: 'Phát hiện lỗ hổng bảo mật nghiêm trọng trong module Auth.',
                        verdict: 'REQUEST_CHANGES',
                        riskLevel: 'HIGH',
                        comments: [
                          {
                            path: 'src/auth.ts',
                            line: 12,
                            severity: 'CRITICAL',
                            category: 'SECURITY',
                            text: 'Hardcoded secret token và có thể gây rò rỉ thông tin.',
                            suggestion: 'const token = process.env.TOKEN;',
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }

            // 2. Security Auditor
            if (systemPrompt.includes('AppSec Auditor')) {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        analysis: 'Security scan',
                        comments: [
                          {
                            path: 'src/auth.ts',
                            line: 12,
                            severity: 'CRITICAL',
                            category: 'SECURITY',
                            text: 'Hardcoded secret token',
                            suggestion: 'const token = process.env.TOKEN;',
                          },
                        ],
                      }),
                    },
                  },
                ],
              };
            }

            // 3. Bug Hunter
            if (systemPrompt.includes('Lead QA Automation & Edge-Case Bug Hunter')) {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        analysis: 'Bug hunt',
                        comments: [
                          {
                            path: 'src/auth.ts',
                            line: 12,
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

            // 4. Default for other specialist roles (Clean Code, Performance)
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ analysis: 'Clean', comments: [] }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const ai = new AIClient(mockOpenAI, 'test-model');
    const diffs = [
      {
        new_path: 'src/auth.ts',
        diff: '@@ -10,3 +10,4 @@\n- old\n+ const secret = "123456";\n+ doAuth(secret);',
      },
    ];

    const result = await ai.reviewCode(diffs, {
      title: 'Auth feature',
      author: 'dev',
      repoName: 'my-repo',
      targetBranch: 'main',
    });

    assert.strictEqual(result.verdict, 'REQUEST_CHANGES');
    assert.strictEqual(result.riskLevel, 'HIGH');
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0]?.category, 'SECURITY');
    assert.strictEqual(result.comments[0]?.severity, 'CRITICAL');
  });
});
