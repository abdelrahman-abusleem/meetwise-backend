import type { ExportGenerationTurnFact } from '../domain/export-generation.policy';
import { EXPORT_GENERATION_CONSUMER } from '../domain/export-generation.policy';

export const GENERATION_INBOX_CONSUMER = EXPORT_GENERATION_CONSUMER;

export interface ExportGenerationInboxReceipt {
  readonly id: string;
  readonly consumer: string;
  readonly eventId: string;
  readonly processedAt: string;

  readonly outcome: string;
}

export interface GenerationSourceCommand {
  readonly exportId: string;
  readonly meetingId: string;
  readonly kind: string;
  readonly format: string;
}

export interface GenerationSourceBundle {
  readonly rows: Readonly<
    Readonly<Record<string, string | number | boolean | null>>
  >[];
}

export type GenerationSourceOutcome =
  | Readonly<{ found: true; bundle: GenerationSourceBundle }>
  | Readonly<{
      found: false;
      reason: 'EXPORT_CONTENT_MISSING' | 'SOURCE_KIND_UNMAPPABLE';
    }>;

export interface ExportGenerationInboxWrite {
  readonly created: boolean;
  readonly outcome: string | null;
}

export interface ExportGenerationRepository {
  findInboxOutcome(
    consumer: string,
    eventId: string,
  ): Promise<ExportGenerationInboxReceipt | null>;

  writeInboxOutcome(
    receipt: ExportGenerationInboxReceipt,
  ): Promise<ExportGenerationInboxWrite>;

  loadSourceFacts(
    command: GenerationSourceCommand,
  ): Promise<GenerationSourceOutcome>;
}

export type { ExportGenerationTurnFact };
