import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/[resource]/route";
import { POST } from "@/app/api/sync/route";
import { GET as cron } from "@/app/api/cron/route";
import { POST as login, DELETE as logout, GET as session } from "@/app/api/session/route";
import { configure, fixture, request, password } from "./helpers";
import { createSession } from "@/lib/auth";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const context = (resource: string) => ({ params: Promise.resolve({ resource }) });
describe("per-user monitoring API", () => {
  it("does not allow unauthenticated access to any account resource", async () => {
    configure();
    for (const resource of [
      "dashboard",
      "holdings",
      "pnl",
      "trades",
      "orders",
      "history",
      "connection",
    ]) {
      expect(
        (await GET(new Request(`https://portal.test/api/${resource}`), context(resource))).status,
      ).toBe(401);
    }
    expect(
      (
        await POST(
          new Request("https://portal.test/api/sync", {
            method: "POST",
            headers: { origin: "https://portal.test" },
          }),
        )
      ).status,
    ).toBe(401);
  });
  it("binds account access to the signed user, ignoring spoofed account parameters", async () => {
    configure();
    for (const username of ["alice", "bob"]) {
      const r = await GET(
        request(
          `/api/dashboard?accountId=${username === "alice" ? "bob-account" : "alice-account"}`,
          username,
          { headers: { "x-account-id": "bob-account" } },
        ),
        context("dashboard"),
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toContain("no-store");
      const body = await r.text();
      const data = JSON.parse(body);
      expect(data.accountLabel).toBe(username === "alice" ? "Alice 现货" : "Bob 现货");
      expect(body).not.toContain("alice-secret");
      expect(body).not.toContain("bob-key");
      expect(body).not.toContain("passwordHash");
      expect(body).not.toContain("sessionSecret");
    }
  });
  it("uses separate upstream keys and balances for concurrent users", async () => {
    configure(fixture("binance"));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const path = new URL(input).pathname;
        const key = (init.headers as Record<string, string>)["X-MBX-APIKEY"];
        if (key) calls.push(key);
        if (path.endsWith("time")) return Response.json({ serverTime: Date.now() });
        if (path.endsWith("account"))
          return Response.json({
            balances: [{ asset: "USDT", free: key === "alice-key" ? "101" : "202", locked: "0" }],
          });
        return Response.json([]);
      }),
    );
    const responses = await Promise.all([
      GET(request("/api/dashboard", "alice"), context("dashboard")),
      GET(request("/api/dashboard", "bob"), context("dashboard")),
    ]);
    expect((await responses[0].json()).summary.equity).toBe("101");
    expect((await responses[1].json()).summary.equity).toBe("202");
    expect(calls).toContain("alice-key");
    expect(calls).toContain("bob-key");
  });

  it("routes futures trade queries to the signed futures API preserving 64-bit IDs", async () => {
    configure(fixture("binance"));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const u = new URL(input);
        calls.push(u.pathname);
        expect(u.hostname).toBe("fapi.binance.com");
        if (u.pathname.endsWith("time")) return Response.json({ serverTime: Date.now() });
        expect((init.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe("alice-key");
        expect(u.searchParams.get("fromId")).toBe("9007199254740993");
        return new Response(
          '[{"id":9007199254740993,"symbol":"PONSUSDT","side":"SELL","price":"0.3","qty":"5","quoteQty":"1.5","commission":"0.001","commissionAsset":"USDT","time":1234,"maker":false,"realizedPnl":"0.1"}]',
        );
      }),
    );
    const response = await GET(
      request(
        "/api/trades?market=futures&symbol=PONSUSDT&fromId=9007199254740993&limit=1",
        "alice",
      ),
      context("trades"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0]).toMatchObject({
      instrument: "futures",
      id: "9007199254740993",
      realizedPnl: "0.1",
      fee: "0.001",
    });
    expect(body.nextFromId).toBe("9007199254740994");
    expect(calls).toEqual(["/fapi/v1/time", "/fapi/v1/userTrades"]);
  });
  it("rejects malformed symbols, missing symbol pagination and unsupported resources", async () => {
    configure();
    for (const query of [
      "symbol=../../bad",
      "symbol=BTCUSDT&limit=1001",
      "fromId=0",
      "market=invalid",
    ]) {
      expect((await GET(request(`/api/trades?${query}`), context("trades"))).status).toBe(400);
    }
    expect((await GET(request("/api/admin"), context("admin"))).status).toBe(404);
  });
  it("rejects cookie writes without Origin and rejects user cookies at cron", async () => {
    configure();
    const r = request("/api/sync", "alice", { method: "POST" });
    r.headers.delete("origin");
    expect((await POST(r)).status).toBe(403);
    expect((await cron(request("/api/cron"))).status).toBe(401);
  });
  it("logs in with username + password, keeps a persistent secure cookie, and logs out", async () => {
    configure();
    vi.stubEnv("NODE_ENV", "production");
    const headers = { origin: "https://portal.test", "content-type": "application/json" };
    const attempt = (body: unknown) =>
      login(
        new Request("https://portal.test/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );
    expect((await attempt({ username: "alice", password: "wrong" })).status).toBe(401);
    const response = await attempt({ username: "Alice", password });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.username).toBe("alice");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=31536000");
    expect(
      (
        await session(
          new Request("https://portal.test/api/session", {
            headers: { cookie: cookie.split(";")[0] },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await logout(new Request("https://portal.test/api/session", { method: "DELETE", headers }))
      ).headers.get("set-cookie"),
    ).toContain("Max-Age=0");
  });
  it("denies old cookies as soon as an admin disables the user", async () => {
    const app = configure();
    const token = createSession(app, app.users[0]);
    const raw = fixture();
    raw.users[0].enabled = false;
    configure(raw);
    expect(
      (
        await GET(
          new Request("https://portal.test/api/dashboard", {
            headers: { cookie: `slzb_session=${token}` },
          }),
          context("dashboard"),
        )
      ).status,
    ).toBe(401);
  });
});
