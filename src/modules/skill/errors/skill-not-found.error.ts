import { NotFoundError } from '../../../common/errors/not-found.error';

export class SkillNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Skill', id);
  }
}
