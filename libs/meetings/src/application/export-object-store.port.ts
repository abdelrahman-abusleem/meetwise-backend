export interface ExportStoreCommand {
  readonly exportId: string;
  readonly kind: string;
  readonly format: string;

  readonly content: Uint8Array;
}

export type ExportStorageOutcome = Readonly<
  | {
      outcome: 'STORED';

      storageRef: string;
      byteLength: number;
    }
  | {
      outcome: 'DECLINED';

      declineReason: string;
    }
  | { outcome: 'UNKNOWN_EFFECT' }
>;

export interface ExportObjectStorePort {
  storeArtifact(command: ExportStoreCommand): Promise<ExportStorageOutcome>;
}
