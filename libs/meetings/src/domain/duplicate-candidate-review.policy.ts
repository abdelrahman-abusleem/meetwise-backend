export interface DuplicateCandidateRecord {
  readonly id: string;
  readonly itemId: string;
  readonly itemVersion: number;
  readonly source: string;
  readonly candidateRef: string;
  readonly score: number;
  readonly computedAt: string;
  readonly safePreview: string;
}

export interface DuplicateRecordContext {
  readonly itemId: string;

  readonly currentItemVersion: number;
}

export type DuplicateReviewFailure =
  | 'INVALID_REQUEST'
  | 'DECISION_FACTS_REQUIRED'
  | 'ACCESS_NOT_AUTHORIZED'
  | 'CANDIDATE_OUT_OF_SCOPE'
  | 'CANDIDATE_VERSION_EXCEEDS_ITEM';

export type DuplicateReviewFailureDecision = Readonly<{
  ok: false;
  reason: DuplicateReviewFailure;
}>;

export type DuplicateReviewDecision =
  Readonly<{ ok: true; itemId: string }> | DuplicateReviewFailureDecision;

export class DuplicateCandidateReviewPolicy {
  authorizeCandidateListing(request: unknown): DuplicateReviewDecision {
    if (request === null || typeof request !== 'object') {
      return this.reject('INVALID_REQUEST');
    }
    const facts = request as {
      accessibleItem?: unknown;
      itemId?: unknown;
      currentItemVersion?: unknown;
    };
    if (typeof facts.itemId !== 'string' || facts.itemId.trim() === '') {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (!this.isSafeVersion(facts.currentItemVersion)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (
      facts.accessibleItem !== undefined &&
      facts.accessibleItem !== true &&
      facts.accessibleItem !== false
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (facts.accessibleItem !== true) {
      return this.reject('ACCESS_NOT_AUTHORIZED');
    }
    return Object.freeze({ ok: true as const, itemId: facts.itemId });
  }

  validateCandidateRecord(
    record: unknown,
    context: DuplicateRecordContext,
  ): DuplicateReviewFailureDecision | null {
    if (context === null || typeof context !== 'object') {
      return this.reject('INVALID_REQUEST');
    }
    if (typeof context.itemId !== 'string' || context.itemId.trim() === '') {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (!this.isSafeVersion(context.currentItemVersion)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (record === null || typeof record !== 'object') {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const candidate = record as Partial<DuplicateCandidateRecord>;
    for (const field of [
      'id',
      'itemId',
      'source',
      'candidateRef',
      'computedAt',
      'safePreview',
    ] as const) {
      const value = candidate[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED');
      }
    }
    if (
      typeof candidate.score !== 'number' ||
      !Number.isFinite(candidate.score)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (!this.isSafeVersion(candidate.itemVersion)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (candidate.itemId !== context.itemId) {
      return this.reject('CANDIDATE_OUT_OF_SCOPE');
    }
    if (candidate.itemVersion > context.currentItemVersion) {
      return this.reject('CANDIDATE_VERSION_EXCEEDS_ITEM');
    }
    return null;
  }

  private isSafeVersion(value: unknown): value is number {
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    );
  }

  private reject(
    reason: DuplicateReviewFailure,
  ): DuplicateReviewFailureDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}
