import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';

export class ScimPatchOperationDto {
  @IsIn(['add', 'remove', 'replace', 'Add', 'Remove', 'Replace'])
  op!: string;

  @IsOptional()
  @IsString()
  path?: string;

  // Deliberately untyped/unvalidated (`unknown` at runtime) - a PATCH
  // operation's `value` shape depends entirely on `path` (boolean for
  // `active`, string for `name.givenName`, an array of member refs for a
  // Group's `members`, ...). See `ScimUsersService.applyPatch`/
  // `ScimGroupsService.applyPatch` for the supported subset.
  value?: unknown;
}

/** RFC 7644 §3.5.2's PATCH request envelope. */
export class ScimPatchRequestDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScimPatchOperationDto)
  Operations!: ScimPatchOperationDto[];
}
