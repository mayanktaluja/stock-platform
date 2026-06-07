#!/usr/bin/env python3
"""Chronos forecast worker for stock-platform.

Reads compact OHLCV input JSON from stdin and writes compact forecast JSON to
stdout. It deliberately performs no Yahoo/network data fetching and writes no
files; Node owns IO, timeouts, and artifact preservation.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import sys
from typing import Any

QUANTILES = [0.1, 0.5, 0.9]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--primary-model", default="amazon/chronos-2")
    parser.add_argument("--fallback-model", default="amazon/chronos-bolt-tiny")
    parser.add_argument("--device", default=None)
    parser.add_argument("--preflight", action="store_true")
    return parser.parse_args()


def package_version() -> str | None:
    try:
        return importlib.metadata.version("chronos-forecasting")
    except importlib.metadata.PackageNotFoundError:
        return None


def preflight() -> int:
    version = package_version()
    if not version:
        print("chronos-forecasting is not installed", file=sys.stderr)
        return 2
    try:
        import numpy  # noqa: F401
        import pandas  # noqa: F401
        import torch  # noqa: F401
        import chronos  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on local env
        print(f"chronos runtime import failed: {exc}", file=sys.stderr)
        return 3
    print(json.dumps({
        "runtime_package": "chronos-forecasting",
        "runtime_version": version,
        "ok": True,
    }))
    return 0


def load_chronos2(model_id: str, device: str | None):
    from chronos import Chronos2Pipeline

    kwargs: dict[str, Any] = {}
    if device:
        kwargs["device_map"] = device
    else:
        kwargs["device_map"] = "auto"
    return Chronos2Pipeline.from_pretrained(model_id, **kwargs)


def load_bolt(model_id: str, device: str | None):
    from chronos import BaseChronosPipeline

    kwargs: dict[str, Any] = {}
    if device:
        kwargs["device_map"] = device
    return BaseChronosPipeline.from_pretrained(model_id, **kwargs)


def context_frame(symbols: list[dict[str, Any]]) -> pd.DataFrame:
    import pandas as pd

    frames: list[pd.DataFrame] = []
    for item in symbols:
        ticker = item.get("ticker")
        rows: list[dict[str, Any]] = []
        for bar in item.get("bars") or []:
            close = bar.get("close")
            date = bar.get("date")
            if ticker and date and close is not None and math.isfinite(float(close)):
                rows.append({
                    "timestamp": pd.Timestamp(date),
                    "target": float(close),
                })
        if not rows:
            continue
        frame = pd.DataFrame(rows).sort_values("timestamp")
        frame = frame.drop_duplicates(subset=["timestamp"], keep="last")
        frame = frame.set_index("timestamp")
        full_index = pd.date_range(frame.index.min(), frame.index.max(), freq="B")
        frame = frame.reindex(full_index).ffill().dropna(subset=["target"])
        if len(frame) < 2:
            continue
        frame = frame.rename_axis("timestamp").reset_index()
        frame["id"] = ticker
        frames.append(frame[["id", "timestamp", "target"]])
    if not frames:
        raise RuntimeError("no_valid_context_rows")
    return pd.concat(frames, ignore_index=True).sort_values(["id", "timestamp"])


def fallback_predict_bolt(pipeline: Any, symbols: list[dict[str, Any]], prediction_length: int):
    import pandas as pd
    import torch

    forecasts: dict[str, pd.DataFrame] = {}
    for item in symbols:
        ticker = item["ticker"]
        closes = [float(b["close"]) for b in item.get("bars") or [] if b.get("close") is not None]
        if not closes:
            continue
        context = torch.tensor(closes, dtype=torch.float32)
        quantiles, _ = pipeline.predict_quantiles(
            inputs=context,
            prediction_length=prediction_length,
            quantile_levels=QUANTILES,
        )
        q = quantiles.detach().cpu().numpy()
        if q.ndim == 3:
            q = q[0]
        last_date = pd.Timestamp(item["bars"][-1]["date"])
        rows = []
        for idx in range(prediction_length):
            rows.append({
                "timestamp": last_date + pd.offsets.BDay(idx + 1),
                "0.1": float(q[idx][0]),
                "0.5": float(q[idx][1]),
                "0.9": float(q[idx][2]),
            })
        forecasts[ticker] = pd.DataFrame(rows)
    return forecasts


def point_value(point: Any, *names: str) -> float:
    lower_names = {name.lower() for name in names}
    for name in names:
        value = point.get(name)
        if value is not None:
            return float(value)
    for column in getattr(point, "index", []):
        column_key = str(column).lower()
        if column_key in lower_names:
            return float(point[column])
    raise KeyError(f"missing forecast column: {'/'.join(names)}")


def predict(args: argparse.Namespace, payload: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    symbols = payload.get("symbols") or []
    horizons = payload.get("horizons") or {}
    max_horizon = max(int(v) for v in horizons.values())
    selected_model_id = args.primary_model
    fallback_reason = None

    try:
        pipeline = load_chronos2(args.primary_model, args.device)
        ctx = context_frame(symbols)
        pred_df = pipeline.predict_df(
            ctx,
            prediction_length=max_horizon,
            quantile_levels=QUANTILES,
            id_column="id",
            timestamp_column="timestamp",
            target="target",
        )
        predictions = {
            ticker: frame.sort_values("timestamp").reset_index(drop=True)
            for ticker, frame in pred_df.groupby("id")
        }
    except Exception as exc:
        fallback_reason = f"primary_failed:{type(exc).__name__}"
        selected_model_id = args.fallback_model
        pipeline = load_bolt(args.fallback_model, args.device)
        predictions = fallback_predict_bolt(pipeline, symbols, max_horizon)

    rows: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    by_ticker = {item.get("ticker"): item for item in symbols}
    for ticker, item in by_ticker.items():
        frame = predictions.get(ticker)
        if frame is None or frame.empty:
            skipped.append({"ticker": ticker, "reason": "model_no_output", "stage": "model"})
            continue
        last_close = float(item["input"]["last_close"])
        row_horizons = {}
        for label, offset in horizons.items():
            idx = int(offset) - 1
            if idx >= len(frame):
                skipped.append({"ticker": ticker, "reason": f"horizon_missing:{label}", "stage": "model"})
                continue
            point = frame.iloc[idx]
            try:
                q10 = point_value(point, "0.1", "0.10", "q0.1", "q0.10", "p10")
                median = point_value(point, "0.5", "0.50", "q0.5", "q0.50", "p50", "median", "prediction", "predictions")
                q90 = point_value(point, "0.9", "0.90", "q0.9", "q0.90", "p90")
            except KeyError as exc:
                skipped.append({"ticker": ticker, "reason": f"quantile_missing:{label}:{exc}", "stage": "model"})
                continue
            row_horizons[label] = {
                "trading_sessions": int(offset),
                "median_price": median,
                "q10_price": q10,
                "q90_price": q90,
                "median_return_pct": ((median / last_close) - 1) * 100,
                "q10_return_pct": ((q10 / last_close) - 1) * 100,
                "q90_return_pct": ((q90 / last_close) - 1) * 100,
            }
        if len(row_horizons) != len(horizons):
            continue
        rows.append({
            "ticker": ticker,
            "yahoo_symbol": item.get("yahoo_symbol"),
            "status": "ok",
            "generated_at": payload.get("generated_at"),
            "selected_model_id": selected_model_id,
            "runtime_package": "chronos-forecasting",
            "runtime_version": package_version(),
            "fallback_reason": fallback_reason,
            "input": item.get("input") or {},
            "horizons": row_horizons,
            "interpretation": interpret(row_horizons, item.get("input") or {}),
        })
    return rows, {"skipped_symbols": skipped, "selected_model_id": selected_model_id, "fallback_reason": fallback_reason}


def interpret(horizons: dict[str, Any], input_meta: dict[str, Any]) -> dict[str, str]:
    y1 = horizons.get("1Y", {})
    y3 = horizons.get("3Y", {})
    m3 = horizons.get("3M", {})
    has_3y = "3Y" in horizons
    ret_1y = float(y1.get("median_return_pct", 0))
    ret_3m = float(m3.get("median_return_pct", 0))
    band_1y = float(y1.get("q90_return_pct", 0)) - float(y1.get("q10_return_pct", 0))
    short_history = int(input_meta.get("bar_count") or 0) < 252
    if ret_1y >= 12 and band_1y >= 80:
        label = "Long-term positive skew / very high uncertainty"
        read = "Upside skew is present, but the range is too wide to treat as a target. Use tranche entry; do not chase."
        strength = "LOW" if short_history else "MEDIUM"
    elif ret_3m <= -5 and ret_1y <= 8:
        label = "Near-term weak / flat long-range"
        read = "The forecast does not support rushing entry. Wait for stabilization or a better setup."
        strength = "LOW"
    elif has_3y and abs(float(y3.get("median_return_pct", 0))) < 8:
        label = "Flat long-range / low conviction"
        read = "The model does not show a strong directional edge across the long range."
        strength = "LOW"
    elif abs(ret_1y) < 5:
        label = "Neutral / no edge"
        read = "The model read is broadly neutral and should not change the SWS thesis."
        strength = "LOW"
    else:
        label = "Mild positive / high volatility" if ret_1y > 0 else "Near-term weak / low conviction recovery"
        read = "Treat this as timing and risk context only, not a target price."
        strength = "LOW" if band_1y >= 80 or short_history else "MEDIUM"
    return {"label": label, "read": read, "signal_strength": strength}


def main() -> int:
    args = parse_args()
    if args.preflight:
        return preflight()
    payload = json.load(sys.stdin)
    rows, meta = predict(args, payload)
    print(json.dumps({
        "schema_version": "chronos-worker-output-v1",
        "primary_model_id": args.primary_model,
        "fallback_model_id": args.fallback_model,
        "selected_model_id": meta["selected_model_id"],
        "fallback_reason": meta["fallback_reason"],
        "runtime_package": "chronos-forecasting",
        "runtime_version": package_version(),
        "forecasts": rows,
        "skipped_symbols": meta["skipped_symbols"],
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
