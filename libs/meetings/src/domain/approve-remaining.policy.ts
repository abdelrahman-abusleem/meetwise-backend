type ItemApprovalStatus = 'PENDING' | 'NEEDS_EDITS' | 'REJECTED' | 'APPROVED';

type ExclusionReason = 'ALREADY_APPROVED' | 'NOT_READY' | 'DUPLICATE_PENDING';

const GENERAL_KIND = 'GENERAL';

const MEETING_KINDS: Readonly<string[]> = ['TECH', 'SALES', 'GENERAL'];

export interface BulkItemState {
  readonly id: string;
  readonly status: string;
  readonly itemVersion: number;
  readonly duplicatePending?: boolean;
}

export interface PreviewRecord {
  readonly id: string;
  readonly itemVersion: number;
}

export interface ApproveRemainingRequest {
  readonly command: string;

  readonly meetingKind?: string;

  readonly approverAuthorizedAtWriteTime?: boolean;

  readonly items?: BulkItemState[];

  readonly previewReadyItems?: PreviewRecord[];

  readonly previewItems?: BulkItemState[];

  readonly previewFingerprint?: string;

  readonly confirmFingerprint?: string;

  readonly previewMeetingVersion?: number;
  readonly acceptedIds?: string[];
  readonly confirmPartial?: boolean;

  readonly idempotencyKeyProvided?: boolean;

  readonly expectedMeetingVersion?: number;
  readonly currentMeetingVersion?: number;

  readonly generateExecution?: boolean;
}

export interface ExcludedItem {
  readonly id: string;
  readonly reason: ExclusionReason;
}

export interface BulkPreviewOutcome {
  readonly ok: true;
  readonly command: 'PREVIEW_REMAINING';
  readonly meetingKind: string;

  readonly meetingVersion: number;
  readonly readyItemIds: readonly string[];
  readonly notReadyItemIds: readonly string[];
  readonly alreadyApprovedItemIds: readonly string[];
  readonly duplicatePendingItemIds: readonly string[];

  readonly fingerprint: string;
}

export interface BulkConfirmOutcome {
  readonly ok: true;
  readonly command: 'CONFIRM_REMAINING';
  readonly approvedItemIds: readonly string[];
  readonly alreadyApprovedItemIds: readonly string[];
  readonly excluded: readonly ExcludedItem[];

  readonly executionRowsNotCreatedHere: true;
}

export type ApproveRemainingFailure =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_ITEM_STATUS'
  | 'DECISION_FACTS_REQUIRED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'APPROVER_NOT_AUTHORIZED'
  | 'PREVIEW_STALE'
  | 'MEETING_VERSION_MISMATCH'
  | 'UNPREVIEWED_ACCEPTANCE'
  | 'STALE_ITEM_VERSION'
  | 'CONFIRM_PARTIAL_REQUIRED'
  | 'GENERAL_EXTERNAL_EXECUTION_REJECTED';

export type ApproveRemainingFailureDecision = Readonly<{
  ok: false;
  reason: ApproveRemainingFailure;
}>;

export type ApproveRemainingDecision =
  BulkPreviewOutcome | BulkConfirmOutcome | ApproveRemainingFailureDecision;

export function fingerprint64(input: string): string {
  const bytes: number[] = [];
  for (const char of input) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export class ApproveRemainingPolicy {
  preview(
    request: ApproveRemainingRequest,
  ): BulkPreviewOutcome | ApproveRemainingFailureDecision {
    if (request === null || typeof request !== 'object') {
      return this.reject('INVALID_COMMAND');
    }
    if (request.command !== 'PREVIEW_REMAINING') {
      return this.reject('INVALID_COMMAND');
    }
    if (request.acceptedIds !== undefined) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (
      typeof request.meetingKind !== 'string' ||
      MEETING_KINDS.indexOf(request.meetingKind) === -1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (request.approverAuthorizedAtWriteTime !== true) {
      return this.reject('APPROVER_NOT_AUTHORIZED');
    }
    if (!this.isSafeVersion(request.currentMeetingVersion)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const items = request.items;
    if (!Array.isArray(items)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const itemsFailure = this.itemsShapeFailure(items);
    if (itemsFailure !== null) {
      return this.reject(itemsFailure);
    }
    const readyItemIds: string[] = [];
    const notReadyItemIds: string[] = [];
    const alreadyApprovedItemIds: string[] = [];
    const duplicatePendingItemIds: string[] = [];
    for (const item of items) {
      if (item.duplicatePending === true) {
        duplicatePendingItemIds.push(item.id);
        continue;
      }
      if (item.status === 'PENDING') {
        readyItemIds.push(item.id);
      } else if (item.status === 'APPROVED') {
        alreadyApprovedItemIds.push(item.id);
      } else {
        notReadyItemIds.push(item.id);
      }
    }
    readyItemIds.sort();
    return Object.freeze({
      ok: true as const,
      command: 'PREVIEW_REMAINING' as const,
      meetingKind: request.meetingKind,
      meetingVersion: request.currentMeetingVersion,
      readyItemIds: Object.freeze([...readyItemIds]),
      notReadyItemIds: Object.freeze([...notReadyItemIds]),
      alreadyApprovedItemIds: Object.freeze([...alreadyApprovedItemIds]),
      duplicatePendingItemIds: Object.freeze([...duplicatePendingItemIds]),
      fingerprint: fingerprint64(this.snapshotCanonical(items)),
    });
  }

  confirm(
    request: ApproveRemainingRequest,
  ): BulkConfirmOutcome | ApproveRemainingFailureDecision {
    if (request === null || typeof request !== 'object') {
      return this.reject('INVALID_COMMAND');
    }
    if (request.command !== 'CONFIRM_REMAINING') {
      return this.reject('INVALID_COMMAND');
    }
    if (
      typeof request.meetingKind !== 'string' ||
      MEETING_KINDS.indexOf(request.meetingKind) === -1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }

    if (
      request.meetingKind === GENERAL_KIND &&
      request.generateExecution === true
    ) {
      return this.reject('GENERAL_EXTERNAL_EXECUTION_REJECTED');
    }
    if (request.idempotencyKeyProvided !== true) {
      return this.reject('IDEMPOTENCY_KEY_REQUIRED');
    }
    if (request.approverAuthorizedAtWriteTime !== true) {
      return this.reject('APPROVER_NOT_AUTHORIZED');
    }
    if (
      !this.isSafeVersion(request.expectedMeetingVersion) ||
      !this.isSafeVersion(request.currentMeetingVersion) ||
      !this.isSafeVersion(request.previewMeetingVersion)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const readyItems = request.previewReadyItems;
    if (!Array.isArray(readyItems)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const readyFailure = this.previewRecordsShapeFailure(readyItems);
    if (readyFailure !== null) {
      return this.reject(readyFailure);
    }
    const previewItems = request.previewItems;
    if (!Array.isArray(previewItems))
      return this.reject('DECISION_FACTS_REQUIRED');
    const previewFailure = this.itemsShapeFailure(previewItems);
    if (previewFailure !== null) return this.reject(previewFailure);
    const preview = this.preview({
      command: 'PREVIEW_REMAINING',
      meetingKind: request.meetingKind,
      approverAuthorizedAtWriteTime: true,
      currentMeetingVersion: request.previewMeetingVersion,
      items: previewItems,
    });
    if (!preview.ok) return preview;
    if (
      this.canonical(
        readyItems.map((r) => r.id),
        new Map(readyItems.map((r) => [r.id, r.itemVersion])),
      ) !== this.canonical(preview.readyItemIds, toVersionMap(previewItems))
    )
      return this.reject('PREVIEW_STALE');
    const items = request.items;
    if (!Array.isArray(items)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const itemsFailure = this.itemsShapeFailure(items);
    if (itemsFailure !== null) {
      return this.reject(itemsFailure);
    }
    if (
      !isNonEmptyString(request.previewFingerprint) ||
      !isNonEmptyString(request.confirmFingerprint)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (
      request.confirmPartial !== undefined &&
      typeof request.confirmPartial !== 'boolean'
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }

    if (
      request.generateExecution !== undefined &&
      request.generateExecution !== true &&
      request.generateExecution !== false
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const acceptedIds = request.acceptedIds;
    if (
      !Array.isArray(acceptedIds) ||
      acceptedIds.some((id) => !isNonEmptyString(id))
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const acceptedSeen = new Set<string>();
    for (const id of acceptedIds) {
      if (acceptedSeen.has(id)) {
        return this.reject('DECISION_FACTS_REQUIRED');
      }
      acceptedSeen.add(id);
    }

    const itemVersionById = new Map<string, number>();
    for (const record of readyItems) {
      itemVersionById.set(record.id, record.itemVersion);
    }
    const computed = fingerprint64(this.snapshotCanonical(previewItems));
    if (
      computed !== request.previewFingerprint ||
      request.confirmFingerprint !== computed
    ) {
      return this.reject('PREVIEW_STALE');
    }
    if (
      request.expectedMeetingVersion !== request.currentMeetingVersion ||
      request.expectedMeetingVersion !== request.previewMeetingVersion
    ) {
      return this.reject('MEETING_VERSION_MISMATCH');
    }

    const freshStateById = new Map<string, BulkItemState>();
    for (const item of items) {
      freshStateById.set(item.id, item);
    }

    const approvedItemIds: string[] = [];
    const alreadyApprovedItemIds: string[] = [
      ...preview.alreadyApprovedItemIds,
    ];
    const excluded: ExcludedItem[] = [
      ...preview.notReadyItemIds.map((id) => ({
        id,
        reason: 'NOT_READY' as const,
      })),
      ...preview.duplicatePendingItemIds.map((id) => ({
        id,
        reason: 'DUPLICATE_PENDING' as const,
      })),
    ];
    let hasExcludedOutcome =
      excluded.length > 0 || alreadyApprovedItemIds.length > 0;

    for (const id of acceptedIds) {
      const previewVersion = itemVersionById.get(id);
      if (previewVersion === undefined) {
        return this.reject('UNPREVIEWED_ACCEPTANCE');
      }
      const fresh = freshStateById.get(id);
      if (fresh === undefined) {
        return this.reject('DECISION_FACTS_REQUIRED');
      }

      if (fresh.duplicatePending === true) {
        excluded.push({ id, reason: 'DUPLICATE_PENDING' });
        hasExcludedOutcome = true;
        continue;
      }
      if (fresh.status === 'APPROVED') {
        alreadyApprovedItemIds.push(id);
        hasExcludedOutcome = true;
        continue;
      }
      if (fresh.status === 'NEEDS_EDITS' || fresh.status === 'REJECTED') {
        excluded.push({ id, reason: 'NOT_READY' });
        hasExcludedOutcome = true;
        continue;
      }

      if (fresh.itemVersion !== previewVersion) {
        return this.reject('STALE_ITEM_VERSION');
      }
      approvedItemIds.push(id);
    }

    if (
      (hasExcludedOutcome || readyItems.length > approvedItemIds.length) &&
      request.confirmPartial !== true
    ) {
      return this.reject('CONFIRM_PARTIAL_REQUIRED');
    }

    return Object.freeze({
      ok: true as const,
      command: 'CONFIRM_REMAINING' as const,
      approvedItemIds: Object.freeze([...approvedItemIds]),
      alreadyApprovedItemIds: Object.freeze([...alreadyApprovedItemIds]),
      excluded: Object.freeze(
        excluded.map((item) => Object.freeze({ ...item })),
      ),
      executionRowsNotCreatedHere: true as const,
    });
  }

  private snapshotCanonical(items: readonly BulkItemState[]): string {
    return [...items]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((item) =>
        JSON.stringify([
          item.id,
          item.itemVersion,
          item.status,
          item.duplicatePending === true,
        ]),
      )
      .join('\n');
  }

  private canonical(
    ids: readonly string[],
    versionById: Map<string, number>,
  ): string {
    const sorted = [...ids].sort();

    return sorted
      .map((id) => `${id.length}:${id}:${versionById.get(id) ?? ''}`)
      .join('\n');
  }

  private isSafeVersion(value: unknown): value is number {
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    );
  }

  private itemsShapeFailure(
    items: ReadonlyArray<BulkItemState>,
  ): ApproveRemainingFailure | null {
    const seen = new Set<string>();
    for (const item of items) {
      if (
        item === null ||
        typeof item !== 'object' ||
        !isNonEmptyString(item.id)
      ) {
        return 'DECISION_FACTS_REQUIRED';
      }
      if (seen.has(item.id)) {
        return 'DECISION_FACTS_REQUIRED';
      }
      seen.add(item.id);
      if (
        (ITEM_STATUSES as ReadonlyArray<string>).indexOf(item.status) === -1
      ) {
        return 'UNKNOWN_ITEM_STATUS';
      }
      if (!isSafeNonNegativeInteger(item.itemVersion)) {
        return 'DECISION_FACTS_REQUIRED';
      }
      if (
        item.duplicatePending !== undefined &&
        typeof item.duplicatePending !== 'boolean'
      ) {
        return 'DECISION_FACTS_REQUIRED';
      }
    }
    return null;
  }

  private previewRecordsShapeFailure(
    records: ReadonlyArray<PreviewRecord>,
  ): ApproveRemainingFailure | null {
    const seen = new Set<string>();
    for (const record of records) {
      if (
        record === null ||
        typeof record !== 'object' ||
        !isNonEmptyString(record.id)
      ) {
        return 'DECISION_FACTS_REQUIRED';
      }
      if (seen.has(record.id)) {
        return 'DECISION_FACTS_REQUIRED';
      }
      seen.add(record.id);
      if (!isSafeNonNegativeInteger(record.itemVersion)) {
        return 'DECISION_FACTS_REQUIRED';
      }
    }
    return null;
  }

  private reject(
    reason: ApproveRemainingFailure,
  ): ApproveRemainingFailureDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}

const ITEM_STATUSES: Readonly<ItemApprovalStatus[]> = [
  'PENDING',
  'NEEDS_EDITS',
  'REJECTED',
  'APPROVED',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function toVersionMap(
  items: ReadonlyArray<BulkItemState>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item.id, item.itemVersion);
  }
  return map;
}
