'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MeetingVisibilityPolicy,
} = require('../../src/domain/meeting-visibility.policy.ts');

const TECH_DEPT = '11111111-1111-4111-8111-111111111111';
const SALES_DEPT = '22222222-2222-4222-8222-222222222222';
const TECH_MEETING_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const GENERAL_MEETING_ID = 'aaaaaaaa-2222-4222-8222-222222222222';
const SALES_MEETING_ID = 'aaaaaaaa-3333-4333-8333-333333333333';

function actor(overrides) {
  return {
    systemRole: 'MEMBER',
    isActive: true,
    departmentMemberships: [],
    meetingAccess: [],
    ...overrides,
  };
}

function membership(departmentId, role, status = 'ACTIVE') {
  return { departmentId, role, status };
}

function access(meetingId, role, canReadTranscript = false) {
  return { meetingId, role, canReadTranscript };
}

function techDepartmentMeeting(visibility = 'DEPARTMENT') {
  return {
    id: TECH_MEETING_ID,
    kind: 'TECH',
    departmentId: TECH_DEPT,
    visibility,
  };
}

function generalMeeting(visibility = 'COMPANY') {
  return {
    id: GENERAL_MEETING_ID,
    kind: 'GENERAL',
    departmentId: null,
    visibility,
  };
}

function salesDepartmentMeeting(visibility = 'DEPARTMENT') {
  return {
    id: SALES_MEETING_ID,
    kind: 'SALES',
    departmentId: SALES_DEPT,
    visibility,
  };
}

const policy = new MeetingVisibilityPolicy();

test('rejects unknown read purposes', () => {
  const decision = policy.evaluate(
    actor({ systemRole: 'OWNER' }),
    techDepartmentMeeting(),
    'VIEW_APPROVED_EXPORT',
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'INVALID_PURPOSE');
});

test('rejects invalid meeting shapes before making any grant', () => {
  const cases = [
    [
      { kind: 'GENERAL', departmentId: TECH_DEPT, visibility: 'COMPANY' },
      'COMPANY_ON_DEPARTMENT',
    ],
    [
      { kind: 'TECH', departmentId: TECH_DEPT, visibility: 'COMPANY' },
      'COMPANY_ON_TECH',
    ],
    [{ kind: 'TECH', departmentId: null, visibility: 'DEPARTMENT' }, 'NO_DEPT'],
    [
      { kind: 'GENERAL', departmentId: null, visibility: 'DEPARTMENT' },
      'GENERAL_DEPARTMENT',
    ],
    [
      { kind: 'GENERAL', departmentId: TECH_DEPT, visibility: 'PRIVATE' },
      'GENERAL_WITH_DEPT',
    ],
    [
      { kind: 'TECH', departmentId: '', visibility: 'DEPARTMENT' },
      'EMPTY_DEPT',
    ],
    [
      { kind: 'MEETING', departmentId: null, visibility: 'PRIVATE' },
      'UNKNOWN_KIND',
    ],
    [
      { kind: 'GENERAL', departmentId: null, visibility: 'PUBLIC' },
      'UNKNOWN_VISIBILITY',
    ],
  ];
  for (const [meeting] of cases) {
    const decision = policy.evaluate(
      actor({ systemRole: 'OWNER' }),
      meeting,
      'VIEW_METADATA',
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'INVALID_MEETING_SHAPE');
  }
});

test('rejects malformed actor facts fail-closed', () => {
  const cases = [
    [actor({ systemRole: 'GLOBAL_ADMIN' }), 'UNKNOWN_SYSTEM_ROLE'],
    [actor({ isActive: 'true' }), 'NON_BOOLEAN_ACTIVE'],
    [
      {
        systemRole: 'MEMBER',
        isActive: true,
        departmentMemberships: null,
        meetingAccess: [],
      },
      'NULL_MEMBERSHIPS',
    ],
    [actor({ departmentMemberships: [membership('')] }), 'EMPTY_DEPT_ID'],
    [
      actor({ departmentMemberships: [membership(TECH_DEPT, 'MANAGER')] }),
      'INVALID_DEPT_ROLE',
    ],
    [
      actor({ departmentMemberships: [membership(TECH_DEPT, 'MEMBER', '')] }),
      'EMPTY_STATUS',
    ],
    [
      actor({
        departmentMemberships: [
          membership(TECH_DEPT, 'MEMBER'),
          membership(TECH_DEPT, 'ADMIN'),
        ],
      }),
      'DUPLICATE_DEPT',
    ],
    [
      actor({ meetingAccess: [access(TECH_MEETING_ID, 'ADMIN')] }),
      'INVALID_MEETING_ROLE',
    ],
    [
      actor({
        meetingAccess: [{ role: 'REVIEWER', canReadTranscript: 'yes' }],
      }),
      'NON_BOOLEAN_GRANT',
    ],
  ];
  for (const [input] of cases) {
    const decision = policy.evaluate(
      input,
      techDepartmentMeeting(),
      'VIEW_METADATA',
    );
    assert.equal(decision.allowed, false);
    assert.notEqual(decision.reason, undefined);
    assert.ok(
      [
        'UNKNOWN_ACTOR',
        'INVALID_DEPARTMENT_MEMBERSHIP',
        'INVALID_MEETING_ACCESS',
      ].includes(decision.reason),
      `unexpected reason ${decision.reason}`,
    );
  }
});

test('rejects inactive actors even for normally visible meetings', () => {
  const decision = policy.evaluate(
    actor({
      isActive: false,
      meetingAccess: [access(GENERAL_MEETING_ID, 'REVIEWER', true)],
    }),
    generalMeeting('COMPANY'),
    'VIEW_METADATA',
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'ACTOR_NOT_ACTIVE');
});

test('OWNER and system MANAGER read department-visibility metadata and summary', () => {
  for (const systemRole of ['OWNER', 'MANAGER']) {
    for (const purpose of ['VIEW_METADATA', 'VIEW_SUMMARY']) {
      const decision = policy.evaluate(
        actor({ systemRole }),
        techDepartmentMeeting(),
        purpose,
      );
      assert.equal(decision.allowed, true);
      assert.equal(decision.purpose, purpose);
      assert.ok(Object.isFrozen(decision));
    }
  }
});

test('current department members read department-visibility metadata and summary', () => {
  const currentMember = actor({
    departmentMemberships: [membership(TECH_DEPT, 'MEMBER')],
  });
  for (const purpose of ['VIEW_METADATA', 'VIEW_SUMMARY']) {
    const decision = policy.evaluate(
      currentMember,
      techDepartmentMeeting(),
      purpose,
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.purpose, purpose);
  }
  const currentAdmin = actor({
    departmentMemberships: [membership(TECH_DEPT, 'ADMIN')],
  });
  assert.equal(
    policy.evaluate(currentAdmin, techDepartmentMeeting(), 'VIEW_METADATA')
      .allowed,
    true,
  );
});

test('other departments and unassigned company members cannot read department meetings', () => {
  const salesMember = actor({
    departmentMemberships: [membership(SALES_DEPT, 'MEMBER')],
  });
  const denied = policy.evaluate(
    salesMember,
    techDepartmentMeeting(),
    'VIEW_METADATA',
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'DEPARTMENT_MEMBERSHIP_REQUIRED');

  const suspended = actor({
    departmentMemberships: [membership(TECH_DEPT, 'MEMBER', 'SUSPENDED')],
  });
  const suspendedDecision = policy.evaluate(
    suspended,
    techDepartmentMeeting(),
    'VIEW_METADATA',
  );
  assert.equal(suspendedDecision.allowed, false);
  assert.equal(suspendedDecision.reason, 'DEPARTMENT_MEMBERSHIP_REQUIRED');

  const noMembership = actor({});
  const noMembershipDecision = policy.evaluate(
    noMembership,
    techDepartmentMeeting(),
    'VIEW_SUMMARY',
  );
  assert.equal(noMembershipDecision.allowed, false);
  assert.equal(noMembershipDecision.reason, 'DEPARTMENT_MEMBERSHIP_REQUIRED');
});

test('dual memberships evaluate independently per department', () => {
  const dual = actor({
    departmentMemberships: [
      membership(TECH_DEPT, 'MEMBER'),
      membership(SALES_DEPT, 'ADMIN'),
    ],
  });
  assert.equal(
    policy.evaluate(dual, techDepartmentMeeting(), 'VIEW_METADATA').allowed,
    true,
  );
  const salesMeeting = salesDepartmentMeeting();
  assert.equal(
    policy.evaluate(dual, salesMeeting, 'VIEW_METADATA').allowed,
    true,
  );
  const salesOnly = actor({
    departmentMemberships: [membership(SALES_DEPT, 'MEMBER')],
  });
  const otherMeeting = {
    id: TECH_MEETING_ID,
    kind: 'TECH',
    departmentId: '33333333-3333-4333-8333-333333333333',
    visibility: 'DEPARTMENT',
  };
  assert.equal(
    policy.evaluate(salesOnly, otherMeeting, 'VIEW_METADATA').allowed,
    false,
  );
});

test('explicit cross-department meeting grant authorizes department reads', () => {
  const assignedReviewer = actor({
    departmentMemberships: [membership(SALES_DEPT, 'MEMBER')],
    meetingAccess: [access(TECH_MEETING_ID, 'REVIEWER')],
  });
  for (const purpose of ['VIEW_METADATA', 'VIEW_SUMMARY']) {
    const decision = policy.evaluate(
      assignedReviewer,
      techDepartmentMeeting(),
      purpose,
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.purpose, purpose);
  }
  const invitedViewer = actor({
    meetingAccess: [access(TECH_MEETING_ID, 'VIEWER')],
  });
  assert.equal(
    policy.evaluate(invitedViewer, techDepartmentMeeting(), 'VIEW_SUMMARY')
      .allowed,
    true,
  );
});

test('COMPANY visibility of a GENERAL meeting is readable by every active company role', () => {
  for (const systemRole of ['OWNER', 'MANAGER', 'MEMBER']) {
    for (const purpose of ['VIEW_METADATA', 'VIEW_SUMMARY']) {
      const companyUser = actor({
        systemRole,
        departmentMemberships: [membership(SALES_DEPT, 'ADMIN')],
      });
      const decision = policy.evaluate(
        companyUser,
        generalMeeting('COMPANY'),
        purpose,
      );
      assert.equal(decision.allowed, true);
      assert.equal(decision.purpose, purpose);
    }
  }
});

test('raw transcript always requires an explicit transcript grant regardless of visibility', () => {
  const grantedCompanyMember = actor({
    meetingAccess: [access(GENERAL_MEETING_ID, 'VIEWER', true)],
  });
  const approved = policy.evaluate(
    grantedCompanyMember,
    generalMeeting('COMPANY'),
    'VIEW_RAW_TRANSCRIPT',
  );
  assert.equal(approved.allowed, true);
  assert.equal(approved.purpose, 'VIEW_RAW_TRANSCRIPT');

  for (const systemRole of ['OWNER', 'MANAGER', 'MEMBER']) {
    const ungranted = actor({
      systemRole,
      departmentMemberships: [membership(TECH_DEPT, 'MEMBER')],
    });
    const denied = policy.evaluate(
      ungranted,
      techDepartmentMeeting(),
      'VIEW_RAW_TRANSCRIPT',
    );
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'EXPLICIT_TRANSCRIPT_GRANT_REQUIRED');
  }
});

test('meeting administrators and reviewers with the grant read raw transcripts', () => {
  for (const [role, visibility] of [
    ['MEETING_ADMIN', 'PRIVATE'],
    ['REVIEWER', 'DEPARTMENT'],
    ['APPROVER', 'PRIVATE'],
  ]) {
    const meeting =
      visibility === 'PRIVATE'
        ? salesDepartmentMeeting('PRIVATE')
        : techDepartmentMeeting();
    const authorized = actor({
      meetingAccess: [access(meeting.id, role, true)],
    });
    const decision = policy.evaluate(
      authorized,
      meeting,
      'VIEW_RAW_TRANSCRIPT',
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.purpose, 'VIEW_RAW_TRANSCRIPT');
  }
});

test('raw transcript denial survives explicit meeting roles without the grant', () => {
  const viewerWithoutGrant = actor({
    meetingAccess: [access(TECH_MEETING_ID, 'VIEWER', false)],
  });
  const denied = policy.evaluate(
    viewerWithoutGrant,
    techDepartmentMeeting(),
    'VIEW_RAW_TRANSCRIPT',
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'EXPLICIT_TRANSCRIPT_GRANT_REQUIRED');
});

test('system roles and department admins read PRIVATE meeting metadata only', () => {
  const privateTechMeeting = {
    id: TECH_MEETING_ID,
    kind: 'TECH',
    departmentId: TECH_DEPT,
    visibility: 'PRIVATE',
  };

  for (const systemRole of ['OWNER', 'MANAGER']) {
    const decision = policy.evaluate(
      actor({ systemRole }),
      privateTechMeeting,
      'VIEW_METADATA',
    );
    assert.equal(decision.allowed, true);
  }

  const departmentAdmin = actor({
    systemRole: 'MEMBER',
    departmentMemberships: [membership(TECH_DEPT, 'ADMIN')],
  });
  assert.equal(
    policy.evaluate(departmentAdmin, privateTechMeeting, 'VIEW_METADATA')
      .allowed,
    true,
  );

  const plainMember = actor({
    systemRole: 'MEMBER',
    departmentMemberships: [membership(TECH_DEPT, 'MEMBER')],
  });
  const deniedMember = policy.evaluate(
    plainMember,
    privateTechMeeting,
    'VIEW_METADATA',
  );
  assert.equal(deniedMember.allowed, false);
  assert.equal(deniedMember.reason, 'PRIVATE_ACCESS_REQUIRED');

  const adminOfOtherDepartment = actor({
    systemRole: 'MEMBER',
    departmentMemberships: [membership(SALES_DEPT, 'ADMIN')],
  });
  const deniedOtherAdmin = policy.evaluate(
    adminOfOtherDepartment,
    privateTechMeeting,
    'VIEW_METADATA',
  );
  assert.equal(deniedOtherAdmin.allowed, false);
  assert.equal(deniedOtherAdmin.reason, 'PRIVATE_ACCESS_REQUIRED');
});

test('assigned meeting roles read PRIVATE metadata through explicit access', () => {
  const privateTechMeeting = {
    id: TECH_MEETING_ID,
    kind: 'TECH',
    departmentId: TECH_DEPT,
    visibility: 'PRIVATE',
  };
  for (const role of ['MEETING_ADMIN', 'REVIEWER', 'APPROVER', 'VIEWER']) {
    const assigned = actor({
      meetingAccess: [access(TECH_MEETING_ID, role)],
    });
    const decision = policy.evaluate(
      assigned,
      privateTechMeeting,
      'VIEW_METADATA',
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.purpose, 'VIEW_METADATA');
  }
});

test('PRIVATE approved-summary reads fail closed without an explicit per-meeting grant', () => {
  const privateTechMeeting = {
    id: TECH_MEETING_ID,
    kind: 'TECH',
    departmentId: TECH_DEPT,
    visibility: 'PRIVATE',
  };
  const cases = [
    actor({ systemRole: 'OWNER' }),
    actor({ systemRole: 'MANAGER' }),
    actor({
      systemRole: 'MEMBER',
      departmentMemberships: [membership(TECH_DEPT, 'ADMIN')],
    }),
    actor({
      systemRole: 'MEMBER',
      departmentMemberships: [membership(TECH_DEPT, 'MEMBER')],
    }),
    actor({ systemRole: 'MEMBER' }),
  ];
  for (const input of cases) {
    const decision = policy.evaluate(input, privateTechMeeting, 'VIEW_SUMMARY');
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'EXPLICIT_MEETING_GRANT_REQUIRED');
  }
  const plain = actor({
    systemRole: 'MEMBER',
    departmentMemberships: [membership(TECH_DEPT, 'MEMBER')],
  });
  const metadataDenied = policy.evaluate(
    plain,
    privateTechMeeting,
    'VIEW_METADATA',
  );
  assert.equal(metadataDenied.allowed, false);
  assert.equal(metadataDenied.reason, 'PRIVATE_ACCESS_REQUIRED');
});

test('explicit per-meeting roles unlock PRIVATE approved-summary reads', () => {
  const privateTechMeeting = {
    id: TECH_MEETING_ID,
    kind: 'TECH',
    departmentId: TECH_DEPT,
    visibility: 'PRIVATE',
  };
  for (const role of ['MEETING_ADMIN', 'REVIEWER', 'APPROVER', 'VIEWER']) {
    const granted = actor({
      meetingAccess: [access(TECH_MEETING_ID, role, role === 'REVIEWER')],
    });
    const decision = policy.evaluate(
      granted,
      privateTechMeeting,
      'VIEW_SUMMARY',
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.purpose, 'VIEW_SUMMARY');
  }
});

test('GENERAL PRIVATE meetings stay restricted without explicit access', () => {
  const privateGeneral = {
    id: GENERAL_MEETING_ID,
    kind: 'GENERAL',
    departmentId: null,
    visibility: 'PRIVATE',
  };
  const companyMember = actor({ systemRole: 'MEMBER' });
  const metadata = policy.evaluate(
    companyMember,
    privateGeneral,
    'VIEW_METADATA',
  );
  assert.equal(metadata.allowed, false);
  assert.equal(metadata.reason, 'PRIVATE_ACCESS_REQUIRED');

  const invited = actor({
    meetingAccess: [access(GENERAL_MEETING_ID, 'VIEWER')],
  });
  assert.equal(
    policy.evaluate(invited, privateGeneral, 'VIEW_METADATA').allowed,
    true,
  );
  assert.equal(
    policy.evaluate(invited, privateGeneral, 'VIEW_SUMMARY').allowed,
    true,
  );
  assert.equal(
    policy.evaluate(invited, privateGeneral, 'VIEW_RAW_TRANSCRIPT').allowed,
    false,
  );
  assert.equal(
    policy.evaluate(invited, privateGeneral, 'VIEW_RAW_TRANSCRIPT').reason,
    'EXPLICIT_TRANSCRIPT_GRANT_REQUIRED',
  );
});

test('company users without access cannot read GENERAL PRIVATE summary', () => {
  const privateGeneral = {
    id: GENERAL_MEETING_ID,
    kind: 'GENERAL',
    departmentId: null,
    visibility: 'PRIVATE',
  };
  const decision = policy.evaluate(
    actor({ systemRole: 'MEMBER' }),
    privateGeneral,
    'VIEW_SUMMARY',
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'EXPLICIT_MEETING_GRANT_REQUIRED');
});

test('GENERAL PRIVATE raw transcripts follow the explicit transcript grant only', () => {
  const privateGeneral = {
    id: GENERAL_MEETING_ID,
    kind: 'GENERAL',
    departmentId: null,
    visibility: 'PRIVATE',
  };
  const withGrant = actor({
    meetingAccess: [access(GENERAL_MEETING_ID, 'MEETING_ADMIN', true)],
  });
  const grantedRead = policy.evaluate(
    withGrant,
    privateGeneral,
    'VIEW_RAW_TRANSCRIPT',
  );
  assert.equal(grantedRead.allowed, true);
  assert.equal(grantedRead.purpose, 'VIEW_RAW_TRANSCRIPT');

  const systemManager = actor({ systemRole: 'MANAGER' });
  const adminDenied = policy.evaluate(
    systemManager,
    privateGeneral,
    'VIEW_RAW_TRANSCRIPT',
  );
  assert.equal(adminDenied.allowed, false);
  assert.equal(adminDenied.reason, 'EXPLICIT_TRANSCRIPT_GRANT_REQUIRED');
});

test('department admins never read private raw transcripts by administrative status', () => {
  const privateTechMeeting = {
    id: TECH_MEETING_ID,
    kind: 'TECH',
    departmentId: TECH_DEPT,
    visibility: 'PRIVATE',
  };
  const adminWithoutGrant = actor({
    systemRole: 'MEMBER',
    departmentMemberships: [membership(TECH_DEPT, 'ADMIN')],
  });
  const denied = policy.evaluate(
    adminWithoutGrant,
    privateTechMeeting,
    'VIEW_RAW_TRANSCRIPT',
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'EXPLICIT_TRANSCRIPT_GRANT_REQUIRED');
});

test('meeting access rows scoped to another meeting cannot authorize this one', () => {
  const decision = policy.evaluate(
    actor({
      meetingAccess: [access(SALES_MEETING_ID, 'REVIEWER', true)],
    }),
    techDepartmentMeeting(),
    'VIEW_RAW_TRANSCRIPT',
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'INVALID_MEETING_ACCESS');
});

test('company users without any membership or grant are denied department metadata', () => {
  const denied = policy.evaluate(
    actor({ systemRole: 'MEMBER' }),
    techDepartmentMeeting(),
    'VIEW_METADATA',
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'DEPARTMENT_MEMBERSHIP_REQUIRED');
});

test('whitespace department identifiers fail the meeting shape guard', () => {
  const decision = policy.evaluate(
    actor({ systemRole: 'OWNER' }),
    {
      id: TECH_MEETING_ID,
      kind: 'TECH',
      departmentId: '   ',
      visibility: 'DEPARTMENT',
    },
    'VIEW_METADATA',
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'INVALID_MEETING_SHAPE');
});

test('inactive actors are denied before visibility branches', () => {
  for (const meeting of [
    techDepartmentMeeting(),
    techDepartmentMeeting('PRIVATE'),
  ]) {
    const decision = policy.evaluate(
      actor({ isActive: false }),
      meeting,
      'VIEW_METADATA',
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'ACTOR_NOT_ACTIVE');
  }
});

test('non-canonical membership status values never count as current membership', () => {
  const typoStatus = actor({
    departmentMemberships: [membership(TECH_DEPT, 'MEMBER', 'active')],
  });
  const denied = policy.evaluate(
    typoStatus,
    techDepartmentMeeting(),
    'VIEW_METADATA',
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'DEPARTMENT_MEMBERSHIP_REQUIRED');
});
