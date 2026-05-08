import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { discoverPolymarketProxy } from "../proxy-discovery.js";

const EOA = "0x7b2d23fd477bbC52D98620cD36e2EAa470e0fC8C";
const PROXY = "0x08e4282014bd434b83999f119b9c94860596fc4e";

const realFetch = globalThis.fetch;

function mockFetch(html: string, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    text: vi.fn().mockResolvedValue(html),
  }) as unknown as typeof fetch;
}

describe("discoverPolymarketProxy", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the proxy address when SSR JSON exposes one different from the EOA", async () => {
    mockFetch(
      `<html>...,"proxyAddress":"${PROXY}","baseAddress":"${PROXY}",...</html>`,
    );
    const result = await discoverPolymarketProxy(EOA);
    expect(result.proxyAddress).toBe(PROXY);
    expect(result.signatureType).toBe("gnosis-safe");
  });

  it("falls back to undefined/eoa when the page echoes the EOA back (no migration)", async () => {
    mockFetch(`<html>"proxyAddress":"${EOA}"</html>`);
    const result = await discoverPolymarketProxy(EOA);
    expect(result.proxyAddress).toBeUndefined();
    expect(result.signatureType).toBe("eoa");
  });

  it("falls back when the response has no proxyAddress field", async () => {
    mockFetch("<html>nothing here</html>");
    const result = await discoverPolymarketProxy(EOA);
    expect(result.proxyAddress).toBeUndefined();
  });

  it("falls back on non-OK HTTP responses", async () => {
    mockFetch("404 page not found", false);
    const result = await discoverPolymarketProxy(EOA);
    expect(result.proxyAddress).toBeUndefined();
  });

  it("rejects malformed EOA without making a network call", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await discoverPolymarketProxy("not-an-address");
    expect(result.proxyAddress).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles backslash-escaped JSON inside the SSR payload", async () => {
    mockFetch(
      `<script>self.__next={"proxyAddress\\":\\"${PROXY}\\""}</script>`,
    );
    const result = await discoverPolymarketProxy(EOA);
    expect(result.proxyAddress).toBe(PROXY);
  });
});
