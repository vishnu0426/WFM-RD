import { IsArray, IsIn } from 'class-validator';
import { SelfIdentificationProperty } from '../entities/self-identification-property.enum';

/** `PUT /v1/tenant-settings/self-identification` — full replace, not a partial update (an ordered list has no meaningful "partial" merge). */
export class UpdateSelfIdentificationSettingsDto {
  @IsArray()
  @IsIn(Object.values(SelfIdentificationProperty), { each: true })
  properties!: string[];
}
