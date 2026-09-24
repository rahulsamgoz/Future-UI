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

  it("grounds a screenshot crop through the slot flow and resolve", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ slotId: "slot_1", uploadUrl: "/v1/artifacts/slot_1", expiresAt: "x" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifactId: "art_1", digest: "d" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "resolved", entityId: "e1", entityKey: "catalog.productChooser" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://api.test", "t");
    const result = await client.groundScreenshot("proj_1", new Uint8Array([1, 2, 3]));
    expect(result.status).toBe("resolved");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [slotUrl, slotInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(slotUrl).toBe("http://api.test/v1/projects/proj_1/artifact-uploads");
    expect((slotInit.headers as Record<string, string>).authorization).toBe("Bearer t");
    const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe("http://api.test/v1/artifacts/slot_1");
    expect(putInit.method).toBe("PUT");
    const [resolveUrl, resolveInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(resolveUrl).toBe("http://api.test/v1/projects/proj_1/resolve");
    expect(JSON.parse(resolveInit.body as string).target).toEqual({ kind: "screenshot", artifactId: "art_1" });
  });

  it("maps evidence labels to color-coded chip classes", () => {
    expect(evidenceLabelClass("captured_at_build")).toBe("chip chip-captured");
    expect(evidenceLabelClass("reconstructed_from_commit")).toBe("chip chip-reconstructed");
    expect(evidenceLabelClass("unavailable")).toBe("chip chip-unavailable");
  });
});
