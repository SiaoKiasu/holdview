"use client";
import { useEffect, useRef, useState } from "react";
import type { FuturesSettings } from "@/lib/futures-schema";
type Settings = FuturesSettings & { writable: boolean };
export function FuturesEditor({
  accountId,
  accountLabel,
  onPendingChange,
  onSaved,
}: {
  accountId: string;
  accountLabel: string;
  onPendingChange: (pending: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const sequence = useRef(0);
  async function request(init?: RequestInit): Promise<Settings> {
    const r = await fetch(`/api/futures?accountId=${encodeURIComponent(accountId)}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error?.message ?? "合约设置暂不可用。");
    return result;
  }
  async function reload() {
    const current = ++sequence.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request();
      if (!mounted.current || current !== sequence.current) return;
      setSettings(result);
      setDraft(result.netTransfer ?? "");
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
    onPendingChange(busy || Boolean(settings && draft.trim() !== (settings.netTransfer ?? "")));
  }, [busy, draft, settings, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const current = ++sequence.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ netTransfer: draft.trim() || null, revision: settings.revision }),
      });
      if (!mounted.current || current !== sequence.current) return;
      setSettings({ ...result, writable: settings.writable });
      setDraft(result.netTransfer ?? "");
      setNotice("已保存。");
      await onSaved();
    } catch (e) {
      if (mounted.current && current === sequence.current) setError((e as Error).message);
    } finally {
      if (mounted.current && current === sequence.current) setBusy(false);
    }
  }
  return (
    <section className="panel cost-editor" aria-label="管理员合约账户管理">
      <div className="panel-heading">
        <h2>
          合约账户管理 · {accountLabel} <span className="subtle-tag">仅管理员</span>
        </h2>
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
        <div className="error">请选择真实账户；云端保存需要配置 DATABASE_URL。</div>
      )}
      <form onSubmit={save}>
        <fieldset disabled={busy || !settings?.writable}>
          <div className="cost-fields">
            <label>
              <span>
                累计净划入 <small>USDT</small>
              </span>
              <input
                aria-label="合约累计净划入"
                inputMode="decimal"
                type="text"
                maxLength={38}
                placeholder="留空不纳入合约账户"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <small>累计划入 − 累计划出；填写累计值。</small>
            </label>
          </div>
          <button type="submit" className="button primary">
            {busy ? "处理中…" : "保存划转值"}
          </button>
        </fieldset>
      </form>
      <div className="cost-footer">
        <span>
          {settings?.updatedAt
            ? `最近修改：${settings.updatedBy} · ${new Date(settings.updatedAt).toLocaleString("zh-CN")}`
            : "尚未设置"}
        </span>
        <button type="button" className="text-button" disabled={busy} onClick={reload}>
          重新加载
        </button>
      </div>
    </section>
  );
}
