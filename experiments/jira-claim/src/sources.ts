/**
 * The primary sources behind the experiment. Quotes are verbatim from the
 * Jira Cloud v3 documentation/OpenAPI (accessed 2026-10-24), except the
 * `openapi-scan` entry, whose "quotes" record the findings of scanning the
 * published OpenAPI. Nothing from the Jira Data Center/Server documentation is
 * imported: the API and its property semantics are a different edition.
 */

export const ACCESSED = "2026-10-24";
export const OPENAPI_VERSION = "1001.0.0-SNAPSHOT-12ca6ec572dce8558d78a98d942a1c3f7f182787";

export interface SourceNote {
  id: string;
  title: string;
  url: string;
  establishes: string;
  doesNotEstablish: string;
  quotes: readonly string[];
}

export const SOURCES: readonly SourceNote[] = [
  {
    id: "entity-properties",
    title: "Jira entity properties",
    url: "https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/",
    establishes:
      "properties are a global-namespace key/value store on an issue, editable by every user who may edit the issue and by every app; last write wins",
    doesNotEstablish:
      "any optimistic concurrency control, any ownership of a property, any per-instance isolation",
    quotes: [
      "Entity properties can be modified by all users that have permission to edit the entity. For example, any user who can update an issue can also update an entity property stored on that issue.",
      "Entity properties can be modified by all apps in the system and exist in a global namespace.",
      "Entity properties are not sandboxed on a per-user basis. This means that the same entity property can be edited by two users. There is no mechanism to handle concurrent edits by users to the one property. A property contains the data that was most recently saved.",
      "The maximum length of an entity property key is 255 bytes.",
      "The maximum length of an entity property value is 32768 bytes.",
    ],
  },
  {
    id: "bulk-set-conditional",
    title: "Bulk set issue property — PUT /rest/api/3/issue/properties/{propertyKey}",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/#api-rest-api-3-issue-properties-propertykey-put",
    establishes:
      "the filter's eligibility criteria (entityIds, currentValue, hasProperty), their AND composition, the all-or-nothing transaction, and asynchrony",
    doesNotEstablish:
      "when the filter is evaluated, whether two jobs are isolated, whether test-and-write is atomic, what the task result contains, or that an eligible write happened at all",
    quotes: [
      "The filter identifies issues eligible for update using these criteria: entityIds Only issues from this list are eligible. currentValue Only issues with the property set to this value are eligible. hasProperty: If true, only issues with the property are eligible. If false, only issues without the property are eligible.",
      "If more than one criteria is specified, they are joined with the logical AND: only issues that satisfy all criteria are eligible.",
      "This operation is: transactional, either all eligible issues are updated or, when errors occur, none are updated. asynchronous. Follow the location link in the response to determine the status of the task and use Get task to obtain subsequent updates.",
      "Browse projects project permission for each project containing issues.",
      "Edit issues project permission for each issue.",
    ],
  },
  {
    id: "bulk-set-conditional-responses",
    title: "Bulk set issue property — documented responses",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/#api-rest-api-3-issue-properties-propertykey-put",
    establishes: "the endpoint documents 303, 400 and 401 only",
    doesNotEstablish:
      "no 409 'another bulk update on the same issues is already in progress' is documented for this endpoint (unlike the two POST bulk endpoints)",
    quotes: ["303 Returned if the request is successful.", "400 Returned if the request is invalid.", "401 Returned if the authentication credentials are incorrect or missing."],
  },
  {
    id: "bulk-set-list",
    title: "Bulk set issues properties by list — POST /rest/api/3/issue/properties",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/#api-rest-api-3-issue-properties-post",
    establishes:
      "a list form with up to 10 properties and 10,000 issues; async; transactional on errors; a documented 409 while another bulk update on the same issues is in progress",
    doesNotEstablish:
      "a conditional write. The list is blind: every listed issue is written, and 'retry later' is not a compare-and-set",
    quotes: [
      "Sets or updates a list of entity property values on issues. A list of up to 10 entity properties can be specified along with up to 10,000 issues on which to set or update that list of entity properties.",
      "transactional, either all properties are updated in all eligible issues or, when errors occur, no properties are updated.",
      "409 Returned if another bulk update on the same issues is already in progress. Retry the request later.",
    ],
  },
  {
    id: "bulk-set-multi",
    title: "Bulk set issue properties by issue — POST /rest/api/3/issue/properties/multi",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/#api-rest-api-3-issue-properties-multi-post",
    establishes: "a per-issue list form that is explicitly NON-transactional; partial updates are reported in the task result",
    doesNotEstablish: "any condition or isolation",
    quotes: [
      "non-transactional. Updating some entities may fail. Such information will available in the task result.",
      "Note that if an issue is not found, it is ignored.",
    ],
  },
  {
    id: "set-single-property",
    title: "Set issue property — PUT /rest/api/3/issue/{issueIdOrKey}/properties/{propertyKey}",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/#api-rest-api-3-issue-issueidorkey-properties-propertykey-put",
    establishes: "a blind single-issue write returning 200 (updated) or 201 (created)",
    doesNotEstablish: "any precondition, version or If-Match header; any uniqueness",
    quotes: [
      "Sets the value of an issue's property. Use this resource to store custom data against an issue.",
      "200 Returned if the issue property is updated. 201 Returned if the issue property is created.",
    ],
  },
  {
    id: "delete-single-property",
    title: "Delete issue property — DELETE /rest/api/3/issue/{issueIdOrKey}/properties/{propertyKey}",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/#api-rest-api-3-issue-issueidorkey-properties-propertykey-delete",
    establishes: "the operator's manual release can remove the mark without touching the issue's workflow",
    doesNotEstablish: "that deleting the mark stops a Worker",
    quotes: ["Deletes an issue's property.", "204 Returned if the request is successful."],
  },
  {
    id: "async",
    title: "Asynchronous operations (Jira Cloud REST API introduction)",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/#async",
    establishes:
      "a 303 + Location schedules a task; the task's result content is operation-specific; tasks are NOT guaranteed to run in order",
    doesNotEstablish: "ordering, exactly-once execution or any relation between submission order and authority",
    quotes: [
      "When the task finishes, the response object will contain the result field. The content of the field is specific to the operation that created the task. Refer to the operation's documentation for more information.",
      "Note that asynchronous tasks are not guaranteed to be run in order. In other words, if you need your tasks to execute in a certain order, you should start a task only after the prerequisite task(s) have finished.",
    ],
  },
  {
    id: "get-task",
    title: "Get task — GET /rest/api/3/task/{taskId}",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-tasks/#api-rest-api-3-task-taskid-get",
    establishes: "the task status and an opaque result; task details retained for 14 days",
    doesNotEstablish: "what the bulk-property task's result contains",
    quotes: [
      "The result of the task execution.",
      "Task details are not permanently retained. As of September 2019, details are retained for 14 days although this period may change without notice.",
    ],
  },
  {
    id: "search-jql",
    title: "Search for issues using JQL enhanced search — GET /rest/api/3/search/jql",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-get",
    establishes:
      "the search that feeds pool discovery may omit recent updates; read-after-write needs reconcileIssues",
    doesNotEstablish: "that a free observation is true, or any freshness guarantee for the claim decision",
    quotes: [
      "Recent updates might not be immediately visible in the returned search results. If you need read-after-write consistency, you can utilize the reconcileIssues parameter to ensure stronger consistency assurances.",
      "Strong consistency issue ids to be reconciled with search results. Accepts max 50 ids.",
    ],
  },
  {
    id: "edit-issue",
    title: "Edit issue — PUT /rest/api/3/issue/{issueIdOrKey}",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-put",
    establishes: "a common edit may update issue properties; 409 is documented as 'a conflicting update'",
    doesNotEstablish:
      "a condition, version token or property check. 'Conflicting update' is not a compare-and-set on the claim value",
    quotes: [
      "Edits an issue. Issue properties may be updated as part of the edit.",
      "409 Returned if the issue could not be updated due to a conflicting update.",
    ],
  },
  {
    id: "transition",
    title: "Transition issue — POST /rest/api/3/issue/{issueIdOrKey}/transitions",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-transitions-post",
    establishes: "a blind transition write; 409 'conflicting update' also exists here",
    doesNotEstablish: "a condition tied to the claim, or that the transition needs no workflow change",
    quotes: [
      "Performs an issue transition and, if the transition has a screen, updates the fields from the transition screen.",
      "409 Returned if the issue could not be updated due to a conflicting update.",
    ],
  },
  {
    id: "assignee",
    title: "Assign issue — PUT /rest/api/3/issue/{issueIdOrKey}/assignee",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-assignee-put",
    establishes: "a blind assignment to one account (or unassigned); it needs Assign Issues permission",
    doesNotEstablish: "uniqueness or identity of the instance: the account may be shared",
    quotes: [
      "Assigns an issue to a user. Use this operation when the calling user does not have the Edit Issues permission but has the Assign issue permission for the project that the issue is in.",
      "204 Returned if the request is successful.",
    ],
  },
  {
    id: "bulk-edit-issues",
    title: "Bulk edit issues — POST /rest/api/3/bulk/issues/fields",
    url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-bulk-operations/#api-rest-api-3-bulk-issues-fields-post",
    establishes:
      "the bulk edit endpoint requires the global Bulk change permission; it is a different endpoint from the property write",
    doesNotEstablish: "any permission or condition of the property endpoint",
    quotes: [
      "Global bulk change permission.",
      "Browse project permission in all projects that contain the selected issues.",
      "Edit issues permission in all projects that contain the selected issues.",
    ],
  },
  {
    id: "rate-limits",
    title: "Rate limiting (Jira Cloud)",
    url: "https://developer.atlassian.com/cloud/jira/platform/rate-limiting/",
    establishes:
      "points-based hourly quota, per-endpoint burst buckets, 429 with Retry-After; writes cost the base point",
    doesNotEstablish: "priority between factories sharing an account or a tenant",
    quotes: [
      "Each request starts with a base cost of 1 point, and additional points are added for each object involved. Write requests are charged only the base cost, with no additional points.",
      "HTTP method Requests per second GET 100 POST 100 PUT 50 DELETE 50",
      "When a request rate limit is exceeded for a specific API endpoint, Jira returns a standard rate limit response with the following headers: HTTP status : 429 Too Many Requests ... Retry-After: 1",
    ],
  },
  {
    id: "openapi-scan",
    title: `Scan of the published Jira Cloud OpenAPI (${OPENAPI_VERSION})`,
    url: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json",
    establishes:
      "no operation declares If-Match/If-None-Match; the only header parameter in the entire document is Atlassian-Transfer-Id",
    doesNotEstablish:
      "that conditional requests are silently supported. A header the documentation does not declare is not a guarantee",
    quotes: [
      "Scan finding: header parameters declared by the entire OpenAPI document are Atlassian-Transfer-Id only.",
      "Scan finding: no path declares If-Match, If-None-Match, ETag or a version precondition parameter.",
    ],
  },
];

