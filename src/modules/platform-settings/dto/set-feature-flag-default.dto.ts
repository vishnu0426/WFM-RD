import { IsBoolean } from 'class-validator';

export class SetFeatureFlagDefaultDto {
  @IsBoolean()
  enabled!: boolean;
}
