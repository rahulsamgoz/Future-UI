/**
 * Next.js demo tests (R2 stream A).
 *
 * Tests render the page component directly (client component — the kernel is
 * created via useMemo inside it); no Next server is involved. The assertions
 * mirror the Vite reference-app suite: chooser renders current data, product
 * clicks flow through the live action binding, the button boundary renders,
 * and the boundary DOM exposes data-ui-entity for capture.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomePage } from "../src/HomePage.js";

beforeEach(() => {
  cleanup();
});

describe("next-demo home page", () => {
  it("renders the product chooser with the demo's own products", async () => {
    render(<HomePage />);
    await waitFor(() => {
      expect(screen.getAllByText("Nimbus Lamp").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Tide Vase").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Slate Clock").length).toBeGreaterThan(0);
  });

  it("exposes data-ui-entity attributes on both registered boundaries", async () => {
    render(<HomePage />);
    await waitFor(() => {
      expect(screen.getAllByText("Nimbus Lamp").length).toBeGreaterThan(0);
    });
    const chooser = document.querySelector('[data-ui-entity="catalog.productChooser"]');
    expect(chooser).not.toBeNull();
    expect(chooser?.getAttribute("data-ui-instance")).toBe("catalog.main");
    expect(document.querySelector('[data-ui-entity="ui.primaryButton"]')).not.toBeNull();
  });

  it("opens the details drawer through the live product.open action", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    const openButtons = await screen.findAllByRole("button", { name: /Nimbus Lamp/i });
    await user.click(openButtons[0]!);
    const drawer = await screen.findByTestId("product-drawer");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.textContent).toContain("Nimbus Lamp");
  });

  it("renders the button boundary and invokes the live ui.action binding", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    const button = await screen.findByRole("button", { name: "Toggle highlights" });
    expect(button.closest('[data-ui-entity="ui.primaryButton"]')).not.toBeNull();
    await user.click(button);
    const notice = await screen.findByTestId("button-notice");
    expect(notice.textContent).toContain("Highlights toggled");
    expect(notice.getAttribute("data-invocations")).toBe("1");
  });
});
