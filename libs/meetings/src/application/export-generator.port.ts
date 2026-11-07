export interface ExportRenderCommand {
  readonly exportId: string;

  readonly kind: string;

  readonly format: string;

  readonly sourceRows: Readonly<
    Readonly<Record<string, string | number | boolean | null>>
  >[];
}

export interface ExportRenderResult {
  readonly bytes: Uint8Array;
}

export interface ExportGeneratorPort {
  renderArtifact(command: ExportRenderCommand): Promise<ExportRenderResult>;
}
