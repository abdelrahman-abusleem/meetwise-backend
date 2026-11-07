type ExportKind = 'SUMMARY' | 'TRANSCRIPT' | 'ANALYSIS';

type ExportCommand =
  'REQUEST_EXPORT' | 'WORKER_EXPORT_GATE' | 'DOWNLOAD_EXPORT';

type ExportSurface = 'API' | 'WORKER' | 'DOWNLOAD';

type ItemStatusForExport = 'PENDING' | 'NEEDS_EDITS' | 'REJECTED' | 'APPROVED';

export interface ExportSourceItem {
  readonly id: string;
  readonly status: string;
}

export interface ExportRequestRequest {
  readonly command: string;
  readonly kind: string;
  readonly meetingKind: string;
  readonly surface: string;

  readonly exporterAuthorized?: boolean;

  readonly idempotencyKeyProvided?: boolean;

  readonly sourceItems?: ExportSourceItem[];
}

export interface ExportRequestOutcome {
  readonly ok: true;
  readonly command: ExportCommand;
  readonly kind: ExportKind;
  readonly meetingKind: string;
  readonly surface: ExportSurface;

  readonly jobCreationIsServerDuty: true;

  readonly auditExportDecision: true;
}

export type ExportRequestDecision =
  ExportRequestOutcome | Readonly<{ ok: false; reason: ExportRequestFailure }>;

export type ExportRequestFailure =
  | 'INVALID_COMMAND'
  | 'INVALID_EXPORT_KIND'
  | 'UNKNOWN_ITEM_STATUS'
  | 'DECISION_FACTS_REQUIRED'
  | 'SOURCE_ITEMS_NOT_ACCEPTED_ON_REQUEST'
  | 'GENERAL_EXPORT_REJECTED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'EXPORTER_NOT_AUTHORIZED'
  | 'SOURCE_ITEMS_REQUIRED'
  | 'REJECTED_ITEM_NOT_EXPORTABLE'
  | 'DOWNLOAD_NOT_AUTHORIZED';

const EXPORT_KINDS: Readonly<ExportKind[]> = [
  'SUMMARY',
  'TRANSCRIPT',
  'ANALYSIS',
];

const MEETING_KINDS: Readonly<string[]> = ['TECH', 'SALES', 'GENERAL'];

const ITEM_STATUSES: Readonly<ItemStatusForExport[]> = [
  'PENDING',
  'NEEDS_EDITS',
  'REJECTED',
  'APPROVED',
];

export class ExportRequestPolicy {
  evaluate(request: ExportRequestRequest): ExportRequestDecision {
    if (request === null || typeof request !== 'object') {
      return this.reject('INVALID_COMMAND');
    }
    if (
      request.command !== 'REQUEST_EXPORT' &&
      request.command !== 'WORKER_EXPORT_GATE' &&
      request.command !== 'DOWNLOAD_EXPORT'
    ) {
      return this.reject('INVALID_COMMAND');
    }
    const shapeFailure = this.requestShapeFailure(request);
    if (shapeFailure !== null) {
      return this.reject(shapeFailure);
    }

    if (
      request.sourceItems !== undefined &&
      request.command !== 'WORKER_EXPORT_GATE'
    ) {
      return this.reject('SOURCE_ITEMS_NOT_ACCEPTED_ON_REQUEST');
    }
    const kind = request.kind as ExportKind;

    if (request.meetingKind === 'GENERAL') {
      return this.reject('GENERAL_EXPORT_REJECTED');
    }

    if (request.command === 'DOWNLOAD_EXPORT') {
      if (request.exporterAuthorized !== true) {
        return this.reject('DOWNLOAD_NOT_AUTHORIZED');
      }
      return Object.freeze(
        this.approve(request.command, kind, request.meetingKind),
      );
    }

    if (request.idempotencyKeyProvided !== true) {
      return this.reject('IDEMPOTENCY_KEY_REQUIRED');
    }
    if (request.exporterAuthorized !== true) {
      return this.reject('EXPORTER_NOT_AUTHORIZED');
    }

    if (request.command === 'WORKER_EXPORT_GATE' && kind === 'ANALYSIS') {
      const items = request.sourceItems;
      if (!Array.isArray(items) || items.length === 0) {
        return this.reject('SOURCE_ITEMS_REQUIRED');
      }
      const itemsFailure = this.sourceItemsFailure(items);
      if (itemsFailure !== null) {
        return this.reject(itemsFailure);
      }
      if (items.some((item) => item.status === 'REJECTED')) {
        return this.reject('REJECTED_ITEM_NOT_EXPORTABLE');
      }
    }

    return Object.freeze(
      this.approve(request.command, kind, request.meetingKind),
    );
  }

  private approve(
    command: ExportCommand,
    kind: ExportKind,
    meetingKind: string,
  ): ExportRequestOutcome {
    return {
      ok: true,
      command,
      kind,
      meetingKind,
      surface:
        command === 'REQUEST_EXPORT'
          ? 'API'
          : command === 'WORKER_EXPORT_GATE'
            ? 'WORKER'
            : 'DOWNLOAD',
      jobCreationIsServerDuty: true,
      auditExportDecision: true,
    };
  }

  private requestShapeFailure(
    request: ExportRequestRequest,
  ): ExportRequestFailure | null {
    if (
      typeof request.kind !== 'string' ||
      EXPORT_KINDS.indexOf(request.kind as ExportKind) === -1
    ) {
      return 'INVALID_EXPORT_KIND';
    }
    if (
      typeof request.meetingKind !== 'string' ||
      MEETING_KINDS.indexOf(request.meetingKind) === -1
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      request.exporterAuthorized !== undefined &&
      request.exporterAuthorized !== true &&
      request.exporterAuthorized !== false
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      request.idempotencyKeyProvided !== undefined &&
      request.idempotencyKeyProvided !== true &&
      request.idempotencyKeyProvided !== false
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      request.sourceItems !== undefined &&
      !Array.isArray(request.sourceItems)
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    return null;
  }

  private sourceItemsFailure(
    items: ReadonlyArray<ExportSourceItem>,
  ): ExportRequestFailure | null {
    const seen = new Set<string>();
    for (const item of items) {
      if (
        item === null ||
        typeof item !== 'object' ||
        typeof item.id !== 'string' ||
        item.id.trim() === ''
      ) {
        return 'DECISION_FACTS_REQUIRED';
      }
      if (seen.has(item.id)) {
        return 'DECISION_FACTS_REQUIRED';
      }
      seen.add(item.id);
      if (ITEM_STATUSES.indexOf(item.status as ItemStatusForExport) === -1) {
        return 'UNKNOWN_ITEM_STATUS';
      }
    }
    return null;
  }

  private reject(reason: ExportRequestFailure): ExportRequestDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}
