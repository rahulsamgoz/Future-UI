/**
 * Semantic rules in the browser (R2 plan part C): a rule created from the
 * editor's Rules tab drives compact buttons on a mobile viewport WITHOUT any
 * explicit preference; an explicit preference overrides the rule; disabling
 * the rule reverts to the contract default.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";

/**
 * jsdom matchMedia stub. The hook subscribes to change events; the tests
 * install the stub before rendering so the viewport class is deterministic.
 */
function installMatchMedia(isMobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: isMobile ? query.includes("max-width") : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  cleanup();
  window.location.hash = "#/";
  installMatchMedia(false);
});

async function openRulesTab(user: ReturnType<typeof userEvent.setup>) {
  const editorOpen = await screen.findByTestId("editor-open", undefined, { timeout: 4000 });
  await user.click(editorOpen);
  await user.click(screen.getByTestId("rules-tab"));
}

async function createMobileCompactRule(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.selectOptions(screen.getByTestId("rule-entity"), "ui.primaryButton");
  await user.selectOptions(screen.getByTestId("rule-representation"), "button.compact@1");
  await user.selectOptions(screen.getByTestId("rule-viewport"), "mobile");
  await user.type(screen.getByTestId("rule-name"), "Compact on mobile");
  await user.click(screen.getByTestId("rule-submit"));
  await waitFor(() => {
    expect(screen.getAllByTestId("rule-item").length).toBe(1);
  });
}

describe("editor rules tab", () => {
  it("lists created rules with conditions and action", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openRulesTab(user);
    expect(screen.getByTestId("rule-create")).toBeTruthy();
    expect(screen.getByTestId("rule-list").textContent).toContain("No rules yet.");
    await createMobileCompactRule(user);
    const item = screen.getByTestId("rule-item");
    expect(item.textContent).toContain("Compact on mobile");
    expect(item.textContent).toContain("mobile viewport");
    expect(item.textContent).toContain("ui.primaryButton");
    expect(item.textContent).toContain("button.compact@1");
    expect(screen.getAllByTestId("rule-delete").length).toBe(1);
  });

  it("deletes a rule from the list", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openRulesTab(user);
    await createMobileCompactRule(user);
    await user.click(screen.getByTestId("rule-delete"));
    await waitFor(() => {
      expect(screen.queryByTestId("rule-item")).toBeNull();
    });
  });
});

describe("rules drive representation resolution", () => {
  it("rule renders compact on mobile without a preference; explicit preference overrides; disable reverts", async () => {
    installMatchMedia(true); // mobile viewport
    const user = userEvent.setup();
    render(<App />);
    await openRulesTab(user);
    await createMobileCompactRule(user);

    // No explicit preference anywhere: the rule alone makes the export
    // button render compact.
    window.location.hash = "#/account";
    await screen.findByTestId("primary-button", undefined, { timeout: 4000 });
    expect(screen.getByTestId("primary-button").className).toContain("compact");

    // Apply an explicit default preference through the editor: the
    // preference wins over the rule.
    await user.click(screen.getByRole("tab", { name: "select" }));
    await user.click(screen.getByTestId("select-mode"));
    await user.click(screen.getByTestId("primary-button"));
    await waitFor(() => expect(screen.getByTestId("generate")).toBeTruthy());
    await user.click(screen.getByTestId("generate"));
    await waitFor(() => expect(screen.getAllByTestId("candidate").length).toBeGreaterThan(0));
    const defaultCandidate = screen
      .getAllByTestId("candidate")
      .find((c) => c.textContent?.includes("button.default@1"));
    expect(defaultCandidate).toBeTruthy();
    await user.click(defaultCandidate!.querySelector<HTMLElement>('[data-testid="accept"]')!);
    await waitFor(() => {
      expect(screen.getByTestId("editor-status").textContent).toContain("Applied button.default@1");
    });
    await waitFor(() => {
      expect(screen.getByTestId("primary-button").className).toContain("default");
    });

    // Undo the preference: the rule takes over again (compact).
    await user.click(screen.getByTestId("undo"));
    await waitFor(() => {
      expect(screen.getByTestId("editor-status").textContent).toContain("Undone");
    });
    await waitFor(() => {
      expect(screen.getByTestId("primary-button").className).toContain("compact");
    });

    // Disable the rule: reverts to the contract default.
    await user.click(screen.getByTestId("rules-tab"));
    await user.click(screen.getByTestId("rule-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("rules-status").textContent).toContain("Rule disabled.");
    });
    await waitFor(() => {
      const button = screen.getByTestId("primary-button");
      expect(button.className).toContain("default");
      expect(button.className).not.toContain("compact");
    });
  });

  it("does not apply a mobile-only rule on the desktop viewport", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openRulesTab(user);
    await createMobileCompactRule(user);

    window.location.hash = "#/account";
    await screen.findByTestId("primary-button", undefined, { timeout: 4000 });
    const button = screen.getByTestId("primary-button");
    expect(button.className).toContain("default");
    expect(button.className).not.toContain("compact");
  });
});
