import type { DuplicateCandidateRecord } from '../domain/duplicate-candidate-review.policy';

export interface DuplicateCandidateRepository {
  findCandidatesByItem(
    itemId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: readonly DuplicateCandidateRecord[];
    nextCursor: string | null;
  }>;
}
