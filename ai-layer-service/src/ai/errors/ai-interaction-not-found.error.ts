import { DomainError } from '../../common/errors/domain-error';

export class AiInteractionNotFoundError extends DomainError {
  constructor(aiInteractionId: string) {
    super('AI_INTERACTION_NOT_FOUND', `No AIInteraction with id "${aiInteractionId}" was found for this tenant.`);
  }
}
