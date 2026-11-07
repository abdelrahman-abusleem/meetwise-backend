import {
  EXPORT_GENERATION_CONSUMER,
  ExportGenerationPolicy,
  type ExportGenerationTurnFact,
} from '../domain/export-generation.policy';
import type {
  ExportGenerationRepository,
  GenerationSourceCommand,
} from './export-generation.repository';
import type { ExportGeneratorPort } from './export-generator.port';
import type { ExportObjectStorePort } from './export-object-store.port';
import type { ExportRequestService } from './export-request.service';

export interface ExportGenerationStageFact {
  readonly stage: string;
  readonly exportId: string;

  readonly label?: string;

  readonly storageRef?: string;
  readonly byteLength?: number;
}

export type ExportGenerationTurnOutcome = Readonly<
  | {
      kind: 'REFUSED';
      reason: string;
      preventEnumeration: boolean;
    }
  | {
      kind: 'REPLAYED';
      outcome: string;
      processedAt: string | null;
    }
  | {
      kind: 'CLAIM_REFUSED';
      label: string;
    }
  | {
      kind: 'FAILED';
      stage: 'SOURCE_FACTS' | 'RENDER' | 'STORAGE_DECLINED';
      label: string;
    }
  | {
      kind: 'FAILED_UNREPORTED';
      stage: 'SOURCE_FACTS' | 'RENDER' | 'STORAGE_DECLINED';
      label: string;
    }
  | {
      kind: 'REPORT_REFUSED';
      label: string;
    }
  | { kind: 'UNRESOLVED_STORAGE_EFFECT' }
  | {
      kind: 'COMPLETED';
      storageRef: string;
      byteLength: number;
    }
>;

export class ExportGenerationService {
  private readonly repository: ExportGenerationRepository;
  private readonly exportService: ExportRequestService;
  private readonly generator: ExportGeneratorPort;
  private readonly objectStore: ExportObjectStorePort;
  private readonly policy: ExportGenerationPolicy;

  constructor(
    repository: ExportGenerationRepository,
    exportService: ExportRequestService,
    generator: ExportGeneratorPort,
    objectStore: ExportObjectStorePort,
    policy?: ExportGenerationPolicy,
  ) {
    this.repository = repository;
    this.exportService = exportService;
    this.generator = generator;
    this.objectStore = objectStore;
    this.policy = policy ?? new ExportGenerationPolicy();
  }

  async processGenerationTurn(
    turn: unknown,
  ): Promise<ExportGenerationTurnOutcome> {
    const gate = this.policy.authorizeTurn(turn);
    if (gate.ok !== true) {
      return Object.freeze({
        kind: 'REFUSED' as const,
        reason: gate.reason,
        preventEnumeration: gate.preventEnumeration,
      });
    }
    const fact = turn as ExportGenerationTurnFact;

    const receipt = await this.repository.findInboxOutcome(
      EXPORT_GENERATION_CONSUMER,
      fact.eventId,
    );
    if (receipt !== null) {
      if (
        receipt.consumer !== EXPORT_GENERATION_CONSUMER ||
        receipt.eventId !== fact.eventId ||
        receipt.id !==
          this.policy.composeInboxReceiptId(
            EXPORT_GENERATION_CONSUMER,
            fact.eventId,
          )
      ) {
        throw new Error('export-generation-receipt-identity-mismatch');
      }
      this.requireBoundOutcome(receipt.outcome, fact.exportId);
      return Object.freeze({
        kind: 'REPLAYED' as const,
        outcome: receipt.outcome,
        processedAt: receipt.processedAt,
      });
    }

    const claim = await this.exportService.claimForProcessing({
      exportId: fact.exportId,
    });
    if (claim.ok !== true) {
      const written = await this.recordTurnOutcome(fact, {
        stage: 'CLAIM_REFUSED',
        exportId: fact.exportId,
        label: claim.reason,
      });
      if (written.raced) {
        return this.replayedResult(written.outcome, fact.exportId);
      }
      return Object.freeze({
        kind: 'CLAIM_REFUSED' as const,
        label: claim.reason,
      });
    }

    const source: GenerationSourceCommand = {
      exportId: fact.exportId,
      meetingId: claim.meetingId,
      kind: claim.kind,
      format: claim.format,
    };
    const loaded = await this.repository.loadSourceFacts(source);
    if (loaded.found !== true && loaded.found !== false) {
      throw new Error('export-generation-row-mapping-corrupt');
    }
    if (!loaded.found) {
      if (
        loaded.reason !== 'EXPORT_CONTENT_MISSING' &&
        loaded.reason !== 'SOURCE_KIND_UNMAPPABLE'
      ) {
        throw new Error('export-generation-row-mapping-corrupt');
      }
      return this.declareFailed(fact, 'SOURCE_FACTS', loaded.reason);
    }
    const bundleGate = this.policy.validateSourceBundle(loaded.bundle);
    if (bundleGate.ok !== true) {
      throw new Error('export-generation-row-mapping-corrupt');
    }

    let rendered: Uint8Array;
    try {
      const artifact = await this.generator.renderArtifact({
        exportId: fact.exportId,
        kind: claim.kind,
        format: claim.format,
        sourceRows: loaded.bundle.rows,
      });
      if (
        !(artifact.bytes instanceof Uint8Array) ||
        artifact.bytes.length === 0
      ) {
        throw new Error('export-generator-empty-artifact');
      }
      rendered = artifact.bytes;
    } catch {
      return this.declareFailed(fact, 'RENDER', 'EXPORT_RENDER_FAILED');
    }

    const stored = await this.objectStore.storeArtifact({
      exportId: fact.exportId,
      kind: claim.kind,
      format: claim.format,
      content: rendered,
    });
    if (stored.outcome === 'UNKNOWN_EFFECT') {
      const written = await this.recordTurnOutcome(fact, {
        stage: 'UNRESOLVED_STORAGE',
        exportId: fact.exportId,
      });
      if (written.raced) {
        return this.replayedResult(written.outcome, fact.exportId);
      }
      return Object.freeze({ kind: 'UNRESOLVED_STORAGE_EFFECT' as const });
    }
    if (stored.outcome === 'DECLINED') {
      return this.declareFailed(
        fact,
        'STORAGE_DECLINED',
        'EXPORT_STORAGE_DECLINED',
      );
    }
    if (
      stored.outcome !== 'STORED' ||
      typeof stored.storageRef !== 'string' ||
      stored.storageRef.trim() === '' ||
      typeof stored.byteLength !== 'number' ||
      !Number.isSafeInteger(stored.byteLength) ||
      stored.byteLength <= 0 ||
      stored.byteLength !== rendered.byteLength
    ) {
      throw new Error('export-generation-object-store-contract-violation');
    }

    const report = await this.exportService.reportCompletion({
      exportId: fact.exportId,
      outcome: 'SUCCEEDED',
    });
    if (report.ok !== true) {
      const written = await this.recordTurnOutcome(fact, {
        stage: 'REPORT_REFUSED',
        exportId: fact.exportId,
        label: report.reason,
        storageRef: stored.storageRef,
        byteLength: stored.byteLength,
      });
      if (written.raced) {
        return this.replayedResult(written.outcome, fact.exportId);
      }

      return Object.freeze({
        kind: 'REPORT_REFUSED' as const,
        label: report.reason,
      });
    }

    const done = await this.recordTurnOutcome(fact, {
      stage: 'READY',
      exportId: fact.exportId,
      storageRef: stored.storageRef,
      byteLength: stored.byteLength,
    });
    if (done.raced) {
      return this.replayedResult(done.outcome, fact.exportId);
    }
    return Object.freeze({
      kind: 'COMPLETED' as const,
      storageRef: stored.storageRef,
      byteLength: stored.byteLength,
    });
  }

  private async declareFailed(
    fact: ExportGenerationTurnFact,
    stage: 'SOURCE_FACTS' | 'RENDER' | 'STORAGE_DECLINED',
    label: string,
  ): Promise<ExportGenerationTurnOutcome> {
    const report = await this.exportService.reportCompletion({
      exportId: fact.exportId,
      outcome: 'FAILED',
    });
    const outcomeStage =
      report.ok === true ? `FAILED:${stage}` : `FAILED_REPORT_REFUSED:${stage}`;
    const written = await this.recordTurnOutcome(fact, {
      stage: outcomeStage,
      exportId: fact.exportId,
      label,
    });
    if (written.raced) {
      return this.replayedResult(written.outcome, fact.exportId);
    }
    return Object.freeze(
      report.ok === true
        ? { kind: 'FAILED' as const, stage, label }
        : { kind: 'FAILED_UNREPORTED' as const, stage, label },
    );
  }

  private async recordTurnOutcome(
    fact: ExportGenerationTurnFact,
    stageFact: ExportGenerationStageFact,
  ): Promise<{ raced: boolean; outcome: string | null }> {
    const payload = JSON.stringify(stageFact);
    const write = await this.repository.writeInboxOutcome({
      id: this.policy.composeInboxReceiptId(
        EXPORT_GENERATION_CONSUMER,
        fact.eventId,
      ),
      consumer: EXPORT_GENERATION_CONSUMER,
      eventId: fact.eventId,
      processedAt: fact.processedAt,
      outcome: payload,
    });
    if (write.created === false) {
      return { raced: true, outcome: write.outcome };
    }
    return { raced: false, outcome: null };
  }

  private replayedResult(
    outcome: string | null,
    exportId: string,
  ): ExportGenerationTurnOutcome {
    if (outcome === null) {
      throw new Error('export-generation-receipt-outcome-missing');
    }
    this.requireBoundOutcome(outcome, exportId);
    return Object.freeze({
      kind: 'REPLAYED' as const,
      outcome,
      processedAt: null,
    });
  }

  private requireBoundOutcome(outcome: string, exportId: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome);
    } catch {
      throw new Error('export-generation-receipt-identity-mismatch');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).exportId !== exportId ||
      typeof (parsed as Record<string, unknown>).stage !== 'string'
    ) {
      throw new Error('export-generation-receipt-identity-mismatch');
    }
  }
}
