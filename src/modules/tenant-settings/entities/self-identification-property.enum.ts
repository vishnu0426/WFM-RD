/**
 * The fixed catalog of employee properties a tenant can require for
 * self-identification. Only properties that actually exist on
 * `User`/`Employee` in this schema (`src/modules/identity/entities/user.entity.ts`,
 * `src/modules/employee/entities/employee.entity.ts`). `Employee.taxId` is
 * deliberately excluded — self-identification is a self-service matching
 * catalog, not a place to expose SSNs to end users configuring intake forms.
 * Agent ID/Extension (now on the `EmployeeDataSource` child table, not
 * `Employee` itself) are excluded too — they aren't identity-matching
 * fields, and a person can hold more than one anyway.
 */
export enum SelfIdentificationProperty {
  EMAIL = 'email',
  GIVEN_NAME = 'given_name',
  FAMILY_NAME = 'family_name',
  EMPLOYEE_NUMBER = 'employee_number',
  HIRE_DATE = 'hire_date',
  COST_CENTER = 'cost_center',
  MIDDLE_INITIAL = 'middle_initial',
  BIRTH_DATE = 'birth_date',
  HOME_PHONE = 'home_phone',
  WORK_PHONE = 'work_phone',
  CELL_PHONE = 'cell_phone',
}
