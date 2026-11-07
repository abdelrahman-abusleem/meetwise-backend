import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { AuthOriginGuard } from '../auth/guards/auth-origin.guard';
import { CancellationDecisionDto } from './cancellation-decision.dto';
import { CancellationDecisionService } from './cancellation-decision.service';
@Controller('cancellation-requests')
@UseGuards(AccessTokenGuard, AuthOriginGuard)
export class CancellationDecisionsController {
  constructor(private readonly decisions: CancellationDecisionService) {}
  @Post(':requestId/decide')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  decide(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('requestId', new ParseUUIDPipe()) id: string,
    @Body() input: CancellationDecisionDto,
    @Headers('idempotency-key') key: unknown,
    @Headers('if-match') ifMatch: unknown,
  ) {
    return this.decisions.decide(actor, id, input, key, ifMatch);
  }
}
