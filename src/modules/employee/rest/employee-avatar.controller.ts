import * as fs from 'fs';
import * as path from 'path';
import { Controller, Param, Post, Req, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { EmployeesService } from '../services/employees.service';
import { InvalidAvatarFileError } from '../errors/invalid-avatar-file.error';

/** `<repo-root>/uploads/avatars` — resolved from `process.cwd()`, same assumption `main.ts`'s relative `.env` loading already makes about always running from the repo root, in dev (`ts-node`/`nest start --watch`) and in `dist/` after build alike. */
const AVATAR_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'avatars');
fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });

/** Only these three mimetypes are accepted — never trusted from `file.originalname`'s extension, only from the validated mimetype itself. */
const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/**
 * §5's avatar-upload surface — the one write path in this module that isn't
 * GraphQL, alongside `EmployeeTaxIdController`'s one read exception, because
 * a multipart file upload has no clean GraphQL equivalent. Gated on
 * `employee:write`, the same permission `EmployeeResolver.updateEmployee`
 * requires, since this is functionally a (narrow) employee update.
 *
 * The uploaded filename is always forced to `${employeeId}${ext}`, `ext`
 * derived from the validated mimetype via `EXTENSION_BY_MIMETYPE` - never
 * `file.originalname`, which is fully attacker-controlled (path traversal,
 * arbitrary extension, no relation to actual file content).
 */
@Controller('v1/employees')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeAvatarController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Post(':id/avatar')
  @RequirePermissions('employee:write')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });
          cb(null, AVATAR_UPLOAD_DIR);
        },
        filename: (req, file, cb) => {
          const employeeId = (req.params as Record<string, string>).id;
          const ext = EXTENSION_BY_MIMETYPE[file.mimetype];
          cb(null, `${employeeId}${ext}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        cb(null, Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIMETYPE, file.mimetype));
      },
    }),
  )
  async upload(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ avatarUrl: string }> {
    // Confirms the employee exists before accepting the upload - a 404 here
    // takes priority over a 400 rejected-file, matching how every other
    // write in this module validates referenced ids up front (see
    // `EmployeesService.create`'s own doc comment).
    await this.employeesService.findById(id);

    if (!file) {
      throw new InvalidAvatarFileError();
    }

    const ext = EXTENSION_BY_MIMETYPE[file.mimetype];
    const avatarUrl = `/uploads/avatars/${id}${ext}`;
    await this.employeesService.setAvatarUrl(id, avatarUrl);

    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'employee.avatar_uploaded',
      resourceType: 'employee',
      resourceId: id,
      beforeState: null,
      afterState: { avatarUrl },
      aiRationale: null,
    });

    return { avatarUrl };
  }
}
