import { SetupBootstrapGuard } from './setup-bootstrap.guard';
import { Headers, UseGuards } from '@nestjs/common';
import { AuthOriginGuard } from '../auth/guards/auth-origin.guard';
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { CompleteSetupDto } from './dto/complete-setup.dto';
import { SetupService } from './setup.service';

@Controller('setup')
@UseGuards(SetupBootstrapGuard, AuthOriginGuard)
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Post('complete')
  @HttpCode(HttpStatus.CREATED)
  completeSetup(
    @Body() dto: CompleteSetupDto,
    @Headers('x-meetwise-setup-token') token: unknown,
  ) {
    return this.setupService.completeSetup(dto, token);
  }
}
