import { EmployeeGrpcController } from '../../src/grpc/controllers/employee-grpc.controller';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';

function buildController(employee: { id: string } | null) {
  const tenantContext = new TenantContextService();
  const employeesRepository = {
    findByUserId: jest.fn().mockResolvedValue(employee),
  };
  const controller = new EmployeeGrpcController(
    tenantContext,
    employeesRepository as never,
    {} as never, // employeeSkillsRepository - unused by this RPC
  );
  return { controller, employeesRepository };
}

describe('EmployeeGrpcController.getEmployeeIdForUser', () => {
  it('returns found=true with the resolved employeeId when a link exists', async () => {
    const { controller } = buildController({ id: EMPLOYEE_ID });

    const result = await controller.getEmployeeIdForUser({ tenantId: TENANT_ID, userId: USER_ID });

    expect(result).toEqual({ found: true, employeeId: EMPLOYEE_ID });
  });

  it('returns found=false with an empty employeeId when no employee links to this user', async () => {
    const { controller } = buildController(null);

    const result = await controller.getEmployeeIdForUser({ tenantId: TENANT_ID, userId: USER_ID });

    expect(result).toEqual({ found: false, employeeId: '' });
  });

  it('looks up by the requested userId within the requested tenant', async () => {
    const { controller, employeesRepository } = buildController({ id: EMPLOYEE_ID });

    await controller.getEmployeeIdForUser({ tenantId: TENANT_ID, userId: USER_ID });

    expect(employeesRepository.findByUserId).toHaveBeenCalledWith(USER_ID);
  });
});
