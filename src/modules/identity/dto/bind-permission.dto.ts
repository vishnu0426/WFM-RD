import { IsUUID } from 'class-validator';

export class BindPermissionDto {
  @IsUUID()
  permissionId!: string;
}
