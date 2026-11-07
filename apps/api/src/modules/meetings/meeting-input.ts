import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDateString, isRFC3339 } from 'class-validator';
import type { CreateMeetingDto } from './create-meeting.dto';

export function validateDraftMetadata(input: CreateMeetingDto) {
  const title = input.title.trim();
  if (!title || title.length > 240 || input.seriesId !== undefined)
    throw new UnprocessableEntityException(
      'Invalid or unsupported meeting draft',
    );
  if (input.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
    } catch {
      throw new UnprocessableEntityException('Invalid meeting time zone');
    }
  }
  if (
    input.scheduledAt !== undefined &&
    (!isRFC3339(input.scheduledAt) ||
      !isDateString(input.scheduledAt, { strict: true }))
  )
    throw new UnprocessableEntityException(
      'An explicit-offset meeting instant is required',
    );
  const scheduledAt =
    input.scheduledAt === undefined ? null : new Date(input.scheduledAt);
  if (scheduledAt !== null && !Number.isFinite(scheduledAt.getTime()))
    throw new UnprocessableEntityException('Invalid meeting time');
  if (input.joinUrl !== undefined) {
    try {
      const url = new URL(input.joinUrl);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'meet.google.com' ||
        url.port ||
        url.username ||
        url.password ||
        !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname)
      )
        throw new Error();
    } catch {
      throw new UnprocessableEntityException('Invalid supported meeting link');
    }
  }
  return {
    title,
    scheduledAt,
    timeZone: input.timeZone ?? null,
    joinUrl: input.joinUrl ?? null,
  };
}

export function meetingRequestIdentity(key: unknown, input: CreateMeetingDto) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key))
    throw new BadRequestException('A valid Idempotency-Key is required');
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const metadata = validateDraftMetadata(input);
  const payload = {
    kind: input.kind,
    departmentId: input.departmentId ?? null,
    visibility:
      input.visibility ?? (input.kind === 'GENERAL' ? 'COMPANY' : 'DEPARTMENT'),
    title: metadata.title,
    scheduledAt: metadata.scheduledAt?.toISOString() ?? null,
    timeZone: metadata.timeZone,
    joinUrl: metadata.joinUrl,
    meetingAdminId: input.meetingAdminId ?? null,
  };
  return { keyHash: digest(key), payloadHash: digest(JSON.stringify(payload)) };
}
