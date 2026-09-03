import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';
import { RolePermission } from './entities/role-permission.entity';
import { UserRole } from './entities/user-role.entity';
import { UserInvite } from './entities/user-invite.entity';
import { UsersRepository } from './repositories/users.repository';
import { UserRolesRepository } from './repositories/user-roles.repository';
import { RolesRepository } from './repositories/roles.repository';
import { PermissionsRepository } from './repositories/permissions.repository';
import { RolePermissionsRepository } from './repositories/role-permissions.repository';
import { UserInvitesRepository } from './repositories/user-invites.repository';
import { UserContextResolverService } from './services/user-context-resolver.service';
import { RoleManagementService } from './services/role-management.service';
import { InviteTokenService } from './services/invite-token.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Role, Permission, RolePermission, UserRole, UserInvite])],
  providers: [
    UsersRepository,
    UserRolesRepository,
    RolesRepository,
    PermissionsRepository,
    RolePermissionsRepository,
    UserInvitesRepository,
    UserContextResolverService,
    RoleManagementService,
    InviteTokenService,
  ],
  exports: [
    TypeOrmModule,
    UsersRepository,
    UserRolesRepository,
    RolesRepository,
    PermissionsRepository,
    RolePermissionsRepository,
    UserInvitesRepository,
    UserContextResolverService,
    RoleManagementService,
    InviteTokenService,
  ],
})
export class IdentityModule {}
