/**
 * Monthly LLM spend cap per workspace, in micro-USD.
 *
 * Why a constant and not env: this is a PLAN FEATURE, not an environment
 * fact. Deployment does not change what a customer bought; a pricing change
 * is a product decision with git history, same as the price table itself.
 *
 * 500,000 micro-USD = $0.50/month. Demo-scale number: roughly 660
 * gemini-3.1-flash-lite answers (prompt ~1,500 tok, completion ~250 tok at
 * $0.25/$1.50 per 1M) before the month's cap trips. Generous enough to
 * demo freely, small enough that an abusive tenant cannot rack up real
 * vendor spend. Ollama costs are declared zero and never count against it,
 * which is correct: the quota bounds METERED spend.
 *
 * That headline number is model-dependent to a degree worth stating: on a
 * THINKING model the same cap buys ~45 answers, not ~660, because thinking
 * tokens bill at output rates and outnumbered visible tokens ~10:1 in a live
 * probe. Change GEMINI_MODEL to a reasoning model and this comment is a lie —
 * recompute it, and expect quota complaints an order of magnitude sooner.
 *
 * The counter and the ledger can disagree (Redis flush loses the counter;
 * the ledger is truth). The counter is the fast-path check; the reconcile
 * job that rebuilds it from the ledger belongs to Phase 9 ops.
 */
export const QUOTA_MONTHLY_MICRO_USD = 500_000;