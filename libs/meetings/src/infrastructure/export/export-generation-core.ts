import { ExportGenerationService } from '../../application/export-generation.service';
import type { ExportGenerationRepository } from '../../application/export-generation.repository';
import type { ExportRequestService } from '../../application/export-request.service';
import { composeExportArtifactAdapters } from './export-artifact-adapters';
import { ExportGenerationWorkerRuntime } from './export-generation-worker';

export interface ExportGenerationCoreConfig {
  readonly repository: ExportGenerationRepository;
  readonly exportService: ExportRequestService;
  readonly storeRoot: string;
}

export function composeExportGenerationCore(
  config: ExportGenerationCoreConfig,
) {
  if (
    !config ||
    typeof config.repository !== 'object' ||
    config.repository === null ||
    typeof config.exportService !== 'object' ||
    config.exportService === null
  ) {
    throw new Error('export-generation-core-dependencies-required');
  }
  const { generator, objectStore } = composeExportArtifactAdapters(
    config.storeRoot,
  );
  const service = new ExportGenerationService(
    config.repository,
    config.exportService,
    generator,
    objectStore,
  );
  const worker = new ExportGenerationWorkerRuntime({ service });
  return Object.freeze({
    repository: config.repository,
    objectStore,
    generator,
    service,
    worker,
  });
}
