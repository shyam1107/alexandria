import type { EvalCase } from './metrics';

/**
 * The golden set: a hand-labelled corpus and the questions asked of it.
 *
 * Small enough to hold in your head, large enough that a keyword-only find
 * CAN exist — the corpus is grown past `CANDIDATES_PER_SIGNAL` (50) so the
 * vector leg's top-50 no longer covers everything. That is the property the
 * RRF weight is supposed to tune: with a 20-chunk corpus the vector leg
 * returns the entire corpus on every query, so a chunk only the keyword leg
 * can find cannot exist, and the sweep is an ordering study, not a recall
 * study.
 *
 * The labels here ARE the ground truth, so a wrong label silently becomes a
 * wrong conclusion about retrieval. Generating chunk *text* with a model is
 * fine; deciding *which chunks are relevant to which question* must be
 * deliberate and defensible.
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
      { key: 'tax-compliance', content: 'Applicable VAT or sales tax is calculated based on the billing address and added to the invoice total. Tax-exempt accounts must provide a valid exemption certificate before the billing cycle starts.' },
      { key: 'currency-support', content: 'Invoices are issued in USD by default. Workspaces on annual plans may request EUR or GBP billing; the exchange rate is locked at the start of each billing period.' },
      { key: 'credit-notes', content: 'A credit note is issued when a refunded amount exceeds the current billing period charge. Credit notes do not expire and can be applied to future invoices manually from the billing dashboard.' },
    ],
  },
  {
    title: 'API reference',
    chunks: [
      { key: 'error-429', content: 'Error code E429_RATE_LIMITED is returned when a workspace exceeds its request allowance. The Retry-After header indicates how long to wait before retrying.' },
      { key: 'error-402', content: 'Error code E402_QUOTA_EXCEEDED indicates the workspace has consumed its monthly spend allowance. Generation resumes at the start of the next calendar month.' },
      { key: 'idempotency', content: 'Supply the X-Client-Message-Id header to make a request idempotent. Replaying a request with the same value returns the original response instead of performing the work twice.' },
      { key: 'pagination', content: 'List endpoints accept a cursor parameter. Deep pagination is discouraged; narrow the query with filters instead of walking thousands of pages.' },
      { key: 'error-401', content: 'Error code E401_UNAUTHENTICATED is returned when the access token is missing, expired, or malformed. Refresh the token using the refresh flow before retrying.' },
      { key: 'error-403', content: 'Error code E403_FORBIDDEN is returned when the authenticated user lacks the required role for the operation. Only workspace owners can delete documents or change billing.' },
      { key: 'error-409', content: 'Error code E409_CONFLICT is returned when a request conflicts with the current state, such as uploading a document whose content hash already exists in the workspace.' },
      { key: 'rate-limit-headers', content: 'Every API response includes X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset headers. The reset header is a Unix timestamp indicating when the window rolls over.' },
    ],
  },
  {
    title: 'Security overview',
    chunks: [
      { key: 'tenant-isolation', content: 'Every record belonging to a workspace is fenced off from every other workspace at the database level, so one team can never read another team\u2019s material even if an application bug asks for it.' },
      { key: 'encryption', content: 'Material is encrypted in transit with TLS 1.3 and at rest with AES-256. Encryption keys are rotated annually.' },
      { key: 'token-rotation', content: 'Refresh tokens are single-use. Presenting a refresh token that has already been redeemed invalidates the entire token family, on the assumption that the token was stolen.' },
      { key: 'audit-retention', content: 'Audit events are retained for four hundred days and can be exported by a workspace owner at any time.' },
      { key: 'audit-events', content: 'The audit log records document uploads, deletions, member invitations, role changes, API key rotations, and configuration updates. Each event includes the actor, timestamp, and affected resource.' },
      { key: 'data-residency', content: 'Data residency is enforced at the workspace level. Workspaces created in the EU region store all document content, embeddings, and metadata in Frankfurt data centres and never replicate to other regions.' },
      { key: 'penetration-testing', content: 'Independent penetration testing is conducted annually. The latest report and remediation summary are available to enterprise customers under NDA.' },
    ],
  },
  {
    title: 'Onboarding guide',
    chunks: [
      { key: 'invite-flow', content: 'Workspace owners invite colleagues by email address. An invitation expires after seven days and can be reissued from the members screen.' },
      { key: 'roles', content: 'A member can read and ask questions. An owner can additionally upload material, invite people, and change billing.' },
      { key: 'first-upload', content: 'Supported file types are PDF, DOCX, Markdown and plain text. Files larger than twenty-five megabytes are rejected before upload begins.' },
      { key: 'indexing-delay', content: 'After a file is uploaded it is queued for processing. Large files may take several minutes before their contents become searchable.' },
      { key: 'bulk-import', content: 'The bulk import endpoint accepts up to one hundred files in a single request. Each file is processed independently; a failure in one does not roll back the others.' },
      { key: 'workspace-setup', content: 'A new workspace starts with a single owner. The owner can configure the workspace name, default language, and primary region during setup. Region cannot be changed after creation.' },
    ],
  },
  {
    title: 'Service levels',
    chunks: [
      { key: 'uptime', content: 'The service targets 99.9 percent monthly availability, measured as the proportion of successful requests to the public endpoints over the calendar month.' },
      { key: 'sla-credits', content: 'If monthly availability falls below the target, affected workspaces receive service credits on a sliding scale, requested within thirty days of the incident.' },
      { key: 'maintenance', content: 'Planned maintenance is announced at least five business days ahead and is scheduled outside business hours in the workspace\u2019s primary region.' },
      { key: 'support-hours', content: 'Support responds to critical reports within one hour at any time of day, and to normal reports within one business day.' },
      { key: 'status-page', content: 'Real-time status and historical uptime are published at status.example.com. Subscribe to the status page RSS feed or email alerts for incident notifications.' },
    ],
  },
  {
    title: 'Webhooks and integrations',
    chunks: [
      { key: 'webhook-setup', content: 'Register a webhook URL in the workspace settings. When an event fires the system sends an HTTP POST with a JSON payload to the registered URL.' },
      { key: 'webhook-retry', content: 'Webhook deliveries that do not return a 2xx status code are retried with exponential backoff: after 30 seconds, 2 minutes, 10 minutes, 1 hour, and 6 hours. After the sixth failure the webhook is disabled.' },
      { key: 'webhook-signing', content: 'Every webhook payload is signed with HMAC-SHA256 using the workspace webhook secret. Verify the X-Webhook-Signature header before processing the payload.' },
      { key: 'slack-integration', content: 'Connect a Slack workspace to receive document indexing notifications and daily search summaries in a chosen channel. The integration requires the incoming-webhook OAuth scope.' },
      { key: 'zapier-integration', content: 'A Zapier app is available for no-code automation. It triggers on document uploaded, question answered, and member added events, and supports actions for searching the corpus and uploading files.' },
      { key: 'api-key-rotation', content: 'API keys can be rotated from the workspace settings page. The old key remains valid for a grace period of forty-eight hours after rotation to allow for a zero-downtime cutover.' },
    ],
  },
  {
    title: 'Team management',
    chunks: [
      { key: 'member-roles', content: 'A workspace has two roles: owner and member. Owners can manage billing, invite and remove members, upload and delete documents, and configure integrations. Members can search and ask questions.' },
      { key: 'sso-setup', content: 'Single sign-on is available on enterprise plans. Configure SAML 2.0 with your identity provider using the entity ID and ACS URL provided in the workspace settings. JIT provisioning creates member accounts on first login.' },
      { key: 'sso-attributes', content: 'The SAML assertion must include the email attribute and optionally the displayName attribute. Group-based role mapping is not supported; all provisioned users are created as members.' },
      { key: 'deprovisioning', content: 'When a member is removed their active sessions are revoked immediately. Their question history remains in the workspace for audit purposes but is anonymised after the audit retention period.' },
      { key: 'guest-access', content: 'Guest access is not supported. Every authenticated user must be a workspace member. For external collaboration, share a read-only public link with an expiry date instead.' },
    ],
  },
  {
    title: 'Data handling',
    chunks: [
      { key: 'data-export', content: 'A workspace owner can export all documents, conversations, and audit logs as a ZIP archive. The export is generated asynchronously and a download link is emailed when ready.' },
      { key: 'data-deletion', content: 'Deleting a document removes its content, versions, chunks, and embeddings within thirty days. Metadata about the deletion is retained in the audit log for the full retention period.' },
      { key: 'data-retention', content: 'Conversation history is retained indefinitely unless the workspace owner configures a retention policy. When configured, conversations older than the retention period are permanently deleted on a rolling basis.' },
      { key: 'backup-strategy', content: 'The database is backed up daily with a fourteen-day retention. Point-in-time recovery is available for the last seven days. Backups are encrypted and stored in a separate availability zone.' },
      { key: 'gdpr-requests', content: 'Data subject access and erasure requests are processed through the privacy dashboard. Erasure removes all personal data associated with the requesting user across all workspaces they belong to.' },
      { key: 'data-processing-agreement', content: 'A standard DPA is available for all paid plans. Enterprise customers can negotiate custom terms including sub-processor lists, transfer mechanisms, and breach notification timelines.' },
    ],
  },
  {
    title: 'Search and retrieval',
    chunks: [
      { key: 'hybrid-search', content: 'Retrieval uses hybrid search: a vector leg for semantic similarity and a keyword leg for exact term matching. Results are fused using reciprocal rank fusion with configurable weights.' },
      { key: 'relevance-tuning', content: 'The relative weight of the keyword leg is controlled by the RRF_FTS_WEIGHT environment variable. A higher value surfaces exact-term matches; a lower value defers to semantic similarity.' },
      { key: 'query-rewriting', content: 'Before retrieval, the query is optionally rewritten by the LLM to expand abbreviations and add synonyms. Rewriting is skipped if the query already contains exact identifiers like error codes.' },
      { key: 'citation-format', content: 'Answers include inline citations referencing the source document and chunk. Each citation links back to the original passage with character offsets for verification.' },
      { key: 'refusal-behaviour', content: 'When retrieval returns zero results the system responds with a refusal message stating the corpus does not contain an answer. It does not speculate or use parametric knowledge.' },
    ],
  },
  {
    title: 'Configuration',
    chunks: [
      { key: 'env-vars', content: 'All configuration is via environment variables validated at boot with zod. Invalid or missing required values cause a fail-fast exit before the server starts accepting requests.' },
      { key: 'embedding-model-config', content: 'The embedding model is set by EMBEDDING_MODEL and must match the model used during ingestion. Changing the model without re-indexing makes existing vectors invisible to the vector leg.' },
      { key: 'queue-config', content: 'BullMQ queues are backed by Redis. The ingestion queue has configurable concurrency and retry policies. Failed jobs are moved to a dead-letter queue after the maximum retry count.' },
      { key: 'cors-config', content: 'Cross-origin requests are allowed from configured origins only. The CORS middleware validates the Origin header against the allowlist and rejects unlisted origins with a 403 response.' },
      { key: 'logging-config', content: 'Logs are structured JSON with redaction of sensitive fields. The log level is controlled by LOG_LEVEL and defaults to info in production and debug in development.' },
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
  { id: 'sem-6', kind: 'semantic', question: 'How do I connect a chat app to get notifications?', relevantKeys: ['slack-integration'], note: '"chat app" vs "Slack"; "notifications" vs "indexing notifications and daily search summaries".' },
  { id: 'sem-7', kind: 'semantic', question: 'Can I sign in with our company identity provider?', relevantKeys: ['sso-setup'], note: '"company identity provider" vs "SAML 2.0"; paraphrase throughout.' },
  { id: 'sem-8', kind: 'semantic', question: 'What if I need to download everything we have stored?', relevantKeys: ['data-export'], note: '"download everything" vs "export all documents as a ZIP archive".' },

  // ---- lexical: an exact token decides it, and embeddings blur those ----
  { id: 'lex-1', kind: 'lexical', question: 'E429_RATE_LIMITED', relevantKeys: ['error-429'], note: 'Bare error code. Semantically it is near-identical to the other error chunk.' },
  { id: 'lex-2', kind: 'lexical', question: 'E402_QUOTA_EXCEEDED', relevantKeys: ['error-402'], note: 'The sibling code — the pair is what makes this discriminating.' },
  { id: 'lex-3', kind: 'lexical', question: 'X-Client-Message-Id header', relevantKeys: ['idempotency'], note: 'Exact header name.' },
  { id: 'lex-4', kind: 'lexical', question: 'TLS 1.3 AES-256', relevantKeys: ['encryption'], note: 'Version and cipher strings.' },
  { id: 'lex-5', kind: 'lexical', question: 'What does 99.9 percent mean here?', relevantKeys: ['uptime'], note: 'A number is the discriminating token.' },
  { id: 'lex-6', kind: 'lexical', question: 'E409_CONFLICT', relevantKeys: ['error-409'], note: 'Bare error code — the content-hash conflict is a different concept from billing conflicts.' },
  { id: 'lex-7', kind: 'lexical', question: 'X-RateLimit-Reset', relevantKeys: ['rate-limit-headers'], note: 'Exact header name; the chunk is one of several API-reference chunks that are semantically similar.' },
  { id: 'lex-8', kind: 'lexical', question: 'X-Webhook-Signature', relevantKeys: ['webhook-signing'], note: 'Exact header name. The webhook chunks are semantically similar to each other.' },
  { id: 'lex-9', kind: 'lexical', question: 'HMAC-SHA256', relevantKeys: ['webhook-signing'], note: 'Exact algorithm name that distinguishes the signing chunk from the retry and setup chunks.' },
  { id: 'lex-10', kind: 'lexical', question: 'SAML 2.0', relevantKeys: ['sso-setup'], note: 'Exact protocol version string; the SSO chunks are semantically near-identical.' },

  // ---- both: needs chunks that different legs favour ----
  { id: 'both-1', kind: 'both', question: 'What are my options if the service is down a lot and I want compensation?', relevantKeys: ['uptime', 'sla-credits'] },
  { id: 'both-2', kind: 'both', question: 'How do refunds work for a yearly subscription cancelled halfway through?', relevantKeys: ['refund-window', 'annual-proration'] },
  { id: 'both-3', kind: 'both', question: 'What happens when I hit E429_RATE_LIMITED repeatedly?', relevantKeys: ['error-429'] },
  { id: 'both-4', kind: 'both', question: 'How do I stop a retried request from doing the work twice?', relevantKeys: ['idempotency'] },
  { id: 'both-5', kind: 'both', question: 'When are invoices sent and how long do I have to pay?', relevantKeys: ['invoice-schedule'] },
  { id: 'both-6', kind: 'both', question: 'How do webhook retries work if my endpoint is down?', relevantKeys: ['webhook-retry'] },
  { id: 'both-7', kind: 'both', question: 'Can I lock my data to a specific geographic region?', relevantKeys: ['data-residency'] },
  { id: 'both-8', kind: 'both', question: 'What happens to a removed team member access and data?', relevantKeys: ['deprovisioning'] },

  // ---- refusal: nothing in the corpus answers these ----
  { id: 'ref-1', kind: 'refusal', question: 'What is the capital city of Portugal?', relevantKeys: [], note: 'General knowledge, absent from the corpus.' },
  { id: 'ref-2', kind: 'refusal', question: 'Does the product integrate with Salesforce?', relevantKeys: [], note: 'Plausible product question the corpus never addresses — the dangerous kind.' },
  { id: 'ref-3', kind: 'refusal', question: 'What is the phone number for emergency support?', relevantKeys: [], note: 'Adjacent to a real chunk (support hours) but asks for a fact that is not there.' },
  { id: 'ref-4', kind: 'refusal', question: 'Can I deploy this on my own Kubernetes cluster?', relevantKeys: [], note: 'Self-hosting question; the corpus discusses SaaS configuration, not deployment.' },
];