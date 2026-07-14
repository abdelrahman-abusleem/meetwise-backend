import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { ConfigModule } from '@meetwise/infrastructure/config';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
