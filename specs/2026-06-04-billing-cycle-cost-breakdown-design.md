# Billing-cycle pages & cost breakdown — design

Date: 2026-06-04
Status: approved (pending spec review)

## Goal

Extend the Instant Ink Usage report so it shows **cost** alongside pages, split
into **base subscription vs overage**, using HP's own per-cycle figures. Add an
**annual summary** and **annual averages**. Reorganize the report around
**billing cycles** instead of calendar months.

Example line the user wants to see:
`64 pages: 21 base ($1.79), 43 overage ($7.50)`

## Source of truth

Each `GET /billing_cycle/{id}` response (see
`schema/billing-cycle.schema.json`) already contains HP's exact accounting in
`totals`. We read these rather than recomputing from `plan` rates:

| Concept        | Field(s)                                              |
| -------------- | ----------------------------------------------------- |
| total pages    | `totals.total_pages`                                  |
| overage pages  | `totals.additional_pages` (== summed `overage` series)|
| base pages     | `total_pages − additional_pages`                      |
| base cost      | `totals.regular_price` (string, e.g. `"$1.79 Plan"`)  |
| overage cost   | `totals.additional_price`                             |
| tax            | `total_price − total_price_less_tax` (show if > 0)    |
| total cost     | `totals.total_price`                                  |

Money fields are display **strings** (`"$1.79"`, and `regular_price` carries a
`" Plan"` suffix). `start_date`/`end_date` have **no year**; we derive each
cycle's real start/end dates from the daily `x` serials (whole days since
1970-01-01 UTC) — `min(x)` = start, `max(x)` = end across the cycle's series.

## Attribution rule (single rule for ALL metrics)

A billing cycle belongs to the calendar year of its **end date**. An annual
bucket is the sum of every cycle ending that year — for pages, base/overage, and
cost alike. No day-level splitting anywhere, so pages and cost never disagree.
Each annual row shows the **actual covered span** (earliest start → latest end
among that year's cycles) and the **cycle count**, so it's explicit which
billing periods rolled up.

## Annual averages (totals only, no base/overage split)

Annualized from cycles (the plan is monthly → 12 cycles/year):

- **Mean** pages/year = `(Σ per-cycle total_pages ÷ cycleCount) × 12`
- **Median** pages/year = `median(per-cycle total_pages) × 12`
- Same two for cost using per-cycle `total_price`.

Computed over **all** cycles, so partial first/last years don't skew them.
Labeled as projected/annualized to distinguish from the real per-year rows.

## Data model (built once, consumed by all renderers)

`accumulate()` is replaced by a per-cycle record builder. The report receives:

```
{
  sub, currency,                 // e.g. "$"
  cycles: [                      // sorted by start date
    { id, startSerial, endSerial, startDate, endDate, year,   // year = endDate year
      pages: { base, overage, total },
      cost:  { base, overage, tax, total } }                  // numbers
  ],
  byYear: Map<year, {            // = cycles grouped & summed by `year`
    spanStart, spanEnd, cycleCount,
    pages: {base, overage, total}, cost: {base, overage, tax, total} }>,
  allTime: { pages, cost },      // cost = sum of total
  avg: { pages: {mean, median}, cost: {mean, median} }  // annualized
}
```

## Rendering (four outputs, same model)

1. **ASCII (`buildText`)** — header (sub, cycle count, span, all-time pages+cost);
   `PER-YEAR AVERAGE` block (mean/median, annualized); `ANNUAL SUMMARY` (per year:
   span, cycle count, pages base/overage/total, cost base/overage/[tax]/total);
   `BILLING CYCLES` grouped by year, one row per cycle.
2. **HTML modal (`openReport`)** — hero gains all-time **cost**; a small
   averages strip; annual rows become stacked **base/overage bars + cost**; the
   per-year 12-column monthly grid becomes **per-cycle rows** (base/overage +
   cost). Same CMYK aesthetic / Shadow DOM.
3. **JSON (`buildJson`)** — `{ subscription, generated_at, currency, all_time,
   annual_average, annual: {year → {...}}, cycles: [...] }`.
4. **CSV (`buildCsv`)** — one row per cycle: `cycle_start, cycle_end, year,
   total_pages, base_pages, overage_pages, base_cost, overage_cost, tax,
   total_cost`.

## Helpers (new)

- `parseMoney(str)` → `{ amount: number, symbol: string }`: strips symbol,
  commas, and trailing non-numeric (`" Plan"`); captures leading currency symbol.
- `fmtMoney(amount, symbol)` → string with 2 decimals + thousands separators.
- `median(nums)` → number.
- Currency is assumed single across the account (first symbol seen wins).

## Edge cases

- **$0 overage cycles** (common): overage pages 0, overage cost `$0.00`.
- **Tax**: shown as its own line/column only when `> 0` (US = `$0.00`).
- **Plan changes mid-history**: each cycle carries its own `plan`/`totals`, so it
  just works.
- **Credits / `previous_overage_total` / carryover**: out of scope for the
  base-vs-overage split. We always show HP's `total_price` as the authoritative
  total; in rare cases where `base + overage + tax ≠ total_price`, the total wins.
- **Empty daily series**: derive the cycle span from the union of all series'
  `x` values; ignore empty ones.

## Testing

`preview.html` mock updated to return realistic `plan` + `totals` (varying
base/overage/cost across cycles, including some zero-overage and at least one
year-straddling cycle). Verify end-to-end via the headless-Chrome screenshot
(catches runtime/TDZ issues `node --check` misses). Confirm: all-time cost,
averages, annual spans, and per-cycle base/overage/cost all render.

## Out of scope

- Calendar-month cost allocation (rejected: fabricates precision HP doesn't give).
- Multi-currency accounts. Instant Paper / add-on cost lines.
