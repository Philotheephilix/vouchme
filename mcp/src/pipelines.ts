// @aval/mcp — src/pipelines.ts
//
// In-memory preview store shared by aval_pipeline_preview and
// aval_pipeline_deploy (docs/06-mcp-skills.md §2.14). Natural-language ->
// Substreams pipeline generation (docs/14-substreams.md §3) is out of this
// task's reading list and build scope — these two tools implement the
// documented *shapes* faithfully (including the "refuse eventsFound == 0"
// rule) with a clearly-stubbed decoding step, rather than a real
// Substreams codegen backend.

import { randomUUID } from "node:crypto";

export interface PipelinePreview {
  previewId: string;
  description: string;
  chain: string;
  params: Record<string, unknown>;
  decodedSample: unknown[];
  eventsFound: number;
  createdAt: number;
}

const previews = new Map<string, PipelinePreview>();
const PREVIEW_TTL_MS = 30 * 60 * 1000; // previews are meant to be deployed promptly, not hoarded

export function savePreview(preview: PipelinePreview): void {
  previews.set(preview.previewId, preview);
}

export function getPreview(previewId: string): PipelinePreview | null {
  const p = previews.get(previewId);
  if (!p) return null;
  if (Date.now() - p.createdAt > PREVIEW_TTL_MS) {
    previews.delete(previewId);
    return null;
  }
  return p;
}

export function newPreviewId(): string {
  return `preview_${randomUUID()}`;
}
