/** RFC 7644 §3.4.2's `ListResponse` envelope, shared by `/scim/v2/Users` and `/scim/v2/Groups`. */
export function toScimListResponse<T>(resources: T[], totalResults: number, startIndex: number, count: number) {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults,
    startIndex,
    itemsPerPage: Math.min(count, resources.length),
    Resources: resources,
  };
}
