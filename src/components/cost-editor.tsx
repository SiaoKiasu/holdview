"use client";
import { useEffect, useRef, useState } from "react";
import { assetSymbolPattern } from "@/lib/asset-symbol.mjs";
import type { Holding, Trade } from "@/lib/types";
import type { CostSettings } from "@/lib/cost-schema";

type Settings = CostSettings & { writable: boolean };
async function request(accountId: string, init?: RequestInit): Promise<Settings> {
  const response = await fetch(`/api/costs?accountId=${encodeURIComponent(accountId)}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "成本设置暂不可用。");
  return result;
}
export function CostEditor({
  accountId,
  accountLabel,
  onPendingChange,
  holdings,
  trades,
  extraAssets = [],
  onSaved,
}: {
  accountId: string;
  accountLabel: string;
  onPendingChange: (pending: boolean) => void;
  holdings: Holding[];
  trades: Trade[];
  extraAssets?: string[];
  onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [asset, setAsset] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  async function reload() {
    const current = ++sequence.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request(accountId);
      if (!mounted.current || current !== sequence.current) return;
      setSettings(result);
      setDraft(result.costs);
    } catch (e) {
      if (mounted.current && current === sequence.current) setError((e as Error).message);
    } finally {
      if (mounted.current && current === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    const normalize = (values: Record<string, string>) =>
      JSON.stringify(
        Object.entries(values)
          .filter(([a, v]) => a !== "USDT" && v.trim() !== "")
          .map(([a, v]) => [a, v.trim()])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    onPendingChange(busy || Boolean(settings && normalize(draft) !== normalize(settings.costs)));
  }, [busy, draft, settings, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  const assets = [
    ...new Set([
      ...Object.keys(draft),
      ...extraAssets,
      ...holdings.map((h) => h.asset),
      ...trades.flatMap((t) => [
        ...(t.symbol.endsWith("USDT") ? [t.symbol.slice(0, -4)] : []),
        ...(Number(t.fee) > 0 ? [t.feeAsset] : []),
      ]),
    ]),
  ]
    .filter((a) => a !== "USDT")
    .sort();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError("");
    setNotice("");
    const current = ++sequence.current;
    try {
      const costs = Object.fromEntries(
        Object.entries(draft)
          .filter(([a, v]) => a !== "USDT" && v.trim() !== "")
          .map(([a, v]) => [a, v.trim()]),
      );
      const result = await request(accountId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ costs, revision: settings.revision }),
      });
      if (!mounted.current || current !== sequence.current) return;
      setSettings({ ...result, writable: settings.writable });
      setDraft(result.costs);
      setNotice("成本已保存，正在更新盈亏。所有查看用户将在下次刷新时看到新结果。");
      await onSaved();
      if (mounted.current && current === sequence.current)
        setNotice("成本已保存。所有查看用户将在下次刷新时使用这套成本。");
    } catch (e) {
      if (mounted.current && current === sequence.current) setError((e as Error).message);
    } finally {
      if (mounted.current && current === sequence.current) setBusy(false);
    }
  }
  return (
    <section className="panel cost-editor" aria-label="管理员成本管理">
      <div className="panel-heading">
        <div>
          <h2>
            成本管理 · {accountLabel} <span className="subtle-tag">仅管理员</span>
          </h2>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="cost-notice">
          {notice}
        </p>
      )}
      {settings && !settings.writable && (
        <div className="error">
          云端修改需要先配置 DATABASE_URL，才能在重启和重新部署后保留成本。
        </div>
      )}
      <form onSubmit={save}>
        <fieldset disabled={busy || !settings?.writable}>
          <div className="cost-fields">
            {assets.map((a) => (
              <label key={a}>
                <span>
                  {a} <small>USDT / 枚</small>
                </span>
                <input
                  aria-label={`${a} 单位成本`}
                  inputMode="decimal"
                  type="text"
                  maxLength={37}
                  placeholder="尚未设置"
                  value={draft[a] ?? ""}
                  onChange={(e) => setDraft((v) => ({ ...v, [a]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="cost-add">
            <label htmlFor="cost-asset">补充币种</label>
            <div>
              <input
                id="cost-asset"
                placeholder="例如 BNB"
                value={asset}
                maxLength={30}
                onChange={(e) => setAsset(e.target.value.toUpperCase())}
              />
              <button
                className="button"
                type="button"
                onClick={() => {
                  const a = asset.trim();
                  if (!assetSymbolPattern.test(a) || a === "USDT") {
                    setError("请输入有效币种名称；USDT 成本固定为 1。");
                    return;
                  }
                  setDraft((v) => ({ ...v, [a]: v[a] ?? "" }));
                  setAsset("");
                  setError("");
                }}
              >
                添加币种
              </button>
            </div>
          </div>
          <button type="submit" className="button primary">
            {busy ? "处理中…" : "保存成本"}
          </button>
        </fieldset>
      </form>
      <div className="cost-footer">
        <span>
          {settings?.updatedAt
            ? `最近修改：${settings.updatedBy} · ${new Date(settings.updatedAt).toLocaleString("zh-CN")}`
            : "尚无网页修改记录"}
        </span>
        <button type="button" className="text-button" disabled={busy} onClick={reload}>
          重新加载（放弃未保存修改）
        </button>
      </div>
    </section>
  );
}
