// @aval/mcp — src/platforms.ts
//
// Shared PlatformRegistry data access for aval_platform, aval_request_score,
// and aval_report's "prior ScoreRequest" precondition. Separate data
// source from the trust graph (see subgraph/schema.graphql's Platform,
// PlatformVouch, ScoreRequest entities).

import type { GraphClient } from "./client.js";

export interface PlatformRecord {
  id: string;
  ensName: string;
  policyURI: string | null;
  bond: string;
  registeredAt: bigint;
  openReports: number;
  active: boolean;
}

export interface PlatformVouchRecord {
  human: string;
  issuedAt: bigint;
  expiresAt: bigint;
  revoked: boolean;
}

export interface ScoreRequestRecord {
  id: string;
  platform: string;
  subject: string;
  purposeHash: string;
  at: bigint;
}

const PLATFORM_QUERY = /* GraphQL */ `
  query Platform($id: ID!) {
    platform(id: $id) {
      id
      ensName
      policyURI
      bond
      registeredAt
      openReports
      active
      vouches(where: { revoked: false }, first: 1000) {
        human { id }
        issuedAt
        expiresAt
        revoked
      }
    }
  }
`;

interface PlatformQueryResult {
  platform: {
    id: string;
    ensName: string;
    policyURI: string | null;
    bond: string;
    registeredAt: string;
    openReports: number;
    active: boolean;
    vouches: { human: { id: string }; issuedAt: string; expiresAt: string; revoked: boolean }[];
  } | null;
}

export async function fetchPlatform(
  client: GraphClient,
  address: string,
): Promise<{ platform: PlatformRecord; vouches: PlatformVouchRecord[] } | null> {
  const { data } = await client.query<PlatformQueryResult>(PLATFORM_QUERY, { id: address.toLowerCase() });
  if (!data.platform) return null;
  const p = data.platform;
  return {
    platform: {
      id: p.id.toLowerCase(),
      ensName: p.ensName,
      policyURI: p.policyURI,
      bond: p.bond,
      registeredAt: BigInt(p.registeredAt),
      openReports: p.openReports,
      active: p.active,
    },
    vouches: p.vouches.map((v) => ({
      human: v.human.id.toLowerCase(),
      issuedAt: BigInt(v.issuedAt),
      expiresAt: BigInt(v.expiresAt),
      revoked: v.revoked,
    })),
  };
}

const SCORE_REQUESTS_QUERY = /* GraphQL */ `
  query ScoreRequests($platform: Bytes!, $subject: Bytes!, $first: Int!) {
    scoreRequests(first: $first, where: { platform: $platform, subject: $subject }) {
      id
      platform { id }
      subject { id }
      purposeHash
      at
    }
  }
`;

interface ScoreRequestsQueryResult {
  scoreRequests: { id: string; platform: { id: string }; subject: { id: string }; purposeHash: string; at: string }[];
}

/** True if `platform` has a prior attributed ScoreRequest against `subject` — the reporting precondition (docs/13-platforms.md §5). */
export async function hasPriorScoreRequest(client: GraphClient, platform: string, subject: string): Promise<boolean> {
  const { data } = await client.query<ScoreRequestsQueryResult>(SCORE_REQUESTS_QUERY, {
    platform: platform.toLowerCase(),
    subject: subject.toLowerCase(),
    first: 1,
  });
  return data.scoreRequests.length > 0;
}

const REQUESTS_LAST_30D_QUERY = /* GraphQL */ `
  query RequestsLast30d($platform: Bytes!, $since: BigInt!, $first: Int!) {
    scoreRequests(first: $first, where: { platform: $platform, at_gt: $since }) {
      id
    }
  }
`;

interface RequestsLast30dResult {
  scoreRequests: { id: string }[];
}

export async function countRequestsLast30d(client: GraphClient, platform: string, now: bigint): Promise<number> {
  const since = now - 30n * 24n * 60n * 60n;
  const { data } = await client.query<RequestsLast30dResult>(REQUESTS_LAST_30D_QUERY, {
    platform: platform.toLowerCase(),
    since: since.toString(),
    first: 1000,
  });
  return data.scoreRequests.length;
}
