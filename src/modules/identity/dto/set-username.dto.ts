import { IsString, MaxLength, MinLength } from 'class-validator';

export class SetUsernameDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username!: string;
}
