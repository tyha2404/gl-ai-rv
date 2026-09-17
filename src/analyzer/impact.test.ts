import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { extractModifiedSymbolsFromDiff, ImpactAnalyzer } from "./impact";

describe("ImpactAnalyzer", () => {
  const dummyWorkspace = path.join(__dirname, "../../tmp_impact_test");

  test("should extract function, class and const symbols from git diff hunk", () => {
    const sampleDiff = `
diff --git a/src/services/billing.ts b/src/services/billing.ts
--- a/src/services/billing.ts
+++ b/src/services/billing.ts
@@ -10,3 +10,4 @@
-export function calculateInvoice(orderId: string): number {
+export function calculateInvoice(orderId: string, applyVat: boolean): number {
+export const DEFAULT_TAX_RATE = 0.1;
+export class PaymentGateway {
    `;
    const symbols = extractModifiedSymbolsFromDiff(sampleDiff);
    assert.ok(symbols.includes("calculateInvoice"));
    assert.ok(symbols.includes("DEFAULT_TAX_RATE"));
    assert.ok(symbols.includes("PaymentGateway"));
  });

  test("should search workspace and find caller references across files", async () => {
    if (!fs.existsSync(dummyWorkspace)) {
      fs.mkdirSync(dummyWorkspace, { recursive: true });
    }
    fs.writeFileSync(
      path.join(dummyWorkspace, "service.ts"),
      "export function processPayment() {}",
    );
    fs.writeFileSync(
      path.join(dummyWorkspace, "controller.ts"),
      "import { processPayment } from './service';\nprocessPayment();",
    );

    const analyzer = new ImpactAnalyzer();
    const result = await analyzer.analyzeImpact(
      dummyWorkspace,
      ["processPayment"],
      ["service.ts"],
    );

    assert.strictEqual(result.impactedFiles.length, 1);
    assert.ok(result.impactedFiles[0]?.includes("controller.ts"));
    assert.ok(result.summary.includes("processPayment"));

    // Cleanup
    fs.rmSync(dummyWorkspace, { recursive: true, force: true });
  });
});
