// A stand-in identity provider for the oauth plugin's tests: oauth2-mock-server
// with a real RS256 key, a real key set and the authorization code flow with
// PKCE. It serves its own discovery documents, which each test may change or
// remove, because the mock's built-in one offers neither client ID metadata
// documents nor a registration endpoint, and the relay rightly refuses such a
// provider. Like WorkOS with a Resource Indicator, it puts the RFC 8707
// `resource` a client asks for into the access token's `aud`; the mock alone
// ignores that parameter.

import type { ServerResponse } from 'node:http';
import { Events, OAuth2Server } from 'oauth2-mock-server';

/** The subject the mock gives whoever signs in through its /authorize. */
export const MOCK_SUBJECT = 'johndoe';

export interface TestProvider {
  readonly issuer: string;
  /** Served at /.well-known/oauth-authorization-server; null answers 404. */
  oauthMetadata: Record<string, unknown> | null;
  /** Served at /.well-known/openid-configuration; null answers 404. */
  oidcMetadata: Record<string, unknown> | null;
  /**
   * An RS256 access token signed with the provider's key. `claims` are merged
   * into the mock's payload (iss, iat, nbf, and exp an hour on); a claim given
   * as undefined is removed.
   */
  token(claims?: Record<string, unknown>): Promise<string>;
  stop(): Promise<void>;
}

/** Metadata a provider Claude can use: S256, and client ID metadata documents with `none`. */
export function goodMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
  };
}

export async function startProvider(): Promise<TestProvider> {
  // The built-in discovery document moves aside, so ours can be served in its place.
  const server = new OAuth2Server(undefined, undefined, {
    endpoints: { wellKnownDocument: '/.well-known/mock-builtin-openid-configuration' },
  });
  await server.issuer.keys.generate('RS256');
  await server.start(0, '127.0.0.1');
  // The mock names itself localhost; the address it listens on keeps tests off name resolution.
  const issuer = `http://127.0.0.1:${String(server.address().port)}`;
  server.issuer.url = issuer;

  const documents: {
    oauth: Record<string, unknown> | null;
    oidc: Record<string, unknown> | null;
  } = { oauth: goodMetadata(issuer), oidc: null };
  const serve =
    (pick: () => Record<string, unknown> | null) =>
    (_request: unknown, response: ServerResponse): void => {
      const document = pick();
      if (document === null) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(document));
    };
  server.service.addRoute(
    'GET',
    '/.well-known/oauth-authorization-server',
    serve(() => documents.oauth),
  );
  server.service.addRoute(
    'GET',
    '/.well-known/openid-configuration',
    serve(() => documents.oidc),
  );
  // The ID token already carries its client as audience; only the access token gets the resource.
  server.service.on(
    Events.BeforeTokenSigning,
    (token: { payload: Record<string, unknown> }, request: { body?: unknown }) => {
      const body = request.body as Record<string, unknown> | undefined;
      if (token.payload.aud === undefined && typeof body?.resource === 'string') {
        token.payload.aud = body.resource;
      }
    },
  );

  return {
    issuer,
    get oauthMetadata() {
      return documents.oauth;
    },
    set oauthMetadata(value) {
      documents.oauth = value;
    },
    get oidcMetadata() {
      return documents.oidc;
    },
    set oidcMetadata(value) {
      documents.oidc = value;
    },
    token(claims = {}) {
      return server.issuer.buildToken({
        scopesOrTransform: (_header, payload) => {
          for (const [key, value] of Object.entries(claims)) {
            if (value === undefined) Reflect.deleteProperty(payload, key);
            else payload[key] = value;
          }
        },
      });
    },
    stop: () => server.stop(),
  };
}
