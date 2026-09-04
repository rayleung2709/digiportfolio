#!/usr/bin/env python3
"""抓 LSE ETF 收市價 (USD) → data/prices.json (最新) + data/history.json (每日)
用法:  python fetch_prices.py             # 補最近 10 日（日常）
       python fetch_prices.py --backfill  # 由第一筆交易日開始全部重建
"""
import json, sys, datetime as dt, pathlib
import yfinance as yf

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"
TX = json.loads((DATA / "transactions.json").read_text(encoding="utf-8"))
HIST_P, PX_P = DATA / "history.json", DATA / "prices.json"


def currency_of(t):
    try:
        return t.fast_info["currency"]
    except Exception:
        return (t.info or {}).get("currency", "USD")


def main():
    backfill = "--backfill" in sys.argv
    hist = {} if backfill or not HIST_P.exists() else json.loads(HIST_P.read_text())
    first_tx = min(t[0] for t in TX["transactions"])
    start = first_tx if backfill else (dt.date.today() - dt.timedelta(days=10)).isoformat()

    # GBP→USD，畀萬一 Yahoo 回 GBp（便士）線用
    fx = yf.Ticker("GBPUSD=X").history(start=start)["Close"]
    fx.index = fx.index.tz_localize(None).normalize()

    # USD→HKD，畀前端 toggle 用；存入 history 當一隻「假股票」
    hk = yf.Ticker("HKD=X").history(start=start)["Close"].dropna()
    hk.index = hk.index.tz_localize(None).normalize()
    for d, p in hk.items():
        hist.setdefault(d.date().isoformat(), {})["FX:USDHKD"] = round(float(p), 4)
    print(f"OK   FX:USDHKD         {hk.iloc[-1]:>9.4f} @ {hk.index[-1].date()}")       
       
    for code, meta in TX["instruments"].items():
        sym = meta.get("yahoo")
        if not sym:
            continue
        t = yf.Ticker(sym)
        h = t.history(start=start, auto_adjust=False)["Close"].dropna()
        if h.empty:
            print(f"WARN {code}: {sym} 冇數據"); continue
        h.index = h.index.tz_localize(None).normalize()
        cur = currency_of(t)
        if cur == "GBp":
            h = h / 100 * fx.reindex(h.index).ffill()
        elif cur == "GBP":
            h = h * fx.reindex(h.index).ffill()
        elif cur != "USD":
            print(f"WARN {code}: 貨幣 {cur} 未處理，照存")
        for d, p in h.dropna().items():
            hist.setdefault(d.date().isoformat(), {})[code] = round(float(p), 4)
        print(f"OK   {code:9} {sym:7} {cur:4} {h.iloc[-1]:>9.4f} @ {h.index[-1].date()}")

    hist = dict(sorted(hist.items()))
    HIST_P.write_text(json.dumps(hist, separators=(",", ":"), indent=0))

    latest = {}
    for d in hist:                       # 逐日覆蓋 → 每隻拎到最後一個有價嘅日子
        latest.update(hist[d])
    PX_P.write_text(json.dumps({
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "prices": latest}, indent=1))
    print(f"寫入 {len(hist)} 日, {len(latest)} 隻")


if __name__ == "__main__":
    main()
