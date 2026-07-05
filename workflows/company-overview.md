# Company Overview

Prepare a compact financial overview for the active company. The full dashboard needs e-arveldaja's reporting tools; other ledger backends get a lighter read-only overview.

This workflow is read-only. It should feel like a dashboard, not a ledger export.

## Step 0: Choose the backend

Default to e-arveldaja when it is configured. Switch to the **ledger branch** when the user names another backend or the session is a ledger session (check `list_ledger_backends` when unsure).

### Ledger branch (any non-e-arveldaja backend)

Backend-neutral reporting (`trialBalance` / `incomeStatement`) is not exposed as tools yet, so build a lighter overview from the list reads, all with the target `backend`:

1. `ledger_list_sales_invoices` and `ledger_list_purchase_invoices` for the selected period (both default to the last ~90 days; Merit caps queries at ~3 months — for a longer period, page through in ~90-day windows).
2. Summarize: sales volume and count, purchase volume and count, unpaid/partial invoices on each side (the canonical `settle` field), and anything overdue by `dueDate`.
3. State clearly that balance-sheet and P&L figures are not available through this backend's port yet, and name the backend in the summary.

Then stop — the remaining steps are the e-arveldaja recipe.

## Period selection

- If the user asks for a specific date, use it as the reporting date.
- If no date is requested, use today's date as the reporting date.
- If the user asks for a specific period, use its first day as `date_from`.
- If no period is requested, use the first day of the current year as `date_from`.
- State the chosen `date_from` and reporting date in the summary.
- If the user says they recently changed data in the e-arveldaja web UI or asks for fresh numbers, call `clear_cache` before reading reports.

Follow these steps:

1. Call `compute_balance_sheet` with date_to: the selected reporting date.
2. Call `compute_profit_and_loss` with date_from: the selected period start and date_to: the selected reporting date.
3. Call `compute_receivables_aging`.
4. Call `compute_payables_aging`.
5. Summarize the company state using the returned figures:
   - balance-sheet health and whether the check balances
   - profit or loss for the period
   - overdue receivables
   - overdue payables
   - any visible blockers or follow-up checks

Use this output shape:
- Reporting period
- Balance sheet status
- Profit/loss for the period
- Receivables needing attention
- Payables needing attention
- Next recommended check

Do not create, update, confirm, send, or delete records in this workflow.
