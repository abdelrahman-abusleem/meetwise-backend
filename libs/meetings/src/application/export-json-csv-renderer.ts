import type {
  ExportGeneratorPort,
  ExportRenderCommand,
  ExportRenderResult,
} from './export-generator.port';

const EXPORT_RENDER_KINDS: Readonly<string[]> = Object.freeze([
  'SUMMARY',
  'TRANSCRIPT',
  'ANALYSIS',
]);

const EXPORT_RENDER_FORMATS: Readonly<string[]> = Object.freeze([
  'JSON',
  'CSV',
]);

type ScalarCell = string | number | boolean | null;

function isScalarCell(value: unknown): value is ScalarCell {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return false;
}

export class ExportJsonCsvRenderer implements ExportGeneratorPort {
  renderArtifact(command: unknown): Promise<ExportRenderResult> {
    return Promise.resolve().then(() => this.renderValidatedArtifact(command));
  }

  private renderValidatedArtifact(command: unknown): ExportRenderResult {
    if (command === null || typeof command !== 'object') {
      throw new Error('export-render-command-shape-defect');
    }
    const cmd = command as Partial<ExportRenderCommand>;
    if (
      typeof cmd.exportId !== 'string' ||
      cmd.exportId.trim() === '' ||
      typeof cmd.kind !== 'string' ||
      typeof cmd.format !== 'string'
    ) {
      throw new Error('export-render-command-shape-defect');
    }
    if (!Array.isArray(cmd.sourceRows)) {
      throw new Error('export-render-source-shape-defect');
    }
    if (
      EXPORT_RENDER_KINDS.indexOf(cmd.kind) === -1 ||
      EXPORT_RENDER_FORMATS.indexOf(cmd.format) === -1
    ) {
      throw new Error('export-render-format-unsupported');
    }
    const rows = cmd.sourceRows as Readonly<
      Readonly<Record<string, ScalarCell>>
    >[];

    const serializedRows: Readonly<Record<string, ScalarCell>>[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('export-render-source-shape-defect');
      }
      serializedRows.push(this.requireScalarRow(descriptor.value));
    }
    const bytes =
      cmd.format === 'JSON'
        ? new TextEncoder().encode(JSON.stringify(serializedRows))
        : new TextEncoder().encode(this.composeCsv(serializedRows));
    return Object.freeze({ bytes });
  }

  private composeCsv(rows: Readonly<Record<string, ScalarCell>>[]): string {
    if (rows.length === 0) {
      return '';
    }
    const header: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (header.indexOf(key) === -1) {
          header.push(key);
        }
      }
    }
    header.sort();
    const lines: string[] = [
      header.map((key) => composeCsvCell(key)).join(','),
    ];
    for (const row of rows) {
      lines.push(
        header.map((key) => composeCsvCell(row[key] ?? null)).join(','),
      );
    }
    return lines.join('\r\n') + '\r\n';
  }

  private requireScalarRow(row: unknown): Readonly<Record<string, ScalarCell>> {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('export-render-source-shape-defect');
    }

    const snapshot = Object.create(null) as Record<string, ScalarCell>;
    for (const key of Object.keys(row)) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      const value: unknown = descriptor?.value;
      if (!descriptor || !('value' in descriptor) || !isScalarCell(value)) {
        throw new Error('export-render-source-shape-defect');
      }
      snapshot[key] = value;
    }
    return Object.freeze(snapshot);
  }
}

const CSV_INJECTION_TRIGGERS = Object.freeze(['=', '+', '-', '@', '\t', '\r']);

function isCsvInjectionTrigger(text: string): boolean {
  return CSV_INJECTION_TRIGGERS.indexOf(text.charAt(0)) !== -1;
}

function composeCsvCell(value: ScalarCell | undefined): string {
  if (value === null) {
    return '';
  }
  let text: string;
  if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else {
    text = String(value);
  }
  if (text === '') {
    return '""';
  }
  if (typeof value === 'string' && isCsvInjectionTrigger(text)) {
    text = "'" + text;
  }
  if (
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\r') ||
    text.includes('\n')
  ) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}
