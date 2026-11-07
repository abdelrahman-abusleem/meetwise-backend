import { fingerprint64 } from './approve-remaining.policy';

export const EXPORT_GENERATION_CONSUMER = 'export-generation';

export type ExportGenerationFailure =
  'INVALID_REQUEST' | 'DECISION_FACTS_REQUIRED';

export type ExportGenerationDecision = Readonly<
  | { ok: true }
  | {
      ok: false;
      reason: ExportGenerationFailure;
      preventEnumeration: boolean;
    }
>;

export interface ExportGenerationTurnFact {
  readonly eventId: string;
  readonly exportId: string;
  readonly processedAt: string;
}

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const MAX_SOURCE_BUNDLE_ROWS = 10_000;

export class ExportGenerationPolicy {
  authorizeTurn(fact: unknown): ExportGenerationDecision {
    if (fact === null || typeof fact !== 'object') {
      return Object.freeze({
        ok: false as const,
        reason: 'INVALID_REQUEST',
        preventEnumeration: false,
      });
    }
    const turn = fact as Partial<ExportGenerationTurnFact>;
    if (
      typeof turn.eventId !== 'string' ||
      turn.eventId.trim() === '' ||
      typeof turn.exportId !== 'string' ||
      turn.exportId.trim() === '' ||
      typeof turn.processedAt !== 'string' ||
      turn.processedAt.trim() === '' ||
      !ISO_8601_INSTANT.test(turn.processedAt)
    ) {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    return Object.freeze({ ok: true as const });
  }

  composeInboxReceiptId(consumer: string, eventId: string): string {
    const canonical = `${consumer.length}:${consumer}|${eventId.length}:${eventId}`;
    return fingerprint64(canonical);
  }

  validateSourceBundle(bundle: unknown): ExportGenerationDecision {
    if (bundle === null || typeof bundle !== 'object') {
      return Object.freeze({
        ok: false as const,
        reason: 'INVALID_REQUEST',
        preventEnumeration: false,
      });
    }
    const facts = (bundle as Record<string, unknown>).rows;
    if (
      !Array.isArray(facts) ||
      facts.length === 0 ||
      facts.length > MAX_SOURCE_BUNDLE_ROWS
    ) {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    for (const row of facts) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return Object.freeze({
          ok: false as const,
          reason: 'DECISION_FACTS_REQUIRED',
          preventEnumeration: false,
        });
      }
      for (const [key, value] of Object.entries(
        row as Record<string, unknown>,
      )) {
        if (typeof key !== 'string' || key.trim() === '') {
          return Object.freeze({
            ok: false as const,
            reason: 'DECISION_FACTS_REQUIRED',
            preventEnumeration: false,
          });
        }
        const scalar =
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null;
        if (!scalar) {
          return Object.freeze({
            ok: false as const,
            reason: 'DECISION_FACTS_REQUIRED',
            preventEnumeration: false,
          });
        }
      }
    }
    return Object.freeze({ ok: true as const });
  }
}
