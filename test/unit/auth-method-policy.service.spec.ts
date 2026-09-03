import { AuthMethodPolicyService } from '../../src/modules/auth/services/auth-method-policy.service';
import { UnauthorizedClientError } from '../../src/modules/auth/errors/unauthorized-client.error';

describe('AuthMethodPolicyService', () => {
  const makePoliciesRepository = (policy: unknown) => ({
    findActiveByType: jest.fn().mockResolvedValue(policy),
  });

  it('defaults to both methods allowed, none required, when no tenant policy exists', async () => {
    const service = new AuthMethodPolicyService(makePoliciesRepository(null) as never);
    await expect(service.assertMethodPermitted('pwd')).resolves.toBeUndefined();
    await expect(service.assertMethodPermitted('webauthn')).resolves.toBeUndefined();
  });

  it('rejects a method not in allowedMethods', async () => {
    const repo = makePoliciesRepository({ definition: { allowedMethods: ['webauthn'] } });
    const service = new AuthMethodPolicyService(repo as never);
    await expect(service.assertMethodPermitted('pwd')).rejects.toThrow(UnauthorizedClientError);
    await expect(service.assertMethodPermitted('webauthn')).resolves.toBeUndefined();
  });

  it('rejects a method not in a non-empty requiredMethods, even if it would otherwise be allowed', async () => {
    const repo = makePoliciesRepository({
      definition: { requiredMethods: ['webauthn'], allowedMethods: ['pwd', 'webauthn'] },
    });
    const service = new AuthMethodPolicyService(repo as never);
    await expect(service.assertMethodPermitted('pwd')).rejects.toThrow(UnauthorizedClientError);
    await expect(service.assertMethodPermitted('webauthn')).resolves.toBeUndefined();
  });
});
