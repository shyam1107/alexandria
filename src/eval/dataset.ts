import type { EvalCase } from './metrics';

/**
 * The golden set: a small hand-labelled corpus and the questions asked of it.
 *
 * Small on purpose. A hand-labelled set of ~30 chunks that a reader can hold
 * in their head beats a large auto-labelled one whose errors nobody can see —
 * and the labels here ARE the ground truth, so a wrong label silently becomes
 * a wrong conclusion about retrieval.
 *
 * It is built to be diagnostic rather than merely realistic. The cases are
 * chosen so the three retrieval strategies must disagree:
 *
 *  - `semantic` cases paraphrase the corpus with almost no shared vocabulary.
 *    Keyword search cannot find them; embeddings can.
 *  - `lexical` cases hinge on an exact token — an error code, a header name,
 *    a version string. Embeddings blur those together; FTS matches them
 *    precisely. This is the class that motivated hybrid search in Phase 4.
 *  - `both` cases need chunks that only one leg finds, so fusion has to beat
 *    either leg alone.
 *  - `refusal` cases are answerable by nothing in the corpus. They are not
 *    ranking questions and are scored separately: the system should say it
 *    does not know.
 */

export interface EvalDocument {
  title: string;
  chunks: Array<{ key: string; content: string }>;
}

export const EVAL_DOCUMENTS: EvalDocument[] = [
  {
    title: 'Billing policy',
    chunks: [
      { key: 'refund-window', content: 'Customers may request a full refund within thirty days of the original purchase date. After thirty days, refunds are prorated against the remaining term.' },
      { key: 'annual-proration', content: 'Annual plans cancelled mid-term are credited for whole unused months. Partial months are not credited and the credit is applied to the next invoice rather than returned to the card.' },
      { key: 'invoice-schedule', content: 'Invoices are generated on the first business day of each month and are payable within fourteen days of issue.' },
      { key: 'dunning', content: 'When a payment fails we retry the charge after one day, then three days, then seven days. After the third failure the workspace moves to a read-only state until billing is resolved.' },
    ],
  },
  {
    title: 'API reference',
    chunks: [
      { key: 'error-429', content: 'Error code E429_RATE_LIMITED is returned when a workspace exceeds its request allowance. The Retry-After header indicates how long to wait before retrying.' },
      { key: 'error-402', content: 'Error code E402_QUOTA_EXCEEDED indicates the workspace has consumed its monthly spend allowance. Generation resumes at the start of the next calendar month.' },
      { key: 'idempotency', content: 'Supply the X-Client-Message-Id header to make a request idempotent. Replaying a request with the same value returns the original response instead of performing the work twice.' },
      { key: 'pagination', content: 'List endpoints accept a cursor parameter. Deep pagination is discouraged; narrow the query with filters instead of walking thousands of pages.' },
    ],
  },
  {
    title: 'Security overview',
    chunks: [
      { key: 'tenant-isolation', content: 'Every record belonging to a workspace is fenced off from every other workspace at the database level, so one team can never read another team’s material even if an application bug asks for it.' },
      { key: 'encryption', content: 'Material is encrypted in transit with TLS 1.3 and at rest with AES-256. Encryption keys are rotated annually.' },
      { key: 'token-rotation', content: 'Refresh tokens are single-use. Presenting a refresh token that has already been redeemed invalidates the entire token family, on the assumption that the token was stolen.' },
      { key: 'audit-retention', content: 'Audit events are retained for four hundred days and can be exported by a workspace owner at any time.' },
    ],
  },
  {
    title: 'Onboarding guide',
    chunks: [
      { key: 'invite-flow', content: 'Workspace owners invite colleagues by email address. An invitation expires after seven days and can be reissued from the members screen.' },
      { key: 'roles', content: 'A member can read and ask questions. An owner can additionally upload material, invite people, and change billing.' },
      { key: 'first-upload', content: 'Supported file types are PDF, DOCX, Markdown and plain text. Files larger than twenty-five megabytes are rejected before upload begins.' },
      { key: 'indexing-delay', content: 'After a file is uploaded it is queued for processing. Large files may take several minutes before their contents become searchable.' },
    ],
  },
  {
    title: 'Service levels',
    chunks: [
      { key: 'uptime', content: 'The service targets 99.9 percent monthly availability, measured as the proportion of successful requests to the public endpoints over the calendar month.' },
      { key: 'sla-credits', content: 'If monthly availability falls below the target, affected workspaces receive service credits on a sliding scale, requested within thirty days of the incident.' },
      { key: 'maintenance', content: 'Planned maintenance is announced at least five business days ahead and is scheduled outside business hours in the workspace’s primary region.' },
      { key: 'support-hours', content: 'Support responds to critical reports within one hour at any time of day, and to normal reports within one business day.' },
    ],
  },
];

export type EvalKind = 'semantic' | 'lexical' | 'both' | 'refusal';

export interface LabelledCase extends Omit<EvalCase, 'relevantChunkIds'> {
  kind: EvalKind;
  /** Chunk KEYS from the corpus above; mapped to database ids at seed time. */
  relevantKeys: string[];
}

export const EVAL_CASES: LabelledCase[] = [
  // ---- semantic: the answer shares almost no vocabulary with the question ----
  { id: 'sem-1', kind: 'semantic', question: 'Can I get my money back if I change my mind quickly?', relevantKeys: ['refund-window'], note: 'No shared content word with the chunk beyond "refund" being absent entirely.' },
  { id: 'sem-2', kind: 'semantic', question: 'What happens if my card keeps getting declined?', relevantKeys: ['dunning'], note: '"declined" never appears; the chunk says "payment fails".' },
  { id: 'sem-3', kind: 'semantic', question: 'Could a different company using this product see our documents?', relevantKeys: ['tenant-isolation'], note: 'The chunk deliberately avoids the words tenant, isolation and workspace-scoping.' },
  { id: 'sem-4', kind: 'semantic', question: 'How long until something I just added shows up in answers?', relevantKeys: ['indexing-delay'], note: 'Paraphrase of queue latency.' },
  { id: 'sem-5', kind: 'semantic', question: 'Who is allowed to add new material?', relevantKeys: ['roles'], note: '"upload" vs "add new material".' },

  // ---- lexical: an exact token decides it, and embeddings blur those ----
  { id: 'lex-1', kind: 'lexical', question: 'E429_RATE_LIMITED', relevantKeys: ['error-429'], note: 'Bare error code. Semantically it is near-identical to the other error chunk.' },
  { id: 'lex-2', kind: 'lexical', question: 'E402_QUOTA_EXCEEDED', relevantKeys: ['error-402'], note: 'The sibling code — the pair is what makes this discriminating.' },
  { id: 'lex-3', kind: 'lexical', question: 'X-Client-Message-Id header', relevantKeys: ['idempotency'], note: 'Exact header name.' },
  { id: 'lex-4', kind: 'lexical', question: 'TLS 1.3 AES-256', relevantKeys: ['encryption'], note: 'Version and cipher strings.' },
  { id: 'lex-5', kind: 'lexical', question: 'What does 99.9 percent mean here?', relevantKeys: ['uptime'], note: 'A number is the discriminating token.' },

  // ---- both: needs chunks that different legs favour ----
  { id: 'both-1', kind: 'both', question: 'What are my options if the service is down a lot and I want compensation?', relevantKeys: ['uptime', 'sla-credits'] },
  { id: 'both-2', kind: 'both', question: 'How do refunds work for a yearly subscription cancelled halfway through?', relevantKeys: ['refund-window', 'annual-proration'] },
  { id: 'both-3', kind: 'both', question: 'What happens when I hit E429_RATE_LIMITED repeatedly?', relevantKeys: ['error-429'] },
  { id: 'both-4', kind: 'both', question: 'How do I stop a retried request from doing the work twice?', relevantKeys: ['idempotency'] },
  { id: 'both-5', kind: 'both', question: 'When are invoices sent and how long do I have to pay?', relevantKeys: ['invoice-schedule'] },

  // ---- refusal: nothing in the corpus answers these ----
  { id: 'ref-1', kind: 'refusal', question: 'What is the capital city of Portugal?', relevantKeys: [], note: 'General knowledge, absent from the corpus.' },
  { id: 'ref-2', kind: 'refusal', question: 'Does the product integrate with Salesforce?', relevantKeys: [], note: 'Plausible product question the corpus never addresses — the dangerous kind.' },
  { id: 'ref-3', kind: 'refusal', question: 'What is the phone number for emergency support?', relevantKeys: [], note: 'Adjacent to a real chunk (support hours) but asks for a fact that is not there.' },
];
