"""Markdown rendering helpers for the agent-facing CLI output.

All renderers return strings (no I/O, no DB, no HTTP). The digest and
evaluate command bodies stitch these together and write them to stdout;
the LLM in the chat layer reads the markdown and composes user-facing text
around it.

Two layers:

  * Small formatters - `fmt_czk`, `fmt_m2`, `fmt_tier`, etc. Reused
    everywhere so number/label conventions stay consistent.
  * Section renderers - `render_header`, `render_facts_table`,
    `render_must_have_results`, `render_price_context`,
    `render_compact_row`, `render_filtered_summary`,
    `render_image_urls`, `render_description`. Each produces one block of
    markdown.

Plus two composites:

  * `render_evaluation_packet` - the deterministic part of an
    evaluate/digest-resurfaced packet (sections 1, 3, 4 from the agreed
    design).
  * `render_inputs_appendix` - the LLM-facing context block (soft prefs,
    learned prefs, recent reactions for few-shot).

Czech conventions: prices use non-breaking spaces as thousands separators
("11\\u00a0900\\u00a0000\\u00a0Kč"), areas use a non-breaking space before
the unit ("78\\u00a0m²"). This matches the sreality.cz frontend and reads
well in any chat client that respects Unicode.
"""

from pydantic import BaseModel, ConfigDict

from .facts import CheckResult, Facts, Tier
from .pricing import PriceContext

# Single character used as both thousands separator and unit separator in
# Czech price/area display. Same character sreality uses in its own UI.
_NBSP = "\u00a0"


# ============================================================================
# Formatters
# ============================================================================


def fmt_czk(amount: int) -> str:
    """Format CZK with non-breaking space thousands separator + currency."""
    s = f"{amount:,}".replace(",", _NBSP)
    return f"{s}{_NBSP}Kč"


def fmt_czk_per_m2(per_m2: int) -> str:
    s = f"{per_m2:,}".replace(",", _NBSP)
    return f"{s}{_NBSP}Kč/m²"


def fmt_m2(area: int) -> str:
    return f"{area}{_NBSP}m²"


def fmt_price_compact(amount: int) -> str:
    """Compact form for digest rows: '11.9M', '0.99M' etc."""
    return f"{amount / 1_000_000:.2f}M"


def fmt_per_m2_compact(per_m2: int) -> str:
    """Compact form for digest rows: '153k/m²'."""
    return f"{per_m2 // 1000}k/m²"


def fmt_tier(tier: Tier, failed_reasons: list[str] | None = None) -> str:
    """`match` or `near-miss(no-balcony,panel)` or `fail(ownership)`."""
    if failed_reasons:
        return f"{tier}({','.join(failed_reasons)})"
    return tier


def fmt_change_flag(change: str | None) -> str:
    """Pass-through for the change flag string (e.g. 'price-drop -8%').

    Centralized so future formatting tweaks (emoji, color hints) live in one
    place even though today it's a no-op.
    """
    return change or ""


# ============================================================================
# Section renderers
# ============================================================================


def render_header(facts: Facts) -> str:
    """Section 1: title, price, locality, link."""
    lines = [f"# {facts.hash_id} - {facts.title}"]
    if facts.price_hidden:
        lines.append("- **Price:** hidden (Cena v RK)")
    elif facts.price_per_m2 is not None:
        lines.append(
            f"- **Price:** {fmt_czk(facts.price_czk)} "
            f"({fmt_czk_per_m2(facts.price_per_m2)})"
        )
    else:
        lines.append(f"- **Price:** {fmt_czk(facts.price_czk)}")
    lines.append(f"- **Locality:** {facts.locality_display}")
    lines.append(f"- **Link:** {facts.url}")
    return "\n".join(lines)


def render_facts_table(facts: Facts) -> str:
    """Section 3: facts as a markdown table (only fields with values shown).

    The renderer suppresses None/empty fields rather than showing "unknown"
    rows; downstream LLM context already knows the field set is open-ended.
    """
    rows: list[tuple[str, str]] = [("Disposition", facts.sub_slug)]
    if facts.usable_area is not None:
        rows.append(("Usable area", fmt_m2(facts.usable_area)))
    if facts.floor_display:
        rows.append(("Floor", facts.floor_display))
    if facts.ownership:
        rows.append(("Ownership", facts.ownership))
    if facts.building_type:
        rows.append(("Building", facts.building_type))
    if facts.building_condition:
        rows.append(("Condition", facts.building_condition))
    if facts.energy_class:
        rows.append(("Energy class", facts.energy_class))

    amenities = _amenity_list(facts)
    if amenities:
        rows.append(("Amenities", ", ".join(amenities)))
    if facts.furnished not in ("unknown", "false"):
        rows.append(("Furnished", facts.furnished))
    if facts.aktualizace:
        rows.append(("Updated", facts.aktualizace))
    if facts.labels:
        rows.append(("Tags", ", ".join(facts.labels)))

    return _markdown_table(rows)


def _amenity_list(facts: Facts) -> list[str]:
    """Order-preserving list of present amenities for the Facts table."""
    out: list[str] = []
    if facts.balcony:
        out.append("balcony")
    if facts.terrace:
        out.append("terrace")
    if facts.loggia:
        out.append("loggia")
    if facts.cellar:
        out.append("cellar")
    if facts.garage:
        out.append("garage")
    if facts.elevator:
        out.append("elevator")
    if facts.parking_lots:
        out.append(f"parking ({facts.parking_lots})")
    if facts.basin:
        out.append("pool")
    if facts.low_energy:
        out.append("low-energy")
    if facts.easy_access:
        out.append("barrier-free")
    return out


def _markdown_table(rows: list[tuple[str, str]]) -> str:
    """Tiny 2-column markdown table with key padding for monospace display.

    Cell values are sanitized so user-controlled strings (e.g. sreality
    label tags) can't break the table structure: `|` is escaped, newlines
    are collapsed to spaces.
    """
    if not rows:
        return ""
    escaped = [(_escape_cell(k), _escape_cell(v)) for k, v in rows]
    key_w = max(len(k) for k, _ in escaped)
    val_w = max(len(v) for _, v in escaped)
    out = [
        f"| {'Field':<{key_w}} | {'Value':<{val_w}} |",
        f"|{'-' * (key_w + 2)}|{'-' * (val_w + 2)}|",
    ]
    out.extend(f"| {k:<{key_w}} | {v:<{val_w}} |" for k, v in escaped)
    return "\n".join(out)


def _escape_cell(s: str) -> str:
    """Escape a string for safe inclusion in a markdown table cell."""
    return s.replace("\r", " ").replace("\n", " ").replace("|", "\\|")


def render_must_have_results(
    results: list[CheckResult], tier: Tier, failed_reasons: list[str],
) -> str:
    """Section 4 part 1: per-check results + final tier."""
    lines: list[str] = []
    if results:
        for r in results:
            mark = "✓" if r.passed else "✗"
            line = f"- {mark} [{r.severity}] `{r.check}`"
            if r.reason:
                line += f" - {r.reason}"
            lines.append(line)
    else:
        lines.append("- (no must-have checks configured)")
    lines.append(f"\n**Tier:** `{fmt_tier(tier, failed_reasons)}`")
    return "\n".join(lines)


def render_price_context(ctx: PriceContext) -> str:
    """Section 4 part 2: percentile vs cohort.

    Three states:
      * cohort empty (no comparables found, or no district) -> short note
      * cohort populated, target hidden -> show cohort stats, no percentile
      * cohort populated, target known -> show full percentile
    """
    if ctx.comparable_count == 0:
        if ctx.district_id is None:
            return "- _no district on listing, percentile unavailable_"
        return (
            f"- _no comparables found for district {ctx.district_id}, "
            f"sub {ctx.category_sub_cb}_"
        )

    lines: list[str] = []
    cohort = (
        f"district {ctx.district_id}, sub {ctx.category_sub_cb}, "
        f"{ctx.comparable_count} comparables"
    )
    if ctx.target_price_per_m2 is not None:
        lines.append(f"- Target price/m²: **{fmt_czk_per_m2(ctx.target_price_per_m2)}**")
    else:
        lines.append("- Target price: _hidden_")
    if ctx.median_price_per_m2 is not None:
        lines.append(f"- Cohort median:   {fmt_czk_per_m2(ctx.median_price_per_m2)}  _({cohort})_")
    if ctx.percentile is not None:
        cheaper_than = 100 - ctx.percentile
        lines.append(
            f"- **Percentile: {ctx.percentile}th** "
            f"(cheaper than {cheaper_than}% of cohort)"
        )
    return "\n".join(lines)


def render_description(text: str, max_chars: int | None = 2000) -> str:
    """Render the Czech description as a blockquote, optionally truncated.

    Truncates to `max_chars` (with ellipsis) to keep evaluation packets
    bounded; pass `max_chars=None` to keep the full text.
    """
    if not text:
        return "_(no description)_"
    if max_chars is not None and len(text) > max_chars:
        text = text[:max_chars].rstrip() + "..."
    # Blockquote every line so the description doesn't get mistaken for a
    # markdown directive (e.g. a paragraph starting with '#').
    return "\n".join(f"> {line}" if line else ">" for line in text.splitlines())


def render_image_urls(image_urls: list[str], limit: int = 12) -> str:
    """Bullet list of image URLs. Chat clients with image preview render inline."""
    if not image_urls:
        return "_(no images)_"
    shown = image_urls[:limit]
    lines = [f"- {url}" for url in shown]
    if len(image_urls) > limit:
        lines.append(f"- _... {len(image_urls) - limit} more_")
    return "\n".join(lines)


# ============================================================================
# Digest-specific renderers
# ============================================================================


def render_compact_row(
    facts: Facts,
    tier: Tier,
    failed_reasons: list[str],
    ctx: PriceContext,
    change_flag: str | None = None,
) -> str:
    """One fixed-width line for the digest's middle-bucket section.

    Callers should join multiple rows and wrap in a code block so monospace
    alignment is preserved. Format:

      12345678901  Praha 7 - Holešovice                   3+kk    78m²    11.90M   153k/m²    pct=38   match
    """
    loc = facts.locality_display
    if len(loc) > 38:
        loc = loc[:35] + "..."
    price = "  hidden" if facts.price_hidden else f"{fmt_price_compact(facts.price_czk):>7}"
    per_m2 = (
        f"{fmt_per_m2_compact(ctx.target_price_per_m2):<9}"
        if ctx.target_price_per_m2 is not None else "    -    "
    )
    pct = f"pct={ctx.percentile:>2}" if ctx.percentile is not None else "pct= -"
    area = f"{facts.usable_area}m²" if facts.usable_area else "?m²"
    tier_part = fmt_tier(tier, failed_reasons)
    change_part = f"  [{change_flag}]" if change_flag else ""
    return (
        f"{facts.hash_id:>11}  {loc:<38}  "
        f"{facts.sub_slug:<6}  {area:>6}  "
        f"{price}  {per_m2}  {pct:<7}  {tier_part}{change_part}"
    )


def render_filtered_summary(reason_counts: dict[str, int]) -> str:
    """Render the bottom 'skip' bucket as a breakdown by reason.

    `reason_counts` is `{failed_check_name: count}`. Sorted by count desc;
    ties broken by reason name for stable output.
    """
    if not reason_counts:
        return "_(none)_"
    total = sum(reason_counts.values())
    items = sorted(reason_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    lines = [f"**{total} filtered out:**"]
    lines.extend(f"- {count}× `{reason}`" for reason, count in items)
    return "\n".join(lines)


# ============================================================================
# INPUTS appendix
# ============================================================================


class FewShotExample(BaseModel):
    """One reaction example for the LLM's few-shot context.

    Built by learning.py / evaluate.py by joining `reactions` against the
    latest snapshot for that listing. `summary` is a short context string
    like "Praha 7, 3+kk, 78m², 11.9M".
    """
    model_config = ConfigDict(extra="forbid")

    hash_id: int
    reaction: str          # "liked" / "rejected" / "saved" / "visited"
    summary: str
    note: str | None = None


def render_inputs_appendix(
    *,
    soft_preferences: str,
    learned_preferences: str,
    fewshot_examples: list[FewShotExample],
) -> str:
    """The LLM-facing context block appended to an evaluation packet."""
    lines = ["## --- INPUTS FOR QUALITATIVE EVALUATION ---", ""]

    lines.append("### Soft preferences")
    lines.append(soft_preferences.strip() if soft_preferences.strip() else "_(none configured)_")
    lines.append("")

    lines.append("### Learned preferences (managed by `distill`)")
    lines.append(
        learned_preferences.strip() if learned_preferences.strip()
        else "_(none distilled yet)_"
    )
    lines.append("")

    lines.append("### Recent reactions (few-shot)")
    if fewshot_examples:
        for ex in fewshot_examples:
            note = f': "{ex.note}"' if ex.note else ""
            lines.append(f"- **{ex.reaction.upper()}** {ex.hash_id} ({ex.summary}){note}")
    else:
        lines.append("_(no reactions recorded for this search yet)_")

    return "\n".join(lines)


# ============================================================================
# Composite renderer
# ============================================================================


def render_evaluation_packet(
    *,
    facts: Facts,
    results: list[CheckResult],
    tier: Tier,
    failed_reasons: list[str],
    price_ctx: PriceContext,
    image_urls: list[str],
    change_flag: str | None = None,
) -> str:
    """The deterministic part of an evaluation: sections 1, 3, 4 + photos +
    description. The LLM composes sections 2 (grade), 5 (qualitative),
    6 (red flags), 7 (next actions) around this.

    `render_inputs_appendix` should be called separately and appended by the
    command body so the same packet shape is reused inside digest
    re-surface blocks (which may want a slimmer appendix).
    """
    parts = [render_header(facts)]
    if change_flag:
        parts.append(f"\n**Change since last seen:** `{change_flag}`")
    parts.append("\n## Facts\n")
    parts.append(render_facts_table(facts))
    parts.append("\n## Must-have checks\n")
    parts.append(render_must_have_results(results, tier, failed_reasons))
    parts.append("\n## Price context\n")
    parts.append(render_price_context(price_ctx))
    parts.append("\n## Photos\n")
    parts.append(render_image_urls(image_urls))
    parts.append("\n## Description (Czech, original)\n")
    parts.append(render_description(facts.description))
    return "\n".join(parts)
