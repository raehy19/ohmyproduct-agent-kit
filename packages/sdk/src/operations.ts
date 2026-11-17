/**
 * The API operations this SDK implements, keyed by OpenAPI `operationId`.
 * Paths are full paths on the site origin. In the OpenAPI document the
 * /api/v1 operations are relative to the server URL (`https://ohmyproduct.com/api/v1`,
 * or the sandbox `https://ohmyproduct.com/api/sandbox/v1`) and the /agent/*
 * ones carry the origin as a path-level server; `test/contract.test.mjs`
 * resolves both against `openapi.snapshot.json` and checks that every client
 * method really requests the listed path.
 */
export const OPERATIONS = {
  getApiRoot: { method: 'GET', path: '/api/v1' },
  getStatus: { method: 'GET', path: '/api/v1/status' },
  listDocs: { method: 'GET', path: '/api/v1/docs' },
  getDoc: { method: 'GET', path: '/api/v1/docs/{slug}' },
  searchDocs: { method: 'GET', path: '/api/v1/search' },
  listProducts: { method: 'GET', path: '/api/v1/products' },
  getProduct: { method: 'GET', path: '/api/v1/products/{id}' },
  listProductCategories: { method: 'GET', path: '/api/v1/product-categories' },
  joinLaunchList: { method: 'POST', path: '/api/v1/launch-list' },
  submitProduct: { method: 'POST', path: '/api/v1/product-submissions' },
  requestTestDrive: { method: 'POST', path: '/api/v1/test-drive-requests' },
  getAgentIdentity: { method: 'GET', path: '/api/v1/agent/me' },
  getAgentAuth: { method: 'GET', path: '/agent/auth' },
  describeAgentIdentityEndpoint: { method: 'GET', path: '/agent/identity' },
  registerAgentIdentity: { method: 'POST', path: '/agent/identity' },
  revokeAgentToken: { method: 'POST', path: '/agent/identity/revoke' },
} as const

export type OperationId = keyof typeof OPERATIONS
