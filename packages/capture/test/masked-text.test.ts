// @vitest-environment jsdom
/**
 * Masking correctness (audit defect 2): a mask on a CHILD element must not
 * leak the child's private text through the PARENT boundary's visibleText.
 * collectEntitiesInPage normally runs inside page.evaluate; it is a pure
 * function over `document`, so jsdom exercises the same body here.
 */
import { describe, expect, it } from "vitest";
import { collectEntitiesInPage } from "../src/scenario-runner.js";

function mount(html: string): void {
  document.body.innerHTML = html;
}

function textFor(anchor: string): string {
  const evaluation = collectEntitiesInPage([".private"]);
  const match = evaluation.find((e) => e.anchor === anchor);
  expect(match, `boundary ${anchor} not found`).toBeDefined();
  return match!.visibleText;
}

describe("collectEntitiesInPage masking", () => {
  it("excludes masked child text from the parent boundary's visibleText", () => {
    mount(`
      <div data-ui-entity="checkout.summary">
        <span>Total $10.00</span>
        <span class="private">user@example.com</span>
      </div>
    `);
    const visibleText = textFor("checkout.summary");
    expect(visibleText).not.toContain("user@example.com");
    expect(visibleText).toContain("Total $10.00");
  });

  it("reports [REDACTED] when a boundary's entire text is masked", () => {
    mount(`
      <div data-ui-entity="account.recoveryCodes">
        <span class="private">1234-5678-9012</span>
      </div>
    `);
    expect(textFor("account.recoveryCodes")).toBe("[REDACTED]");
  });

  it("redacts a masked boundary itself", () => {
    mount(`
      <div data-ui-entity="account.apiKey" class="private">sk-live-abcdef123456</div>
    `);
    expect(textFor("account.apiKey")).toBe("[REDACTED]");
  });

  it("redacts a masked boundary nested under an unmasked parent", () => {
    mount(`
      <div data-ui-entity="app.page">
        <div data-ui-entity="account.profile" class="private">Jane Doe</div>
        <span>Public header</span>
      </div>
    `);
    expect(textFor("account.profile")).toBe("[REDACTED]");
    expect(textFor("app.page")).not.toContain("Jane Doe");
    expect(textFor("app.page")).toContain("Public header");
  });

  it("keeps text unchanged when no mask matches", () => {
    mount(`
      <div data-ui-entity="catalog.heading">
        <h1>Autumn catalog</h1>
      </div>
    `);
    expect(textFor("catalog.heading")).toBe("Autumn catalog");
  });

  it("leaves a boundary with no text and no masked content empty (not [REDACTED])", () => {
    mount(`
      <div data-ui-entity="app.iconButton">
        <svg width="10" height="10"></svg>
      </div>
    `);
    expect(textFor("app.iconButton")).toBe("");
  });

  it("is deterministic across repeated evaluations", () => {
    mount(`
      <div data-ui-entity="checkout.summary">
        <span>Subtotal $8.00</span>
        <span class="private">4242 4242 4242 4242</span>
        <span>Tax $2.00</span>
      </div>
    `);
    const first = collectEntitiesInPage([".private"]).find((e) => e.anchor === "checkout.summary")!.visibleText;
    const second = collectEntitiesInPage([".private"]).find((e) => e.anchor === "checkout.summary")!.visibleText;
    expect(first).toBe(second);
    expect(first).not.toContain("4242");
    expect(first).toContain("Subtotal $8.00");
    expect(first).toContain("Tax $2.00");
  });
});
