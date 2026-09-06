import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isIgnoredFile,
  filterDiffs,
  formatSingleFileDiff,
  chunkDiffs,
  GitLabDiffItem,
} from './diff';

describe('Diff Utilities', () => {
  describe('isIgnoredFile & filterDiffs', () => {
    it('should ignore package-lock.json and image assets', () => {
      assert.strictEqual(isIgnoredFile('package-lock.json'), true);
      assert.strictEqual(isIgnoredFile('src/assets/logo.png'), true);
      assert.strictEqual(isIgnoredFile('dist/bundle.js'), true);
      assert.strictEqual(isIgnoredFile('src/auth.ts'), false);
    });

    it('should filter out ignored and deleted files', () => {
      const diffs: GitLabDiffItem[] = [
        { new_path: 'package-lock.json', diff: '@@ -1,1 +1,1 @@' },
        { new_path: 'src/app.ts', diff: '@@ -1,2 +1,3 @@' },
        { old_path: 'src/deleted.ts', deleted_file: true },
        { new_path: 'assets/image.svg', diff: '@@ -1,1 +1,1 @@' },
      ];

      const filtered = filterDiffs(diffs);
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0]?.new_path, 'src/app.ts');
    });
  });

  describe('formatSingleFileDiff', () => {
    it('should format hunk with correct new line numbers', () => {
      const diff: GitLabDiffItem = {
        new_path: 'src/math.ts',
        diff: `@@ -10,3 +15,4 @@
 function add(a, b) {
-  return a - b;
+  // add two numbers
+  return a + b;
 }`,
      };

      const result = formatSingleFileDiff(diff);
      assert.ok(result.formattedDiff.includes('=== FILE: src/math.ts ==='));
      assert.ok(result.formattedDiff.includes('Line 15:   function add(a, b) {'));
      assert.ok(result.formattedDiff.includes('Line 16: +   // add two numbers'));
      assert.ok(result.formattedDiff.includes('Line 17: +   return a + b;'));
      assert.ok(result.formattedDiff.includes('Line 18:   }'));
    });

    it('should truncate diff if it exceeds maxLinesPerFile', () => {
      const longLines = Array.from({ length: 50 }, (_, i) => `+const x_${i} = ${i};`).join('\n');
      const diff: GitLabDiffItem = {
        new_path: 'src/long.ts',
        diff: `@@ -1,1 +1,50 @@\n${longLines}`,
      };

      const result = formatSingleFileDiff(diff, 10);
      assert.ok(result.formattedDiff.includes('CẮT BỚT'));
      assert.ok(result.lineCount <= 12);
    });
  });

  describe('chunkDiffs', () => {
    it('should group files into batches based on lines and count limits', () => {
      const diffs: GitLabDiffItem[] = [
        {
          new_path: 'src/file1.ts',
          diff: '@@ -1,1 +1,5 @@\n+line1\n+line2\n+line3\n+line4\n+line5',
        },
        {
          new_path: 'src/file2.ts',
          diff: '@@ -1,1 +1,5 @@\n+line1\n+line2\n+line3\n+line4\n+line5',
        },
        {
          new_path: 'src/file3.ts',
          diff: '@@ -1,1 +1,5 @@\n+line1\n+line2\n+line3\n+line4\n+line5',
        },
      ];

      // Max 8 lines per batch -> each file has ~7 formatted lines, so should produce 3 batches
      const batches = chunkDiffs(diffs, 8, 5);
      assert.strictEqual(batches.length, 3);
      assert.strictEqual(batches[0]?.batchIndex, 1);
      assert.strictEqual(batches[0]?.totalBatches, 3);
      assert.strictEqual(batches[0]?.files.length, 1);
      assert.strictEqual(batches[0]?.files[0]?.filePath, 'src/file1.ts');
    });

    it('should return empty array if no valid diffs exist', () => {
      const diffs: GitLabDiffItem[] = [
        { new_path: 'package-lock.json', diff: 'some lock diff' },
      ];
      const batches = chunkDiffs(diffs);
      assert.strictEqual(batches.length, 0);
    });
  });
});
