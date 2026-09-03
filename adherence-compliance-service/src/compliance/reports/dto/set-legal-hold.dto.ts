import { IsBoolean } from 'class-validator';

/** docs/adr/0106's `PATCH /v1/compliance/reports/{id}/legal-hold` body. */
export class SetLegalHoldDto {
  @IsBoolean()
  legalHold!: boolean;
}
