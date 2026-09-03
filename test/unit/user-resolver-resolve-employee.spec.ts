import { UserResolver } from '../../src/modules/identity/graphql/user.resolver';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';

function buildResolver(employee: { id: string } | null) {
  const employeesRepository = { findByUserId: jest.fn().mockResolvedValue(employee) };
  const resolver = new UserResolver(
    {} as never, // usersRepository - unused by resolveEmployee
    {} as never, // userRolesRepository
    {} as never, // rolesRepository
    employeesRepository as never,
    {} as never, // orgUnitsRepository - unused by resolveEmployee
  );
  return { resolver, employeesRepository };
}

describe('UserResolver.resolveEmployee (ADR-0150/ADR-0157)', () => {
  it('resolves me.employee via EmployeesRepository.findByUserId(user.id)', async () => {
    const { resolver, employeesRepository } = buildResolver({ id: EMPLOYEE_ID });

    const result = await resolver.resolveEmployee({ id: USER_ID } as never);

    expect(employeesRepository.findByUserId).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({ id: EMPLOYEE_ID });
  });

  it('returns null when the user has no linked employee', async () => {
    const { resolver } = buildResolver(null);

    const result = await resolver.resolveEmployee({ id: USER_ID } as never);

    expect(result).toBeNull();
  });
});
