import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/futures-store", () => ({
  readFuturesSettings: mocks.read,
  writeFuturesSettings: mocks.write,
}));
import { GET, PUT } from "@/app/api/futures/route";
import { configure, fixture, request } from "./helpers";
function setup() {
  const f = fixture("binance");
  configure({
    ...f,
    users: f.users.map((u) => ({ ...u, role: u.username === "alice" ? "admin" : "viewer" })),
  });
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("futures settings authorization", () => {
  it("rejects anonymous and viewer access", async () => {
    setup();
    expect((await GET(new Request("https://portal.test/api/futures"))).status).toBe(401);
    expect((await GET(request("/api/futures", "bob"))).status).toBe(403);
    expect(
      (
        await PUT(
          request("/api/futures", "bob", {
            method: "PUT",
            body: "{}",
            headers: { "x-role": "admin" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("writes only the selected account and actor with no trading operation", async () => {
    setup();
    mocks.write.mockResolvedValue({ netTransfer: "150", revision: "saved" });
    const response = await PUT(
      request("/api/futures?accountId=bob-account", "alice", {
        method: "PUT",
        body: JSON.stringify({ netTransfer: "150", revision: null }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.write.mock.calls[0][0].ACCOUNT_ID).toBe("bob-account");
    expect(mocks.write.mock.calls[0].slice(1)).toEqual(["150", null, "alice"]);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects invalid input and cross-origin writes", async () => {
    setup();
    const req = request("/api/futures", "alice", { method: "PUT" });
    req.headers.delete("origin");
    expect((await PUT(req)).status).toBe(403);
    for (const netTransfer of ["NaN", "1e999", 150, "", "1.12345678901234567"]) {
      expect(
        (
          await PUT(
            request("/api/futures", "alice", {
              method: "PUT",
              body: JSON.stringify({ netTransfer, revision: null }),
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (await PUT(request("/api/futures?accountId=missing", "alice", { method: "PUT", body: "{}" })))
        .status,
    ).toBe(404);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
