import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadFile = vi.hoisted(() => vi.fn());
const mockHomedir = vi.hoisted(() => vi.fn(() => "/mock-home"));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import {
  callSidecar,
  SidecarNotRunningError,
  SidecarRequestError,
} from "../sidecar.js";

const mockFetch = vi.fn();

const VALID_LOCK = JSON.stringify({
  port: 3847,
  pid: 12345,
  accessToken: "test-token-abc",
});

describe("callSidecar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockHomedir.mockReturnValue("/mock-home");
    vi.stubGlobal("fetch", mockFetch);
  });

  it("reads lock file, POSTs to sidecar, returns parsed response", async () => {
    mockReadFile.mockResolvedValue(VALID_LOCK);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candles: [{ open: 0.5 }] }),
    });

    const result = await callSidecar<{ candles: Array<{ open: number }> }>(
      "fetchOHLCV",
      ["token123", { timeframe: "1h" }],
    );

    expect(mockReadFile).toHaveBeenCalledWith(
      "/mock-home/.pmxt/server.lock",
      "utf-8",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3847/api/polymarket/fetchOHLCV",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pmxt-access-token": "test-token-abc",
        },
        body: JSON.stringify({ args: ["token123", { timeframe: "1h" }] }),
      }),
    );
    expect(result).toEqual({ candles: [{ open: 0.5 }] });
  });

  it("forwards arbitrary args array to sidecar body", async () => {
    mockReadFile.mockResolvedValue(VALID_LOCK);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bids: [], asks: [] }),
    });

    await callSidecar("watchOrderBook", ["outcome-abc"]);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3847/api/polymarket/watchOrderBook",
      expect.objectContaining({
        body: JSON.stringify({ args: ["outcome-abc"] }),
      }),
    );
  });

  it("throws SidecarNotRunningError when lock file is missing", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    mockReadFile.mockRejectedValue(enoent);

    await expect(callSidecar("fetchOHLCV", [])).rejects.toThrow(
      SidecarNotRunningError,
    );
    await expect(callSidecar("fetchOHLCV", [])).rejects.toThrow(
      /lock file not found/,
    );
  });

  it("preserves original error as cause in SidecarNotRunningError", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    mockReadFile.mockRejectedValue(enoent);

    const err = await callSidecar("fetchOHLCV", []).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SidecarNotRunningError);
    expect((err as SidecarNotRunningError).cause).toBe(enoent);
  });

  it("throws SyntaxError when lock file contains invalid JSON", async () => {
    mockReadFile.mockResolvedValue("not valid json {{{");

    await expect(callSidecar("fetchOHLCV", [])).rejects.toThrow(SyntaxError);
  });

  it("throws when lock file is missing port field", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ accessToken: "token" }),
    );

    await expect(callSidecar("fetchOHLCV", [])).rejects.toThrow(
      /missing port or accessToken/,
    );
  });

  it("throws when lock file is missing accessToken field", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 3847 }));

    await expect(callSidecar("fetchOHLCV", [])).rejects.toThrow(
      /missing port or accessToken/,
    );
  });

  it("throws SidecarRequestError on non-OK HTTP response", async () => {
    mockReadFile.mockResolvedValue(VALID_LOCK);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const err = await callSidecar("fetchOHLCV", []).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SidecarRequestError);
    expect((err as SidecarRequestError).status).toBe(401);
    expect((err as SidecarRequestError).method).toBe("fetchOHLCV");
    expect((err as SidecarRequestError).message).toMatch(/401/);
    expect((err as SidecarRequestError).message).toMatch(/Unauthorized/);
  });

  it("throws SidecarRequestError with 500 status and error body", async () => {
    mockReadFile.mockResolvedValue(VALID_LOCK);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const err = await callSidecar("watchTrades", []).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SidecarRequestError);
    expect((err as SidecarRequestError).status).toBe(500);
    expect((err as SidecarRequestError).method).toBe("watchTrades");
  });

  it("propagates network errors from fetch", async () => {
    mockReadFile.mockResolvedValue(VALID_LOCK);
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    await expect(callSidecar("fetchOHLCV", [])).rejects.toThrow(TypeError);
    await expect(callSidecar("fetchOHLCV", [])).rejects.toThrow(
      "fetch failed",
    );
  });
});

describe("getSidecarCapabilities", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockHomedir.mockReturnValue("/mock-home");
    vi.stubGlobal("fetch", mockFetch);
    mockReadFile.mockResolvedValue(VALID_LOCK);
  });

  it("returns supportsTif=true when the sidecar advertises it", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { supportsTif: true } }),
    });
    const { getSidecarCapabilities } = await import("../sidecar.js");
    const caps = await getSidecarCapabilities();
    expect(caps.supportsTif).toBe(true);
  });

  it("treats 'Method not found' as supportsTif=true (pmxt-core defaults to GTC)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 200,
      text: () =>
        Promise.resolve(
          '{"success":false,"error":"Method \'getCapabilities\' not found on polymarket"}',
        ),
    });
    const { getSidecarCapabilities } = await import("../sidecar.js");
    const caps = await getSidecarCapabilities();
    expect(caps.supportsTif).toBe(true);
  });

  it("returns supportsTif=false on other sidecar request errors", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("internal server error"),
    });
    const { getSidecarCapabilities } = await import("../sidecar.js");
    const caps = await getSidecarCapabilities();
    expect(caps.supportsTif).toBe(false);
  });
});
