import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { AuthOriginGuard } from '../auth/guards/auth-origin.guard';
import { CreateMeetingDto } from './create-meeting.dto';
import { MeetingCreateService } from './meeting-create.service';
import { MeetingReadService } from './meeting-read.service';
import { CancellationRequestDto } from './cancellation-request.dto';
import { CancellationRequestService } from './cancellation-request.service';

@Controller('meetings')
@UseGuards(AccessTokenGuard, AuthOriginGuard)
export class MeetingsController {
  constructor(
    private readonly meetings: MeetingCreateService,
    private readonly reads: MeetingReadService,
    private readonly cancellations: CancellationRequestService,
  ) {}
  @Post(':meetingId/cancellation-requests')
  @Header('Cache-Control', 'no-store')
  requestCancellation(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('meetingId', new ParseUUIDPipe()) id: string,
    @Body() input: CancellationRequestDto,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.cancellations.submit(actor, id, input, key);
  }
  @Get(':meetingId')
  @Header('Cache-Control', 'no-store')
  metadata(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('meetingId', new ParseUUIDPipe()) id: string,
  ) {
    return this.reads.metadata(actor, id);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateMeetingDto,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.meetings.create(actor, input, key);
  }
}
