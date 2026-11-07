type DepartmentKind = 'TECH' | 'SALES';
type MeetingKind = DepartmentKind | 'GENERAL';
type MeetingVisibility = 'COMPANY' | 'DEPARTMENT' | 'PRIVATE';

export interface DepartmentIdentity {
  readonly id: string;
  readonly kind: DepartmentKind;
}

export interface MeetingScope {
  readonly kind: MeetingKind;
  readonly departmentId: string | null;
  readonly visibility: MeetingVisibility;
}

type ScopeFailure =
  | 'INVALID_REQUEST'
  | 'INVALID_MEETING_KIND'
  | 'DEPARTMENT_FORBIDDEN'
  | 'DEPARTMENT_REQUIRED'
  | 'DEPARTMENT_MISMATCH'
  | 'INVALID_VISIBILITY';

export type MeetingScopeDecision =
  | Readonly<{ ok: true; scope: Readonly<MeetingScope> }>
  | Readonly<{ ok: false; reason: ScopeFailure }>;

export class MeetingScopePolicy {
  normalize(
    request: unknown,
    currentDepartment: DepartmentIdentity | null = null,
  ): MeetingScopeDecision {
    if (
      typeof request !== 'object' ||
      request === null ||
      Array.isArray(request)
    ) {
      return this.reject('INVALID_REQUEST');
    }

    const input = request as Record<string, unknown>;
    const kind = input.kind;
    if (kind !== 'GENERAL' && kind !== 'TECH' && kind !== 'SALES') {
      return this.reject('INVALID_MEETING_KIND');
    }

    let departmentId: string | null = null;
    if (kind === 'GENERAL') {
      if (input.departmentId !== undefined || currentDepartment !== null) {
        return this.reject('DEPARTMENT_FORBIDDEN');
      }
    } else {
      if (
        typeof input.departmentId !== 'string' ||
        input.departmentId.trim() === ''
      ) {
        return this.reject('DEPARTMENT_REQUIRED');
      }
      if (
        currentDepartment === null ||
        currentDepartment.kind !== kind ||
        currentDepartment.id !== input.departmentId
      ) {
        return this.reject('DEPARTMENT_MISMATCH');
      }
      departmentId = currentDepartment.id;
    }

    const defaultVisibility = kind === 'GENERAL' ? 'COMPANY' : 'DEPARTMENT';
    const requestedVisibility =
      input.visibility === undefined ? defaultVisibility : input.visibility;
    if (
      requestedVisibility !== defaultVisibility &&
      requestedVisibility !== 'PRIVATE'
    ) {
      return this.reject('INVALID_VISIBILITY');
    }

    const scope: MeetingScope = {
      kind,
      departmentId,
      visibility:
        requestedVisibility === 'PRIVATE' ? 'PRIVATE' : defaultVisibility,
    };
    return Object.freeze({ ok: true, scope: Object.freeze(scope) });
  }

  private reject(reason: ScopeFailure): MeetingScopeDecision {
    return Object.freeze({ ok: false, reason });
  }
}
