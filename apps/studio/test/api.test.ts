import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, API_BASE, API_TOKEN, evidenceLabelClass } from "../src/api.js";

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("ApiClient", () => {
  it("builds correct URLs and sends the bearer token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ projects: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://api.test", "token-123");
    await client.listProjects();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/projects");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
  });

  it("encodes history query params", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ observations: [], gaps: [], nextCursor: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://api.test", "t");
    await client.getEntityHistory("proj_1", "catalog.productChooser", { scenario: "catalog-desktop-signed-in", limit: 25 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://api.test/v1/projects/proj_1/entities/catalog.productChooser/history?scenario=catalog-desktop-signed-in&limit=25");
  });

  it("throws with the server-provided message on failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "missing" } }), { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://api.test", "t");
    await expect(client.getProposal("p", "nope")).rejects.toThrow("API 404: missing");
  });

  it("defaults to the documented dev base URL and token", () => {
    expect(API_BASE).toBe("http://localhost:8787");
    expect(API_TOKEN).toBe("dev-token"); // dev profile only
  });

  it("maps evidence labels to color-coded chip classes", () => {
    expect(evidenceLabelClass("captured_at_build")).toBe("chip chip-captured");
    expect(evidenceLabelClass("reconstructed_from_commit")).toBe("chip chip-reconstructed");
    expect(evidenceLabelClass("unavailable")).toBe("chip chip-unavailable");
  });
});
