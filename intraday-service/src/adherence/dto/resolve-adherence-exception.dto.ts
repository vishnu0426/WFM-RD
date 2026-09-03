import { IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /v1/intraday/adherence-exceptions/:id/resolve` body - `resolutionNotes` is required at the DTO level, matching the migration's own CHECK constraint (`status <> 'resolved' OR resolution_notes IS NOT NULL`). */
export class ResolveAdherenceExceptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  resolutionNotes!: string;
}
