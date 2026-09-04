import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryService } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../src/app.module';

/**
 * Item [24]: every HTTP route is either deliberately public or tenant-guarded.
 *
 * The route list is DERIVED from the compiled DI graph, not hardcoded, so a
 * route added in a later phase is covered the day it exists — the same
 * instinct as deriving the RLS table set from information_schema rather than
 * listing tables. A test that must be edited to cover new code is a test that
 * will not cover new code.
 *
 * Two findings in the 2026-09-04 review would have been caught here on the day
 * they shipped: `/metrics` served unauthenticated, and POST /documents
 * (presign) carrying no rate-limit window while /complete did.
 *
 * PUBLIC_ROUTES is an ALLOWLIST, and it is asserted in both directions:
 * an unlisted route must be tenant-guarded, and a listed route must still
 * exist. The second half stops the allowlist rotting into permission to skip
 * a guard on a route that has since changed shape.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  // Liveness/readiness are scraped by the orchestrator before the app can
  // possibly authenticate anything. Auth here would mean an unauthenticated
  // probe reads as "unhealthy" and the pod gets killed in a loop.
  'GET /health/live': 'orchestrator probe, pre-auth by definition',
  'GET /health/ready': 'orchestrator probe, pre-auth by definition',
  // Pre-auth by definition: these are how a caller GETS a token.
  'POST /auth/register': 'issues the first credential; rate-limited per email',
  'POST /auth/login': 'issues a token; rate-limited per email and per IP',
  'POST /auth/refresh': 'presents a refresh token, not an access token',
  // Authenticated but NOT workspace-scoped: logout revokes a token family for
  // the user, and a user is not a tenant. WorkspaceMemberGuard would require
  // an x-workspace-id header that logout has no business needing.
  'POST /auth/logout': 'user-scoped, not tenant-scoped; carries AccessTokenGuard',
  'GET /metrics': 'internal scrape endpoint; item [15] tracks gating it',
  // The local demo client, and the seeded credentials it reads. Both return
  // 404 unless NODE_ENV is development — registered unconditionally so this
  // test can see them, because a route that exists only under one NODE_ENV is
  // a route no test covers. /ui/config serves a plaintext demo password, so
  // the environment check is the whole security boundary: if it is ever
  // removed, this comment is the reason it must not be.
  'GET /ui': 'local demo client; 404 outside development',
  'GET /ui/config': 'seeded demo credentials; 404 outside development',
  // KNOWN OPEN — item [15]. Counters and histograms only: no document
  // content, no prompts, no tenant ids (see the cardinality rule on
  // MetricsService). Protection is deferred to deployment (network policy or
  // a proxy-supplied bearer token), which does not exist in this repo yet.
  // Listed here so the exposure is a recorded decision rather than an
  // oversight, and so removing it from the allowlist is what closes item [15].
};

interface Route {
  signature: string;
  guards: string[];
}

function collectRoutes(discovery: DiscoveryService): Route[] {
  const routes: Route[] = [];
  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as unknown as (new () => unknown) | undefined;
    if (!controller) continue;
    const basePath = (Reflect.getMetadata(PATH_METADATA, controller) as string) ?? '';
    const classGuards = guardNames(Reflect.getMetadata(GUARDS_METADATA, controller));
    const prototype = controller.prototype as object;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (verb === undefined) continue;
      const path = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
      routes.push({
        signature: `${RequestMethod[verb]} /${basePath}/${path}`.replace(/\/+$/, '').replace(/\/{2,}/g, '/'),
        guards: [...classGuards, ...guardNames(Reflect.getMetadata(GUARDS_METADATA, handler))],
      });
    }
  }
  return routes;
}

function guardNames(metadata: unknown): string[] {
  if (!Array.isArray(metadata)) return [];
  return metadata.map((guard: { name?: string }) => guard?.name ?? String(guard));
}

describe('every route is deliberately public or tenant-guarded (item 24)', () => {
  let moduleRef: TestingModule;
  let routes: Route[];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    routes = collectRoutes(moduleRef.get(DiscoveryService));
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('finds the application’s routes at all', () => {
    // Guards the guard: if discovery silently returned nothing, every
    // assertion below would pass vacuously.
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it('gives every non-public route AccessTokenGuard and WorkspaceMemberGuard', () => {
    const unguarded = routes
      .filter((route) => !(route.signature in PUBLIC_ROUTES))
      .filter((route) => !(route.guards.includes('AccessTokenGuard') && route.guards.includes('WorkspaceMemberGuard')))
      .map((route) => `${route.signature} :: ${route.guards.join(', ') || 'NO GUARDS'}`);

    expect(
      unguarded,
      'Every tenant-scoped route needs AccessTokenGuard + WorkspaceMemberGuard. ' +
        'If one of these is deliberately public, add it to PUBLIC_ROUTES with the reason.',
    ).toEqual([]);
  });

  it('keeps the public allowlist honest — no entry for a route that no longer exists', () => {
    const live = new Set(routes.map((route) => route.signature));
    const stale = Object.keys(PUBLIC_ROUTES).filter((signature) => !live.has(signature));
    expect(stale, 'PUBLIC_ROUTES names routes that no longer exist; delete them').toEqual([]);
  });

  it('rate-limits every route that spends money or storage', () => {
    // Presigning was exempt until item [7] on the reasoning that a signed URL
    // "commits nothing but a MinIO object" — which stopped being true once
    // the URL bound no size. Spend and storage both need a window.
    const required: Record<string, string> = {
      'POST /chat': 'ChatRateLimitGuard',
      'POST /search': 'SearchRateLimitGuard',
      'POST /documents': 'PresignRateLimitGuard',
      'POST /documents/:documentId/complete': 'UploadRateLimitGuard',
    };
    for (const [signature, guard] of Object.entries(required)) {
      const route = routes.find((candidate) => candidate.signature === signature);
      expect(route, `${signature} has disappeared; update this list deliberately`).toBeDefined();
      expect(route?.guards, `${signature} must carry ${guard}`).toContain(guard);
    }
  });
});
