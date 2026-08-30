/**
 * Abort REASONS for the two Phase 7 deadlines in the chat request path.
 *
 * Phase 6's lesson, applied one layer up: aborting with a reason is what
 * lets the persistence path tell "our deadline fired" apart from "the client
 * hung up" — the two persist differently, and only one of them means the
 * user left. A bare abort() leaves signal.reason as a generic AbortError
 * that every catch block reads as "client_disconnect".
 */
export class PreFrameDeadlineError extends Error {
  constructor() {
    super('Chat could not start in time');
    this.name = 'PreFrameDeadlineError';
  }
}

export class RewriteBudgetError extends Error {
  constructor() {
    super('The query rewrite exceeded its budget and was abandoned');
    this.name = 'RewriteBudgetError';
  }
}