import type { ExportGeneratorPort } from '../../application/export-generator.port';
import type { ExportObjectStorePort } from '../../application/export-object-store.port';
import { ExportJsonCsvRenderer } from '../../application/export-json-csv-renderer';
import { LocalExportObjectStore } from './local-export-object-store';

export interface ExportArtifactAdapters {
  readonly generator: ExportGeneratorPort;
  readonly objectStore: ExportObjectStorePort;
}

export function composeExportArtifactAdapters(
  rootDirectory: string,
): ExportArtifactAdapters {
  return Object.freeze({
    generator: new ExportJsonCsvRenderer(),
    objectStore: new LocalExportObjectStore({ rootDirectory }),
  });
}
