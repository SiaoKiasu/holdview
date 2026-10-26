"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Eye,
  EyeOff,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  RefreshCw,
  Search,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { STABLECOINS } from "@/lib/assets";
import dynamic from "next/dynamic";
const AdminPanel = dynamic(() => import("./admin-panel").then((m) => m.AdminPanel));
import { formatPrice } from "@/lib/price-format";
import { CoinIcon } from "./coin-icon";
import { OverviewPanel } from "./overview-panel";
import { TradePlanPanel } from "./trade-plan-panel";
import { ClosedReviewPanel } from "./closed-review-panel";
import { CostEditor } from "./cost-editor";
import { LindenBrand, LindenMark } from "./brand";
import type { Dashboard, Holding, Trade } from "@/lib/types";
type Tab = "overview" | "holdings" | "activity" | "plan" | "review" | "admin";

const assetNames: Record<string, string> = {
  BTC: "比特币",
  ETH: "以太坊",
  SOL: "索拉纳",
  BNB: "币安币",
  USDT: "泰达币",
  USDC: "美元稳定币",
  FDUSD: "第一数字美元",
  DAI: "去中心化美元稳定币",
  TUSD: "真实美元稳定币",
  USDP: "美元稳定币",
  ZEC: "大零币",
  AERO: "Base 链 · Aerodrome 交易平台代币",
  ONDO: "Ondo 平台治理代币",
  PONS: "Robinhood 链 · Pons 发币平台代币",
  KORUB: "韩股 3 倍看涨 ETF",
  TRUMP: "Solana 链 · 特朗普官方迷因币",
  WLFI: "ETH 链 · World Liberty Financial 平台治理代币",
  PEPE: "ETH 链 · 佩佩青蛙迷因币",
  ENA: "ETH 链 · Ethena 协议治理代币",
  牛来: "牛来",
};
function number(value: string | number | null, digits = 2) {
  return value === null
    ? "—"
    : Number(value).toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits === 2 ? 2 : 0,
      });
}
function signed(value: string | null) {
  return value === null
    ? "—"
    : `${Number(value) >= 0 ? "+" : "−"}${number(Math.abs(Number(value)))}`;
}
function time(value: number, short = false) {
  return new Date(value).toLocaleString(
    "zh-CN",
    short
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false },
  );
}
function Badge({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span className={`badge ${muted ? "muted" : ""}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error?.message ?? "请求失败，请稍后重试。"), {
      status: response.status,
      demo: data.demo,
    });
  return data;
}
export function Portal() {
  const [session, setSession] = useState<"loading" | "login" | "ready" | "error">("loading");
  const [username, setUsername] = useState("");
  const [viewer, setViewer] = useState<{
    username: string;
    displayName: string;
    role: "admin" | "viewer";
  } | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; label: string; viewers: string[] }[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [adminPending, setAdminPending] = useState(false);
  const [costPending, setCostPending] = useState(false);
  const [costEditorOpen, setCostEditorOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loading = useRef(false);
  const generation = useRef(0);
  const authChannel = useRef<BroadcastChannel | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [hidden, setHidden] = useState(false);
  const [period, setPeriod] = useState(7);
  const [search, setSearch] = useState("");
  const [side, setSide] = useState("ALL");
  const [page, setPage] = useState(1);
  const [showSmall, setShowSmall] = useState(false);
  const [now, setNow] = useState(Date.now());
  const checkSession = useCallback(async () => {
    const current = ++generation.current;
    loading.current = false;
    setData(null);
    setViewer(null);
    setAccounts([]);
    setSelectedAccount("");
    setCostEditorOpen(false);
    setSession("loading");
    setError("");
    try {
      const s = await api("/api/session");
      if (generation.current !== current) return;
      setViewer(s.user);
      setAccounts(s.accounts ?? []);
      setSelectedAccount(s.accountId);
      setTab(s.user.role === "admin" && !s.accountId ? "admin" : "overview");
      setSession("ready");
    } catch (e) {
      if (generation.current !== current) return;
      const err = e as Error & { status?: number; demo?: boolean };
      if (err.status === 401) {
        setSession("login");
      } else {
        setError(err.message);
        setSession("error");
      }
    }
  }, []);
  const load = useCallback(async () => {
    if (loading.current || !selectedAccount || tab === "admin") return;
    loading.current = true;
    const current = generation.current;
    setBusy(true);
    try {
      const next = await api(`/api/sync?accountId=${encodeURIComponent(selectedAccount)}`, {
        method: "POST",
      });
      if (generation.current !== current) return;
      setData(next);
      setError("");
    } catch (e) {
      if (generation.current !== current) return;
      const err = e as Error & { status?: number; demo?: boolean };
      if (err.status === 401) {
        setSession("login");
        setData(null);
      }
      setError(err.message);
    } finally {
      if (generation.current === current) {
        loading.current = false;
        setBusy(false);
      }
    }
  }, [selectedAccount, tab]);
  useEffect(() => {
    void checkSession();
  }, [checkSession]);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("slzb-session");
    authChannel.current = channel;
    channel.onmessage = () => {
      void checkSession();
    };
    return () => {
      channel.close();
      authChannel.current = null;
    };
  }, [checkSession]);
  useEffect(() => {
    if (session !== "ready") return;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 60000);
    const clock = setInterval(() => setNow(Date.now()), 10000);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
    };
  }, [session, load]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      generation.current++;
      loading.current = false;
      setPassword("");
      setViewer(result.user);
      setAccounts(result.accounts ?? []);
      setSelectedAccount(result.accountId);
      setTab(result.user.role === "admin" && !result.accountId ? "admin" : "overview");
      authChannel.current?.postMessage("changed");
      setData(null);
      setSession("ready");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if ((adminPending || costPending) && !window.confirm("退出并放弃当前编辑？")) return;
    try {
      await api("/api/session", { method: "DELETE" });
      generation.current++;
      loading.current = false;
      setBusy(false);
      authChannel.current?.postMessage("changed");
      setData(null);
      setViewer(null);
      setAccounts([]);
      setSelectedAccount("");
      setCostEditorOpen(false);
      setSession("login");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function navigate(next: Tab) {
    if (adminPending || costPending) return;
    generation.current++;
    loading.current = false;
    setBusy(false);
    setTab(next);
    setSearch("");
    setSide("ALL");
    setPage(1);
  }
  const money = (value: string | number | null) =>
    hidden
      ? "••••••"
      : number(
          value,
          value !== null && Math.abs(Number(value)) > 0 && Math.abs(Number(value)) < 1 ? 8 : 2,
        );
  const profit = (value: string | null) => (hidden ? "••••••" : signed(value));
  if (session !== "ready")
    return (
      <main className="entrance">
        <div className="entrance-art">
          <LindenBrand />
          <div className="entrance-copy">
            <span className="eyebrow">PRIVATE CLIENT PORTAL</span>
            <h1>
              Independent thinking.
              <br />
              Disciplined investing.
            </h1>
            <div className="brand-rule" />
          </div>
          <LindenMark className="entrance-emblem" />
        </div>
        <div className="entrance-form">
          <div className="login-card">
            <LindenBrand className="login-brand" />
            <span className="login-icon">
              <LockKeyhole size={26} />
            </span>
            <span className="eyebrow">CLIENT ACCESS</span>
            <h2>
              {session === "login"
                ? "登录账户"
                : session === "error"
                  ? "账户服务暂不可用"
                  : "正在打开账户观察室"}
            </h2>
            {session === "login" && (
              <form onSubmit={login}>
                <label htmlFor="username">用户名</label>
                <input
                  id="username"
                  type="text"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  placeholder="输入你的用户名"
                />
                <label htmlFor="password">密码</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  placeholder="输入你的密码"
                />
                <button className="button primary full" disabled={busy}>
                  {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}
                  进入账户
                </button>
              </form>
            )}
            {session === "loading" && <LoaderCircle className="spin" />}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {session === "error" && (
              <>
                <button className="button" onClick={checkSession}>
                  <RefreshCw size={15} />
                  重新检查
                </button>
              </>
            )}
          </div>
        </div>
      </main>
    );
  const stale = data && now - data.updatedAt > 120000;
  const syncIssues = data
    ? [
        ...(!data.connection.ordersComplete ? ["挂单读取失败"] : []),
        ...(data.connection.futuresEnabled && !data.connection.futuresTradesComplete
          ? ["合约成交待同步"]
          : []),
        ...(data.connection.futuresEnabled && !data.connection.futuresComplete
          ? ["合约流水待同步"]
          : []),
        ...(data.summary.unpricedAssets ? [`缺少行情 ${data.summary.unpricedAssets} 项`] : []),
        ...(!data.connection.tradesComplete
          ? [
              data.connection.historySync.total
                ? `历史同步中 ${data.connection.historySync.scanned}/${data.connection.historySync.total}`
                : "历史同步待重试",
            ]
          : []),
      ]
    : [];
  const visibleHoldings =
    data?.holdings.filter(
      (h) =>
        showSmall ||
        h.value === null ||
        Number(h.value) >= 1 ||
        (h.instrument === "futures" &&
          h.direction === "已平仓" &&
          Math.abs(Number(h.unrealizedPnl)) >= 1),
    ) ?? [];
  const holdings = visibleHoldings.filter((h) =>
    h.asset.toLowerCase().includes(search.toLowerCase()),
  );
  const trades =
    data?.trades.filter(
      (t) =>
        (side === "ALL" || side === t.side) &&
        t.symbol.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const pages = Math.max(1, Math.ceil(trades.length / 12));
  const safePage = Math.min(page, pages);
  function exportTrades() {
    const rows = [
      [
        "市场",
        "成交ID",
        "交易对",
        "方向",
        "价格",
        "数量",
        "成交额(报价币)",
        "手续费",
        "手续费币种",
        "时间(UTC)",
      ],
      ...trades.map((t) => [
        t.instrument === "futures" ? "合约" : "现货",
        t.id,
        t.symbol,
        t.side,
        t.price,
        t.quantity,
        t.quoteQuantity,
        t.fee,
        t.feeAsset,
        new Date(t.time).toISOString(),
      ]),
    ];
    const csv =
      "\uFEFF" +
      rows
        .map((r) =>
          r
            .map(
              (v) =>
                `"${String(v)
                  .replace(/^[=+\-@]/, "'$&")
                  .replaceAll('"', '""')}"`,
            )
            .join(","),
        )
        .join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `linden-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const title = {
    overview: "账户总览",
    holdings: "资产持仓",
    activity: "交易记录",
    plan: "交易计划",
    review: "平仓复盘",
    admin: "管理后台",
  }[tab];
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand-link" href="/" aria-label="Linden Asset Management 首页">
          <LindenBrand />
        </a>
        <nav>
          {(
            [
              { id: "overview", label: "账户总览", icon: LayoutDashboard },
              { id: "holdings", label: "资产持仓", icon: Wallet },
              { id: "activity", label: "交易记录", icon: Activity },
              { id: "plan", label: "交易计划", icon: BarChart3 },
              { id: "review", label: "平仓复盘", icon: BarChart3 },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              disabled={adminPending || costPending}
              className={`nav-item ${tab === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {tab === item.id && <span className="nav-dot" />}
            </button>
          ))}
          {viewer?.role === "admin" && (
            <button
              className={`nav-item ${tab === "admin" ? "active" : ""}`}
              disabled={costPending}
              onClick={() => navigate("admin")}
            >
              <ShieldCheck size={18} />
              <span>管理后台</span>
              {tab === "admin" && <span className="nav-dot" />}
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <span className="avatar">L</span>
            <div>
              <strong>{viewer?.displayName ?? "我的账户"}</strong>
              <small>{viewer?.username}</small>
            </div>
            {viewer && (
              <button className="icon-button" onClick={logout} aria-label="退出登录">
                <LogOut size={16} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <a href="/" className="mobile-brand" aria-label="Linden Asset Management 首页">
            <LindenBrand />
          </a>
          <div className="breadcrumb">
            <strong>{title}</strong>
          </div>
          <div className="topbar-right">
            <span className="read-only">
              <ShieldCheck size={14} />
              {viewer?.role === "admin" ? "管理员" : "只读访问"}
            </span>
            <span className="avatar small">L</span>
            {viewer && (
              <button className="icon-button" onClick={logout} aria-label="退出账户">
                <LogOut size={15} />
              </button>
            )}
          </div>
        </header>
        <main className="main">
          <div className="page-heading">
            <div>
              <h1>
                {title}
                {tab !== "admin" && (
                  <button
                    className="icon-button"
                    onClick={() => setHidden(!hidden)}
                    aria-label={hidden ? "显示金额" : "隐藏金额"}
                  >
                    {hidden ? <EyeOff size={19} /> : <Eye size={19} />}
                  </button>
                )}
              </h1>
            </div>
            {tab !== "admin" && selectedAccount && (
              <div className="heading-actions">
                {viewer?.role === "admin" && (
                  <button
                    className="button"
                    disabled={costPending}
                    onClick={() => setCostEditorOpen((v) => !v)}
                  >
                    <ShieldCheck size={15} />
                    {costEditorOpen ? "收起成本管理" : "成本管理"}
                  </button>
                )}
                {(data?.source === "demo" || error || stale || !syncIssues.length) && (
                  <Badge muted={data?.source === "demo" || Boolean(error) || Boolean(stale)}>
                    {data?.source === "demo"
                      ? "演示模式"
                      : error || stale
                        ? "数据待更新"
                        : data
                          ? data.connection.futuresEnabled
                            ? "Binance 现货 / 合约"
                            : "Binance 现货"
                          : "连接中"}
                  </Badge>
                )}
                {data?.source !== "demo" &&
                  syncIssues.map((issue) => (
                    <Badge key={issue} muted>
                      {issue}
                    </Badge>
                  ))}
                <button className="button" onClick={load} disabled={busy}>
                  <RefreshCw size={15} className={busy ? "spin" : ""} />
                  {busy ? "更新中" : "刷新数据"}
                </button>
              </div>
            )}
          </div>
          {viewer?.role === "admin" && tab === "admin" ? (
            <AdminPanel
              onPendingChange={setAdminPending}
              onUnauthorized={() => void checkSession()}
              onUpdated={async () => {
                const current = generation.current;
                const s = await api("/api/session");
                if (current !== generation.current) return;
                setAccounts(s.accounts ?? []);
                setSelectedAccount((previous) =>
                  s.accounts?.some((a: { id: string }) => a.id === previous)
                    ? previous
                    : s.accountId,
                );
                setData(null);
              }}
              onView={(id, costs) => {
                generation.current++;
                loading.current = false;
                setBusy(false);
                setSelectedAccount(id);
                setData(null);
                setError("");
                setCostEditorOpen(Boolean(costs));
                setTab(costs ? "holdings" : "overview");
              }}
            />
          ) : (
            <>
              {viewer?.role === "admin" && selectedAccount && (
                <div className="account-switcher">
                  <label htmlFor="managed-account">管理账户</label>
                  <select
                    id="managed-account"
                    value={selectedAccount}
                    disabled={costPending}
                    onChange={(e) => {
                      generation.current++;
                      loading.current = false;
                      setData(null);
                      setError("");
                      setBusy(true);
                      setSearch("");
                      setPage(1);
                      setSide("ALL");
                      setSelectedAccount(e.target.value);
                    }}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                        {a.viewers.length ? ` · ${a.viewers.join("、")}` : ""}
                      </option>
                    ))}
                  </select>
                  {costPending && <small>保存或重新加载设置后可切换账户</small>}
                </div>
              )}
              {error && (
                <div className="error" role="alert">
                  {error}
                  {data && " 当前展示上次成功数据。"}
                </div>
              )}
              {viewer?.role === "admin" && costEditorOpen && (
                <CostEditor
                  key={selectedAccount}
                  accountId={selectedAccount}
                  accountLabel={accounts.find((a) => a.id === selectedAccount)?.label ?? ""}
                  onPendingChange={setCostPending}
                  holdings={data?.holdings.filter((h) => h.instrument !== "futures") ?? []}
                  trades={data?.trades ?? []}
                  onSaved={async () => {
                    const current = ++generation.current;
                    loading.current = false;
                    try {
                      const next = await api(
                        `/api/dashboard?accountId=${encodeURIComponent(selectedAccount)}`,
                      );
                      if (current === generation.current) {
                        setData(next);
                        setError("");
                      }
                    } catch (e) {
                      if (current === generation.current) setError((e as Error).message);
                    } finally {
                      if (current === generation.current) setBusy(false);
                    }
                  }}
                />
              )}
              {data?.source === "demo" && (
                <div className="demo-banner">
                  <span>
                    <span className="demo-label">DEMO</span>当前为模拟账户，所有数据仅供预览。
                  </span>
                </div>
              )}
              {!data ? (
                <div className="empty large">
                  {busy ? (
                    <>
                      <LoaderCircle className="spin" size={28} />
                      <h3>正在同步账户数据</h3>
                      <p>第一次连接可能需要一点时间。</p>
                    </>
                  ) : (
                    <>
                      <Wallet size={30} />
                      <h3>暂时无法加载账户</h3>
                      <p>请稍后刷新，如仍无法加载，请联系管理员。</p>
                    </>
                  )}
                </div>
              ) : (
                <>
                  {tab === "holdings" && (
                    <div className="stats">
                      <div className="stat featured">
                        <div className="stat-label">
                          {data.summary.equityComplete ? "总资产估值 · Equity" : "已估值资产小计"}
                          {data.source === "binance" &&
                            data.summary.equitySource === "calculated" && (
                              <span className="subtle-tag">估算</span>
                            )}
                          <Wallet size={17} />
                        </div>
                        <div className="stat-value">
                          {money(data.summary.equity)}
                          <span>USDT</span>
                        </div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">
                          已实现盈亏
                          {data.summary.realizedPnl !== null &&
                            !data.summary.realizedPnlComplete &&
                            "（暂计）"}
                          <ArrowUpRight size={17} />
                        </div>
                        <div
                          className={`stat-value ${Number(data.summary.realizedPnl) < 0 ? "negative" : "positive"}`}
                        >
                          {profit(data.summary.realizedPnl)}
                          <span>USDT</span>
                        </div>
                        {data.summary.realizedPnl === null && (
                          <div className="stat-note">{data.summary.realizedPnlNote}</div>
                        )}
                      </div>
                      <div className="stat">
                        <div className="stat-label">
                          {data.connection.futuresEnabled ? "持仓盈亏" : "未实现盈亏"}
                          {data.summary.holdingPnlComplete === false &&
                            data.summary.unrealizedPnl !== null && (
                              <span className="subtle-tag">暂计</span>
                            )}
                          <BarChart3 size={17} />
                        </div>
                        <div
                          className={`stat-value ${Number(data.summary.unrealizedPnl) < 0 ? "negative" : "positive"}`}
                        >
                          {profit(data.summary.unrealizedPnl)}
                          <span>USDT</span>
                        </div>
                        {data.summary.unrealizedPnl === null && (
                          <div className="stat-note">
                            {data.connection.futuresEnabled
                              ? "成本、行情或合约流水待补齐"
                              : "缺少成本或行情"}
                          </div>
                        )}
                      </div>
                      <div className="stat">
                        <div className="stat-label">
                          现金 · USDT
                          <Wallet size={17} />
                        </div>
                        <div className="stat-value">
                          {money(data.summary.cash)}
                          <span>USDT</span>
                        </div>
                        <div className="stat-note">
                          可用 {money(data.summary.cashFree)} · 冻结{" "}
                          {money(data.summary.cashLocked)}
                        </div>
                      </div>
                    </div>
                  )}
                  {tab === "holdings" && (
                    <div className="capital-strip">
                      <div>
                        <span>账户本金</span>
                        <strong>
                          {data.summary.principal === null
                            ? "尚未设置"
                            : `${money(data.summary.principal)} USDT`}
                        </strong>
                      </div>
                    </div>
                  )}
                  {tab === "overview" && (
                    <OverviewPanel
                      data={data}
                      hidden={hidden}
                      period={period}
                      onPeriod={setPeriod}
                      onNavigate={navigate}
                      chart={<EquityChart data={data} period={period} hidden={hidden} />}
                    />
                  )}
                  {tab === "holdings" && (
                    <section className="panel holdings-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>
                            资产持仓 <span className="count">{visibleHoldings.length}</span>
                          </h2>
                        </div>
                        <div className="table-tools">
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={showSmall}
                              onChange={(e) => setShowSmall(e.target.checked)}
                            />
                            展示小额资产
                          </label>
                          <SearchBox value={search} onChange={setSearch} placeholder="搜索币种" />
                        </div>
                      </div>
                      <HoldingTable
                        holdings={holdings}
                        money={money}
                        profit={profit}
                        hidden={hidden}
                      />
                    </section>
                  )}
                  {tab === "plan" && (
                    <TradePlanPanel key={selectedAccount} data={data} hidden={hidden} />
                  )}
                  {tab === "review" && (
                    <ClosedReviewPanel
                      key={selectedAccount}
                      review={data.closedReview}
                      hidden={hidden}
                    />
                  )}
                  {tab === "activity" && (
                    <>
                      <div className="activity-summary">
                        <div>
                          <span>本次加载成交</span>
                          <strong>
                            {data.trades.length}
                            <small> 笔</small>
                          </strong>
                        </div>
                        <div>
                          <span>当前挂单</span>
                          <strong>
                            {data.connection.ordersComplete ? data.orders.length : "—"}
                            <small> 笔</small>
                          </strong>
                        </div>
                        <div>
                          <span>覆盖交易对</span>
                          <strong>
                            {data.connection.symbols.length}
                            <small> 个</small>
                          </strong>
                        </div>
                      </div>
                      <section className="panel">
                        <div className="panel-heading">
                          <div>
                            <h2>成交明细</h2>
                          </div>
                          <button className="button" onClick={exportTrades}>
                            <Download size={15} />
                            导出 CSV
                          </button>
                        </div>
                        <div className="filterbar">
                          <div className="segmented">
                            {[
                              { v: "ALL", l: "全部成交" },
                              { v: "BUY", l: "买入" },
                              { v: "SELL", l: "卖出" },
                            ].map((s) => (
                              <button
                                key={s.v}
                                className={side === s.v ? "selected" : ""}
                                onClick={() => {
                                  setSide(s.v);
                                  setPage(1);
                                }}
                              >
                                {s.l}
                              </button>
                            ))}
                          </div>
                          <SearchBox
                            value={search}
                            onChange={(s) => {
                              setSearch(s);
                              setPage(1);
                            }}
                            placeholder="搜索交易对"
                          />
                        </div>
                        <TradeTable
                          trades={trades.slice((safePage - 1) * 12, safePage * 12)}
                          hidden={hidden}
                        />
                        <div className="pagination">
                          <span>共 {trades.length} 笔匹配成交</span>
                          <div>
                            <button
                              className="icon-button"
                              disabled={safePage <= 1}
                              onClick={() => setPage(safePage - 1)}
                              aria-label="上一页"
                            >
                              <ChevronLeft size={18} />
                            </button>
                            {safePage} / {pages}
                            <button
                              className="icon-button"
                              disabled={safePage >= pages}
                              onClick={() => setPage(safePage + 1)}
                              aria-label="下一页"
                            >
                              <ChevronRight size={18} />
                            </button>
                          </div>
                        </div>
                      </section>
                      <section className="panel">
                        <div className="panel-heading">
                          <div>
                            <h2>当前挂单</h2>
                          </div>
                          <span className="count">
                            {data.connection.ordersComplete ? data.orders.length : "同步失败"}
                          </span>
                        </div>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>交易对</th>
                                <th>方向 / 类型</th>
                                <th>委托价格</th>
                                <th>委托数量</th>
                                <th>已成交数量</th>
                                <th>状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              {data.orders.map((o) => (
                                <tr key={`${o.instrument ?? "spot"}-${o.symbol}-${o.id}`}>
                                  <td>
                                    <strong>{o.symbol}</strong>
                                  </td>
                                  <td>
                                    <span className={o.side === "BUY" ? "positive" : "negative"}>
                                      {o.side === "BUY" ? "买入" : "卖出"}
                                    </span>{" "}
                                    · {o.type}
                                  </td>
                                  <td className="numeric">
                                    {hidden ? "••••" : formatPrice(o.price)}
                                  </td>
                                  <td className="numeric">
                                    {hidden ? "••••" : number(o.quantity, 8)}
                                  </td>
                                  <td className="numeric">
                                    {hidden ? "••••" : number(o.executedQuantity, 8)}
                                  </td>
                                  <td>
                                    <span className="subtle-tag">
                                      {o.status === "NEW"
                                        ? "等待成交"
                                        : o.status === "PARTIALLY_FILLED"
                                          ? "部分成交"
                                          : o.status}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {!data.orders.length && (
                            <div className="empty">
                              {data.connection.ordersComplete
                                ? "暂无挂单"
                                : "挂单读取失败，请重试。"}
                            </div>
                          )}
                        </div>
                      </section>
                    </>
                  )}
                  {data.warnings.length > 0 && (
                    <details className="data-notes" open={Boolean(data.summary.unpricedAssets)}>
                      <summary>
                        <CircleHelp size={15} />
                        数据说明与覆盖范围 <span>{data.warnings.length}</span>
                      </summary>
                      <ul>
                        {data.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <footer className="page-footer">
                    <span>更新于 {time(data.updatedAt, true)}</span>
                  </footer>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <Search size={15} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button onClick={() => onChange("")} aria-label="清空搜索">
          <X size={13} />
        </button>
      )}
    </label>
  );
}
function HoldingTable({
  holdings,
  money,
  profit,
  hidden,
}: {
  holdings: Holding[];
  money: (v: string | number | null) => string;
  profit: (v: string | null) => string;
  hidden: boolean;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>资产</th>
            <th>持有数量 / 冻结</th>
            <th>成本 (USDT / 枚)</th>
            <th>标记价格 (USDT / 枚)</th>
            <th>资产估值 (USDT)</th>
            <th>持仓盈亏 (USDT)</th>
            <th>资产占比</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => {
            const returnRate =
              h.instrument === "futures"
                ? (h.returnRate ?? null)
                : h.averageCost !== null && Number(h.averageCost) > 0 && h.price !== null
                  ? ((Number(h.price) / Number(h.averageCost) - 1) * 100).toString()
                  : null;
            return (
              <tr key={`${h.instrument ?? "spot"}:${h.symbol ?? h.asset}`}>
                <td>
                  <div className="asset-cell">
                    <CoinIcon asset={h.asset} />
                    <div>
                      <strong>{h.asset}</strong>
                      <small>{assetNames[h.asset] ?? "其他资产"}</small>
                    </div>
                  </div>
                </td>
                <td className="numeric">
                  <strong>{hidden ? "••••" : number(h.quantity, 8)}</strong>
                  {h.instrument !== "futures" && (
                    <small>冻结 {hidden ? "••••" : number(h.locked, 8)}</small>
                  )}
                </td>
                <td className="numeric">
                  <strong>{hidden ? "••••" : formatPrice(h.averageCost)}</strong>
                  {h.averageCost === null && h.instrument !== "futures" && <small>未设置</small>}
                </td>
                <td className="numeric">
                  <strong>{hidden ? "••••" : formatPrice(h.price)}</strong>
                  {h.price === null && h.direction !== "已平仓" && <small>暂无行情</small>}
                </td>
                <td className="numeric">
                  <strong>{money(h.value)}</strong>

                  {h.value === null && <small>未计入估值</small>}
                </td>
                <td className="numeric">
                  <strong
                    className={
                      h.unrealizedPnl === null
                        ? "muted-text"
                        : Number(h.unrealizedPnl) >= 0
                          ? "positive"
                          : "negative"
                    }
                  >
                    {h.instrument !== "futures" && STABLECOINS.has(h.asset) ? (
                      "—"
                    ) : (
                      <>
                        {profit(h.unrealizedPnl)}
                        {!hidden &&
                          h.unrealizedPnl !== null &&
                          ` (${returnRate === null ? "—" : `${signed(returnRate)}%`})`}
                      </>
                    )}
                  </strong>
                  {h.instrument === "futures" && h.pnlComplete === false && (
                    <small>资金费待同步</small>
                  )}
                </td>
                <td>
                  <div className="allocation-cell">
                    <span>{number(h.allocation, 1)}%</span>
                    <div>
                      <i style={{ width: `${Math.max(0, Math.min(100, h.allocation))}%` }} />
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!holdings.length && <div className="empty">没有符合条件的资产。</div>}
    </div>
  );
}
function TradeTable({ trades, hidden }: { trades: Trade[]; hidden: boolean }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>交易对</th>
            <th>方向</th>
            <th>成交价格</th>
            <th>成交数量</th>
            <th>成交额（报价币）</th>
            <th>手续费</th>
            <th>时间（本地）</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={`${t.instrument ?? "spot"}-${t.symbol}-${t.id}`}>
              <td>
                <strong>{t.symbol}</strong>
                <small>
                  {t.instrument === "futures" ? "合约 · " : ""}
                  {t.isMaker ? "Maker" : "Taker"}
                </small>
              </td>
              <td>
                <span className={`side-pill ${t.side === "BUY" ? "buy" : "sell"}`}>
                  {t.side === "BUY" ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}{" "}
                  {t.side === "BUY" ? "买入" : "卖出"}
                </span>
              </td>
              <td className="numeric">{hidden ? "••••" : formatPrice(t.price)}</td>
              <td className="numeric">{hidden ? "••••" : number(t.quantity, 8)}</td>
              <td className="numeric">{hidden ? "••••" : number(t.quoteQuantity, 8)}</td>
              <td className="numeric">
                {hidden ? "••••" : number(t.fee, 8)} <small className="inline">{t.feeAsset}</small>
              </td>
              <td className="date-cell">{time(t.time)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!trades.length && <div className="empty">暂无匹配成交。</div>}
    </div>
  );
}
function EquityChart({
  data,
  period,
  hidden,
}: {
  data: Dashboard;
  period: number;
  hidden: boolean;
}) {
  const points = data.history
    .filter((h) => h.time >= Date.now() - period * 86400000)
    .map((h) => ({ time: h.time, value: Number(h.equity) }));
  if (hidden)
    return (
      <div className="empty chart-empty">
        <EyeOff size={25} />
        <p>金额已隐藏</p>
      </div>
    );
  if (points.length < 2)
    return (
      <div className="empty chart-empty">
        <BarChart3 size={28} />
        <h3>{points.length ? "第一笔净值已记录" : "等待净值记录"}</h3>
        <p>
          {data.connection.database
            ? "积累两个时间点后，资产走势将在这里显示。"
            : "历史净值尚未启用，请联系管理员。"}
        </p>
      </div>
    );
  return (
    <div className="equity-chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 20, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8ca893" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#8ca893" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e6e9e1" strokeDasharray="3 5" vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t) =>
              new Date(t).toLocaleDateString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                ...(period === 1 ? { hour: "2-digit" } : {}),
              })
            }
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#7d8879", fontSize: 11 }}
            minTickGap={42}
            dy={10}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v) => number(Number(v))}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#7d8879", fontSize: 11 }}
            width={88}
          />
          <Tooltip
            labelFormatter={(v) => time(Number(v))}
            formatter={(v) => [`${number(Number(v))} USDT`, "资产估值"]}
            contentStyle={{ border: "1px solid #dfe5d9", borderRadius: 10, fontSize: 12 }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#52765a"
            strokeWidth={2.5}
            fill="url(#equityFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
