/**
 * History console component tests. Written with createElement (no JSX) so
 * the file matches the root vitest include pattern for apps (dot-test.ts)
 * while still exercising React rendering in jsdom.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HistoryConsole } from "../src/pages/HistoryConsole.js";
import type { HistoryPageDto, RuntimeManifest } from "../src/api.js";

// jsdom lacks createObjectURL; the compare view relies on it.
if (typeof URL.createObjectURL !== "function") {
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
}

// React 18+ act() environment flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: RuntimeManifest = {
  protocolVersion: 1,
  rendererVersions: {},
  entities: [
    { entityKey: "catalog.productChooser", contractVersion: 1, allowedRepresentations: ["grid@1"], dataBinding: "b", actions: [] },
    { entityKey: "account.profileForm", contractVersion: 1, allowedRepresentations: ["form@1"], dataBinding: "b", actions: [] },
  ],
  pages: [],
  buildId: "b",
  contractDigest: "c",
};

const historyPage: HistoryPageDto = {
  observations: [
    {
      occurrenceId: "occ_1",
      captureId: "cap_1",
      commitSha: "abcdef1234567890",
      capturedAt: "2026-01-15T10:00:00.000Z",
      scenarioId: "catalog-desktop-signed-in",
      evidenceLabel: "captured_at_build",
      anchor: "catalog.productChooser",
      visibleText: "product chooser",
      completeness: "complete-for-scenario",
      screenshotArtifactId: "art_1",
      summary: "catalog.productChooser: product chooser",
    },
    {
      occurrenceId: "occ_2",
      captureId: "cap_2",
      commitSha: "123456abcdef7890",
      capturedAt: "2026-02-15T10:00:00.000Z",
      scenarioId: "catalog-mobile-guest",
      evidenceLabel: "reconstructed_from_commit",
      anchor: "catalog.productChooser",
      visibleText: "product chooser (rebuilt)",
      completeness: "partial",
      summary: "catalog.productChooser: product chooser (rebuilt)",
    },
  ],
  gaps: [{ scenarioId: "account-desktop-signed-in", kind: "not_captured", reason: "no captures for this scenario" }],
  nextCursor: null,
};

const client = {
  getRuntimeManifest: vi.fn(async () => manifest),
  getEntityHistory: vi.fn(async () => historyPage),
  fetchArtifactBlob: vi.fn(async () => new Blob(["png-bytes"], { type: "image/png" })),
} as unknown as import("../src/api.js").ApiClient;

describe("HistoryConsole", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    vi.restoreAllMocks();
  });

  function renderPage(): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(HistoryConsole, { client, projectId: "proj_1" }));
    });
  }

  it("renders observations with evidence chips, commits, and dates", async () => {
    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const chips = container!.querySelectorAll(".chip-captured, .chip-reconstructed");
    expect(chips.length).toBe(2);
    expect(container!.textContent).toContain("abcdef12"); // commit sha prefix
    expect(container!.textContent).toContain("catalog-desktop-signed-in");
    expect(container!.textContent).toContain("not_captured"); // coverage gap kind
  });

  it("selects two captures for the side-by-side compare view", async () => {
    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const buttons = [...container!.querySelectorAll<HTMLButtonElement>(".compare-toggle")];
    expect(buttons.length).toBe(2);

    await act(async () => {
      buttons[0]!.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons[1]!.click();
      await Promise.resolve();
    });

    const heading = [...container!.querySelectorAll("h2")].find((h) => h.textContent!.includes("Side-by-side"));
    expect(heading!.textContent).toContain("(2/2 selected)");
    expect(container!.querySelectorAll(".compare-pane").length).toBe(2);
    expect(client.fetchArtifactBlob).toHaveBeenCalledWith("art_1");
  });

  it("deselects a capture when clicked twice", async () => {
    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const button = container!.querySelector<HTMLButtonElement>(".compare-toggle")!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    const heading = [...container!.querySelectorAll("h2")].find((h) => h.textContent!.includes("Side-by-side"));
    expect(heading!.textContent).toContain("(0/2 selected)");
  });
});
