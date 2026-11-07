import type {
  ExportGenerationService,
  ExportGenerationTurnOutcome,
} from '../../application/export-generation.service';

export type ExportGenerationQueueVerdict = 'ACK' | 'DEAD_LETTER';

export interface ExportGenerationTurnRunResult {
  readonly verdict: ExportGenerationQueueVerdict;
  readonly outcome: ExportGenerationTurnOutcome;
}

export interface ExportGenerationWorkerRuntimeOptions {
  readonly service: ExportGenerationService;
}

export class ExportGenerationWorkerRuntime {
  private readonly service: ExportGenerationService;

  constructor(options: ExportGenerationWorkerRuntimeOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      options.service === null ||
      typeof options.service !== 'object'
    ) {
      throw new Error('export-generation-worker-service-required');
    }
    this.service = options.service;
  }

  async runTurn(payload: unknown): Promise<ExportGenerationTurnRunResult> {
    const outcome = await this.service.processGenerationTurn(payload);
    if (outcome.kind === 'REFUSED') {
      return { verdict: 'DEAD_LETTER', outcome };
    }
    return { verdict: 'ACK', outcome };
  }
}
