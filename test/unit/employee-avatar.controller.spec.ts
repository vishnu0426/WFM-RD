import { randomUUID } from 'node:crypto';
import { EmployeeAvatarController } from '../../src/modules/employee/rest/employee-avatar.controller';
import { EmployeesService } from '../../src/modules/employee/services/employees.service';
import { EmployeeNotFoundError } from '../../src/modules/employee/errors/employee-not-found.error';
import { InvalidAvatarFileError } from '../../src/modules/employee/errors/invalid-avatar-file.error';
import { RequestWithTokenClaims } from '../../src/modules/auth/rest/access-token.guard';

const TENANT_A = randomUUID();
const EMPLOYEE_ID = randomUUID();

function fakeRequest(): RequestWithTokenClaims {
  return { tokenClaims: { tenant_id: TENANT_A, sub: 'admin-1', permissions: [], roles: [] } } as never;
}

/** Builds a minimal `Express.Multer.File`-shaped object, standing in for what `FileInterceptor`/`diskStorage` would actually attach to `req.file`. */
function fakeMulterFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'photo.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 1024,
    destination: '/tmp/uploads/avatars',
    filename: `${EMPLOYEE_ID}.png`,
    path: `/tmp/uploads/avatars/${EMPLOYEE_ID}.png`,
    stream: undefined as never,
    buffer: undefined as never,
    ...overrides,
  } as Express.Multer.File;
}

describe('EmployeeAvatarController', () => {
  let employeesService: { findById: jest.Mock; setAvatarUrl: jest.Mock };
  let auditLog: { record: jest.Mock };
  let controller: EmployeeAvatarController;

  beforeEach(() => {
    employeesService = { findById: jest.fn(), setAvatarUrl: jest.fn() };
    auditLog = { record: jest.fn() };
    controller = new EmployeeAvatarController(
      employeesService as unknown as EmployeesService,
      auditLog as never,
    );
  });

  it('persists the avatarUrl, returns it, and records an audit entry - on a validated multipart upload', async () => {
    employeesService.findById.mockResolvedValue({ id: EMPLOYEE_ID });
    employeesService.setAvatarUrl.mockResolvedValue({ id: EMPLOYEE_ID, avatarUrl: `/uploads/avatars/${EMPLOYEE_ID}.png` });

    const result = await controller.upload(fakeRequest(), EMPLOYEE_ID, fakeMulterFile());

    expect(result).toEqual({ avatarUrl: `/uploads/avatars/${EMPLOYEE_ID}.png` });
    expect(employeesService.setAvatarUrl).toHaveBeenCalledWith(EMPLOYEE_ID, `/uploads/avatars/${EMPLOYEE_ID}.png`);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        action: 'employee.avatar_uploaded',
        resourceId: EMPLOYEE_ID,
        afterState: { avatarUrl: `/uploads/avatars/${EMPLOYEE_ID}.png` },
      }),
    );
  });

  it('derives the file extension from the validated mimetype, not from the original filename', async () => {
    employeesService.findById.mockResolvedValue({ id: EMPLOYEE_ID });
    employeesService.setAvatarUrl.mockResolvedValue({ id: EMPLOYEE_ID });

    // originalname claims .exe, but the mimetype (what fileFilter actually
    // validated) is image/webp - the resulting URL must follow the mimetype.
    const result = await controller.upload(
      fakeRequest(),
      EMPLOYEE_ID,
      fakeMulterFile({ mimetype: 'image/webp', originalname: 'malicious.exe' }),
    );

    expect(result).toEqual({ avatarUrl: `/uploads/avatars/${EMPLOYEE_ID}.webp` });
  });

  it('rejects with InvalidAvatarFileError when no file is present (fileFilter rejected the mimetype, or none was attached)', async () => {
    employeesService.findById.mockResolvedValue({ id: EMPLOYEE_ID });

    await expect(controller.upload(fakeRequest(), EMPLOYEE_ID, undefined)).rejects.toThrow(InvalidAvatarFileError);
    expect(employeesService.setAvatarUrl).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('rejects an unknown employee id with a real 404, without touching the file or auditing', async () => {
    employeesService.findById.mockRejectedValue(new EmployeeNotFoundError('missing'));

    await expect(controller.upload(fakeRequest(), 'missing', fakeMulterFile())).rejects.toThrow(EmployeeNotFoundError);
    expect(employeesService.setAvatarUrl).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });
});
