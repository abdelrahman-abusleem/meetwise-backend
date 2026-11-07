import type {
  DuplicateCandidateRecord,
  DuplicateReviewFailureDecision,
} from '../domain/duplicate-candidate-review.policy';
import { DuplicateCandidateReviewPolicy } from '../domain/duplicate-candidate-review.policy';
import type { DuplicateCandidateRepository } from './duplicate-review.repository';

export type { DuplicateCandidateRepository } from './duplicate-review.repository';

export interface ListCandidatesQuery {
  readonly accessibleItem: boolean;
  readonly itemId: string;
  readonly currentItemVersion: number;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListCandidatesResult {
  readonly ok: true;
  readonly itemId: string;
  readonly candidateCount: number;
  readonly candidates: readonly DuplicateCandidateRecord[];
  readonly nextCursor: string | null;

  readonly pageHasCandidates: boolean;
}

export type ListCandidatesDecision =
  ListCandidatesResult | DuplicateReviewFailureDecision;

export class DuplicateReviewService {
  private readonly policy: DuplicateCandidateReviewPolicy;
  private readonly repository: DuplicateCandidateRepository;

  constructor(
    repository: DuplicateCandidateRepository,
    policy?: DuplicateCandidateReviewPolicy,
  ) {
    this.repository = repository;
    this.policy = policy ?? new DuplicateCandidateReviewPolicy();
  }

  async listCandidates(
    query: ListCandidatesQuery,
  ): Promise<ListCandidatesDecision> {
    if (query === null || typeof query !== 'object') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
      });
    }
    if (
      query.accessibleItem !== undefined &&
      query.accessibleItem !== true &&
      query.accessibleItem !== false
    ) {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
      });
    }
    if (
      (query.cursor !== undefined && typeof query.cursor !== 'string') ||
      (query.limit !== undefined &&
        (!Number.isSafeInteger(query.limit) || query.limit < 0))
    ) {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
      });
    }

    const gate = this.policy.authorizeCandidateListing({
      accessibleItem: query.accessibleItem,
      itemId: query.itemId,
      currentItemVersion: query.currentItemVersion,
    });
    if (gate.ok !== true) {
      return gate;
    }

    const page = await this.repository.findCandidatesByItem(
      query.itemId,
      query.cursor,
      query.limit,
    );
    if (
      page === null ||
      typeof page !== 'object' ||
      !Array.isArray(page.items)
    ) {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
      });
    }

    const context = {
      itemId: query.itemId,
      currentItemVersion: query.currentItemVersion,
    };

    const candidates: DuplicateCandidateRecord[] = [];
    for (const record of page.items) {
      const failure = this.policy.validateCandidateRecord(record, context);
      if (failure !== null) {
        return failure;
      }
      const typed = record as DuplicateCandidateRecord;
      candidates.push(
        Object.freeze({
          id: typed.id,
          itemId: typed.itemId,
          itemVersion: typed.itemVersion,
          source: typed.source,
          candidateRef: typed.candidateRef,
          score: typed.score,
          computedAt: typed.computedAt,
          safePreview: typed.safePreview,
        }),
      );
    }

    if (page.nextCursor !== null && typeof page.nextCursor !== 'string') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
      });
    }

    return Object.freeze({
      ok: true as const,
      itemId: query.itemId,
      candidateCount: candidates.length,
      candidates: Object.freeze(candidates),
      nextCursor: page.nextCursor,
      pageHasCandidates: candidates.length > 0,
    });
  }

  validateIncomingCandidate(
    record: unknown,
    context: { itemId: string; currentItemVersion: number },
  ): { ok: true } | DuplicateReviewFailureDecision {
    const failure = this.policy.validateCandidateRecord(record, context);
    if (failure !== null) {
      return failure;
    }
    return Object.freeze({ ok: true as const });
  }
}
