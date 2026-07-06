<!-- Generated from workflows/resolve-accounting-review.md. Edit that source file, then run npm run sync:workflow-prompts. -->

# Resolve Accounting Review

Take one accounting review item and turn it into the next concrete step with the fewest possible user questions.

**Backend routing.** Review items are produced by e-arveldaja's inbox pipeline and `continue_accounting_workflow` is e-arveldaja-native, so resolution normally requires e-arveldaja credentials. One exception: when the item's recommended treatment is a plain ledger operation (create a purchase invoice, post a journal, record a vendor payment) and the user wants it applied to another backend, hand off to that workflow's ledger branch (`book-invoice`, `lightyear-booking`, `reconcile-bank`) instead of improvising here.

## Arguments

- `review_item_json`: JSON object from `autopilot.needs_accountant_review[*].resolver_input` or a direct review item payload

## Workflow

### Step 1: Resolve the review item

Call `continue_accounting_workflow`:
- action: "resolve_review"
- `review_item_json`: the provided JSON object

Treat the tool response as the source of truth:
- `recommendation`
- `compliance_basis`
- `unresolved_questions`
- `suggested_workflow`
- `suggested_tools`
- `next_step_summary`

### Step 2: Present the result in the right order

Always present:
- the recommendation first
- a short plain-language explanation of the compliance basis
- only the unresolved questions, if any
- the next concrete workflow or tool step

For owner-paid expense receipts, Ordinary business VAT defaults to deductible, while likely restricted categories need confirmation unless local rules define the policy.

### Step 3: Keep the interaction minimal

- if `unresolved_questions` is empty, do not invent extra questions
- do not execute any mutating follow-up without explicit approval

### Step 4: When the review item is already understood

If the next step is clear, continue with `continue_accounting_workflow` and `action: "prepare_action"` instead of inventing your own action plan.

`resolve_accounting_review_item` remains available as a compatibility primitive, but prefer the merged continuation tool for new flows.
