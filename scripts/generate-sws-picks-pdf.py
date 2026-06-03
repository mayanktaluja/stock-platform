#!/usr/bin/env python3
"""
India Market PDF Generator
Reads data/sws/picks-latest.json + per-stock JSONs in data/sws/deep/,
emits reports/sws-picks/Top-50-Buy-Now-{YYYY-MM-DD}.pdf.

Mirrors the styling pattern of scripts/generate-pdf-report.py.
"""

import json
import os
import sys
from datetime import date, datetime

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch, mm
from reportlab.platypus import (
    HRFlowable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PICKS_LATEST = os.path.join(REPO_ROOT, "data", "sws", "picks-latest.json")
DEEP_DIR = os.path.join(REPO_ROOT, "data", "sws", "deep")
OUTPUT_DIR = os.path.join(REPO_ROOT, "reports", "sws-picks")
# Aggregate news feed produced by scripts/sws-news-scrape.mjs.
# Optional — when missing, the "What's new this week" section is skipped.
NEWS_LATEST = os.path.join(REPO_ROOT, "data", "sws", "news-latest.json")

DARK_BG = colors.HexColor("#0f1724")
GREEN = colors.HexColor("#34d399")
RED = colors.HexColor("#ef4444")
GOLD = colors.HexColor("#f59e0b")
BLUE = colors.HexColor("#60a5fa")
CYAN = colors.HexColor("#22d3ee")
HEADER_BG = colors.HexColor("#1e293b")
LIGHT = colors.HexColor("#f8fafc")
MUTED = colors.HexColor("#64748b")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=28, textColor=DARK_BG, spaceAfter=4, alignment=TA_LEFT)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=18, textColor=DARK_BG, spaceAfter=6, alignment=TA_LEFT)
H3 = ParagraphStyle("H3", parent=styles["Heading3"], fontSize=13, textColor=DARK_BG, spaceAfter=4, alignment=TA_LEFT)
BODY = ParagraphStyle("BODY", parent=styles["BodyText"], fontSize=10, textColor=DARK_BG, leading=13)
SMALL = ParagraphStyle("SMALL", parent=styles["BodyText"], fontSize=8, textColor=MUTED, leading=10)
META = ParagraphStyle("META", parent=styles["BodyText"], fontSize=10, textColor=MUTED, leading=12)


def _to_num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v).replace(",", "").replace("₹", "").strip())
    except (ValueError, TypeError):
        return None


def fmt_inr(v):
    n = _to_num(v)
    if n is None:
        return "—"
    if n >= 1e12:
        return f"₹{n/1e12:.2f}t"
    if n >= 1e9:
        return f"₹{n/1e9:.1f}b"
    if n >= 1e7:
        return f"₹{n/1e7:.0f}cr"
    return f"₹{n:,.0f}"


def fmt_pct(v):
    n = _to_num(v)
    if n is None:
        return "—"
    sign = "+" if n >= 0 else ""
    return f"{sign}{n:.1f}%"


def status_suffix(s, section_key=None):
    """Render section_status as a small bracketed suffix next to the ticker.

    [NEW] when a stock newly entered a buy-side section since the previous scan.
    [FLAGGED] when a stock newly entered the AVOID section (sell-side framing).
    [↑N] when a stock climbed N ranks within the same section, where N crosses
    the section-size-aware threshold defined in scripts/sws-section-status.mjs.
    Returns "" when no badge applies (or section_status is missing).
    """
    ss = s.get("section_status") or {}
    parts = []
    if ss.get("newly_added"):
        parts.append("[FLAGGED]" if section_key == "avoid" else "[NEW]")
    rd = ss.get("rank_delta")
    if ss.get("trending") and isinstance(rd, (int, float)) and rd > 0:
        parts.append(f"[↑{int(rd)}]")
    return (" " + " ".join(parts)) if parts else ""


def load_data():
    with open(PICKS_LATEST, "r", encoding="utf-8") as f:
        picks = json.load(f)
    deep = {}
    if os.path.isdir(DEEP_DIR):
        for fn in os.listdir(DEEP_DIR):
            if fn.endswith(".json"):
                ticker = fn[:-5]
                try:
                    with open(os.path.join(DEEP_DIR, fn), "r", encoding="utf-8") as f:
                        deep[ticker] = json.load(f)
                except Exception:
                    pass
    return picks, deep


def load_news_aggregate():
    # Returns the news-latest.json dict or None if the file doesn't exist /
    # can't be parsed. The PDF gracefully skips the news section in that case
    # — the news scrape is enrichment, not a hard dependency.
    if not os.path.isfile(NEWS_LATEST):
        return None
    try:
        with open(NEWS_LATEST, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _format_news_date(iso):
    # Compact human-readable date for narrow PDF cells (e.g. "12 May").
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return d.strftime("%d %b")
    except Exception:
        return str(iso)[:10]


def cover_page(picks):
    items = []
    items.append(Paragraph("India Market Top 50 — Buy Now", H1))
    items.append(Paragraph("Categorised India Market picks from Simply Wall Street deep-scan", META))
    items.append(Spacer(1, 8))
    items.append(HRFlowable(width="100%", thickness=0.5, color=MUTED))
    items.append(Spacer(1, 12))

    scanned_at = picks.get("scanned_at", "")
    try:
        scanned_at = datetime.fromisoformat(scanned_at.replace("Z", "+00:00")).strftime("%d %b %Y, %H:%M UTC")
    except Exception:
        pass

    meta_rows = [
        ["Generated", date.today().strftime("%d %b %Y")],
        ["Last scan", scanned_at],
        ["Universe scanned", str(picks.get("universe_size", "?"))],
        ["Stocks scored", str(picks.get("scored_count", "?"))],
        ["Failed (in retry)", str(picks.get("failed_count", "?"))],
        ["Scrape duration", f"{picks.get('scrape_duration_hours', '?')} hrs" if picks.get("scrape_duration_hours") else "—"],
        ["Scrape model", picks.get("model_split", {}).get("scrape", "?")],
        ["Scoring model", picks.get("model_split", {}).get("score", "?")],
    ]
    t = Table(meta_rows, colWidths=[2.0 * inch, 4.0 * inch])
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), "Helvetica", 10),
        ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 10),
        ("TEXTCOLOR", (0, 0), (-1, -1), DARK_BG),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#e2e8f0")),
    ]))
    items.append(t)
    items.append(Spacer(1, 18))

    items.append(Paragraph("Sections in this report", H3))
    sections = picks.get("sections", {})
    counts = [
        ["Best Stocks to Buy Now", len(sections.get("best_to_buy_now", []))],
        ["Deep Value", len(sections.get("deep_value", []))],
        ["Growing Sector Value", len(sections.get("growing_sector_value", []))],
        ["Quality Growth", len(sections.get("quality_growth", []))],
        ["Midterm Picks", len(sections.get("midterm", []))],
        ["Dividend Aristocrats", len(sections.get("dividend_aristocrats", []))],
        ["Smallcap/Midcap Hidden Gems", len(sections.get("smallcap_gems", []))],
        ["Insider Buying", len(sections.get("insider_buying", []))],
        ["Upcoming Earnings (next 30 days)", len(sections.get("upcoming_earnings", []))],
        ["Avoid List", len(sections.get("avoid", []))],
    ]
    t2 = Table([["Section", "Stocks"]] + counts, colWidths=[3.5 * inch, 1.0 * inch])
    t2.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 10),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 10),
        ("TEXTCOLOR", (0, 0), (-1, -1), DARK_BG),
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [LIGHT, colors.white]),
    ]))
    items.append(t2)
    items.append(Spacer(1, 18))

    items.append(Paragraph("Methodology", H3))
    items.append(Paragraph(
        "Every stock in this report has 100% Simply Wall Street coverage — overview tab plus all 7 sub-tabs "
        "(Valuation, Future Growth, Past Performance, Financial Health, Dividend, Management, Ownership) "
        "captured by automated browser scraping with conservative rate limits and panic-stop safeguards. "
        "Stocks with partial captures are excluded.",
        BODY,
    ))
    items.append(Spacer(1, 6))
    items.append(Paragraph(
        "Composite score (0-100) combines: SWS snowflake total (35 pts), analyst upside % to fair value (20 pts), "
        "risk count penalty (-15 max), net margin (10 pts), 5Y total return (10 pts), forward earnings growth (15 pts), "
        "dividend reliability bonus (5 pts), insider buying bonus (5 pts). Verdict tiers match the platform's existing "
        "DEEP_VALUE / QUALITY_GROWTH / FAIR_VALUE / FULLY_VALUED / OVERVALUED bands.",
        BODY,
    ))
    items.append(Spacer(1, 24))
    items.append(Paragraph(
        "<b>Disclaimer</b> — Educational research material for personal use. Not personalised investment "
        "advice. Past performance is not indicative of future results. Verify all data on the issuer's exchange filings "
        "before any trade. The Simply Wall Street snowflake and analyst price targets are third-party model outputs; "
        "they reflect SWS's view at the moment of capture, not absolute truth.",
        SMALL,
    ))
    items.append(PageBreak())
    return items


def leaderboard_table(picks):
    items = []
    items.append(Paragraph("Top 25 — Best Stocks to Buy Now", H2))
    items.append(Spacer(1, 6))
    rows = [["#", "Ticker", "Sector", "Px", "FV", "Upside", "Score", "Verdict", "Snow"]]
    for i, s in enumerate(picks.get("sections", {}).get("best_to_buy_now", [])[:25], 1):
        rows.append([
            str(i),
            s.get("ticker", "—") + status_suffix(s, "best_to_buy_now"),
            (s.get("sector") or "—")[:18],
            fmt_inr(s.get("current_price_inr")),
            fmt_inr(s.get("fair_value_inr")),
            fmt_pct(s.get("upside_pct")),
            f"{s.get('score', 0):.1f}",
            (s.get("verdict") or "").replace("_", " "),
            f"{s.get('snowflake_total', '—')}/30",
        ])
    t = Table(rows, colWidths=[0.3 * inch, 0.85 * inch, 1.4 * inch, 0.7 * inch, 0.7 * inch, 0.7 * inch, 0.55 * inch, 1.05 * inch, 0.55 * inch])
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("TEXTCOLOR", (0, 1), (-1, -1), DARK_BG),
        ("ALIGN", (3, 1), (-1, -1), "RIGHT"),
        ("ALIGN", (0, 0), (0, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [LIGHT, colors.white]),
    ]))
    items.append(t)
    items.append(PageBreak())
    return items


def stock_page(s, deep):
    items = []
    items.append(Paragraph(f"{s.get('ticker')}{status_suffix(s)} — {s.get('name', '')}", H2))
    items.append(Paragraph(f"{s.get('sector') or '—'} · score <b>{s.get('score', 0):.1f}/100</b> · {(s.get('verdict') or '').replace('_', ' ')}", META))
    items.append(Spacer(1, 8))

    # If sws-narrate-picks.mjs has populated a narrative, lead with it.
    narrative = s.get("narrative") or {}
    if narrative.get("pdf_rationale"):
        items.append(Paragraph("Why this pick", H3))
        for line in str(narrative["pdf_rationale"]).split("\n"):
            line = line.strip()
            if line:
                items.append(Paragraph(line, BODY))
        items.append(Spacer(1, 8))

    snap = [
        ["Current price", fmt_inr(s.get("current_price_inr"))],
        ["Fair value", fmt_inr(s.get("fair_value_inr"))],
        ["Upside / discount", fmt_pct(s.get("upside_pct"))],
        ["Market cap", fmt_inr(s.get("market_cap_inr"))],
        ["Snowflake total", f"{s.get('snowflake_total', '—')}/30"],
        ["Next earnings", s.get("next_earnings_date") or "—"],
        ["Last quarter result", s.get("last_quarter_result") or "—"],
    ]
    t = Table(snap, colWidths=[1.6 * inch, 4.4 * inch])
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9),
        ("FONT", (1, 0), (1, -1), "Helvetica", 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#e2e8f0")),
    ]))
    items.append(t)
    items.append(Spacer(1, 8))

    full = deep.get(s.get("ticker"))
    if full:
        ov = full.get("overview", {})
        rewards = ov.get("rewards", [])
        risks = ov.get("risks", [])
        snowflake = ov.get("snowflake", {})

        items.append(Paragraph("Snowflake breakdown (out of 6 each)", H3))
        sn_rows = [
            ["Valuation", str(snowflake.get("valuation", "—"))],
            ["Future Growth", str(snowflake.get("future_growth", "—"))],
            ["Past Performance", str(snowflake.get("past_performance", "—"))],
            ["Financial Health", str(snowflake.get("financial_health", "—"))],
            ["Dividends", str(snowflake.get("dividends", "—"))],
        ]
        st = Table(sn_rows, colWidths=[1.6 * inch, 0.4 * inch])
        st.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 9),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
        ]))
        items.append(st)
        items.append(Spacer(1, 8))

        if rewards:
            items.append(Paragraph("Rewards", H3))
            for r in rewards:
                items.append(Paragraph(f"• {r}", BODY))
            items.append(Spacer(1, 6))

        if risks:
            items.append(Paragraph("Risks", H3))
            for r in risks:
                items.append(Paragraph(f"⚠ {r}", BODY))
            items.append(Spacer(1, 6))

        # Recent news (top 3) — appears only when sws-news-scrape.mjs has
        # populated the deep file's `news` array. Brief = analyst-style
        # commentary, Event = corporate actions / key developments.
        news = full.get("news") if isinstance(full.get("news"), list) else []
        if news:
            items.append(Paragraph("Recent news", H3))
            for n in news[:3]:
                date_part = _format_news_date(n.get("date"))
                title = (n.get("title") or "").strip()
                badge = "Event" if n.get("type") == "event" else "Brief"
                line = f"<b>{date_part}</b> · <i>{badge}</i> · {title}"
                items.append(Paragraph(line, BODY))
            items.append(Spacer(1, 6))

        # Forward growth + earnings calendar
        fg = ov.get("dividend") or {}
        fund_rows = []
        m = ov.get("multiples") or {}
        if m.get("pe") is not None:
            fund_rows.append(["P/E", f"{m['pe']:.1f}x"])
        if m.get("pb") is not None:
            fund_rows.append(["P/B", f"{m['pb']:.1f}x"])
        if ov.get("net_margin_pct") is not None:
            fund_rows.append(["Net margin", f"{ov['net_margin_pct']:.1f}%"])
        if ov.get("debt_to_equity_pct") is not None:
            fund_rows.append(["Debt / Equity", f"{ov['debt_to_equity_pct']:.1f}%"])
        if fg.get("yield_pct") is not None:
            fund_rows.append(["Dividend yield", f"{fg['yield_pct']:.2f}%"])
        if fg.get("payout_pct") is not None:
            fund_rows.append(["Payout ratio", f"{fg['payout_pct']:.0f}%"])
        if fund_rows:
            items.append(Paragraph("Fundamentals", H3))
            ft = Table(fund_rows, colWidths=[1.6 * inch, 1.6 * inch])
            ft.setStyle(TableStyle([
                ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9),
                ("FONT", (1, 0), (1, -1), "Helvetica", 9),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
            ]))
            items.append(ft)

    items.append(Spacer(1, 6))
    # Lead with the narrative card_one_line if present, else the deterministic one.
    one_line_text = (narrative.get("card_one_line") if narrative else None) or s.get("one_line", "")
    items.append(Paragraph(one_line_text, SMALL))
    if s.get("sws_url"):
        items.append(Paragraph(f"Source: {s['sws_url']}", SMALL))
    items.append(PageBreak())
    return items


def whats_new_section(news_agg, picks):
    # Cross-portfolio chronological news feed. Limits to picks-set tickers so
    # the PDF stays focused on stocks the report actually covers; an item from
    # a holding outside the picks (rare) gets surfaced via the per-stock-page
    # "Recent news" block instead. Skipped entirely when news-latest.json is
    # missing or empty — keeps existing PDF output unchanged on hosts that
    # haven't run sws-news-scrape.mjs yet.
    if not news_agg or not isinstance(news_agg.get("items"), list):
        return []
    items_in = news_agg["items"]
    if not items_in:
        return []

    # Restrict to the picks set so this section isn't polluted by holdings or
    # watchlist stocks that aren't covered elsewhere in the report.
    pick_tickers = set()
    for arr in (picks.get("sections") or {}).values():
        if isinstance(arr, list):
            for s in arr:
                if s.get("ticker"):
                    pick_tickers.add(s["ticker"])
    filtered = [it for it in items_in if it.get("ticker") in pick_tickers]
    if not filtered:
        return []
    # Top 30, already sorted DESC at write time.
    filtered = filtered[:30]

    items = []
    items.append(Paragraph("What's new this week", H2))
    items.append(Paragraph(
        f"Recent corporate actions and analyst-flagged briefs across the picks set "
        f"(window: {news_agg.get('window_days', 30)} days, "
        f"{len(filtered)} of {len(items_in)} items shown).",
        META,
    ))
    items.append(Spacer(1, 6))

    rows = [["Date", "Ticker", "Type", "Headline"]]
    for n in filtered:
        rows.append([
            _format_news_date(n.get("date")),
            n.get("ticker", "—"),
            "Event" if n.get("type") == "event" else "Brief",
            (n.get("title") or "")[:90],
        ])
    t = Table(rows, colWidths=[0.7 * inch, 0.85 * inch, 0.55 * inch, 4.2 * inch])
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ALIGN", (0, 1), (0, -1), "LEFT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [LIGHT, colors.white]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    items.append(t)
    items.append(PageBreak())
    return items


def section_appendix(picks):
    items = []
    items.append(Paragraph("Section appendix — full lists", H2))
    items.append(Spacer(1, 8))
    sections = picks.get("sections", {})
    label_map = {
        "deep_value": "Deep Value",
        "growing_sector_value": "Growing Sector Value",
        "quality_growth": "Quality Growth",
        "midterm": "Midterm Picks",
        "dividend_aristocrats": "Dividend Aristocrats",
        "smallcap_gems": "Smallcap/Midcap Hidden Gems",
        "insider_buying": "Insider Buying",
        "upcoming_earnings": "Upcoming Earnings (next 30 days)",
        "avoid": "Avoid List",
    }
    for key, label in label_map.items():
        arr = sections.get(key, [])
        if not arr:
            continue
        items.append(Paragraph(f"{label} ({len(arr)})", H3))
        rows = [["Ticker", "Sector", "Score", "Upside", "One-line"]]
        for s in arr[:80]:
            rows.append([
                s.get("ticker", "—") + status_suffix(s, key),
                (s.get("sector") or "—")[:14],
                f"{s.get('score', 0):.1f}",
                fmt_pct(s.get("upside_pct")),
                (s.get("one_line") or "")[:60],
            ])
        t = Table(rows, colWidths=[0.85 * inch, 1.2 * inch, 0.55 * inch, 0.65 * inch, 3.0 * inch])
        t.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
            ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ALIGN", (2, 1), (3, -1), "RIGHT"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [LIGHT, colors.white]),
        ]))
        items.append(t)
        items.append(Spacer(1, 12))
    return items


def main():
    if not os.path.isfile(PICKS_LATEST):
        print(f"ERROR: {PICKS_LATEST} not found. Run scoring first: node scripts/sws-scoring.mjs", file=sys.stderr)
        sys.exit(2)
    picks, deep = load_data()
    news_agg = load_news_aggregate()
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, f"Top-50-Buy-Now-{date.today().isoformat()}.pdf")
    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        topMargin=18 * mm, bottomMargin=18 * mm,
        leftMargin=18 * mm, rightMargin=18 * mm,
        title="India Market Top 50 — Buy Now", author="stock-platform",
    )

    story = []
    story.extend(cover_page(picks))
    story.extend(whats_new_section(news_agg, picks))
    story.extend(leaderboard_table(picks))

    # Top-50 stock pages — use union of best_to_buy_now (top 25) + top of other categories to fill 50
    seen = set()
    top_for_pages = []
    for s in picks.get("sections", {}).get("best_to_buy_now", [])[:25]:
        if s.get("ticker") not in seen:
            top_for_pages.append(s)
            seen.add(s.get("ticker"))
    for cat in ("deep_value", "growing_sector_value", "quality_growth", "midterm", "dividend_aristocrats", "smallcap_gems"):
        for s in picks.get("sections", {}).get(cat, []):
            if len(top_for_pages) >= 50:
                break
            if s.get("ticker") not in seen:
                top_for_pages.append(s)
                seen.add(s.get("ticker"))
        if len(top_for_pages) >= 50:
            break

    for s in top_for_pages:
        story.extend(stock_page(s, deep))

    story.extend(section_appendix(picks))

    doc.build(story)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
