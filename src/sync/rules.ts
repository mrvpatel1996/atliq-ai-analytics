// ─── Sync Rule Types ─────────────────────────────────────────

export type SyncTrigger = "manual" | "scheduled" | "webhook" | "upload";

export interface SyncFilter {
  titlePattern?: string;
  minDuration?: number;
  maxDuration?: number;
  statuses?: string[];
  updatedAfter?: Date;
}

export interface SyncTransform {
  titleTemplate?: string;
  descriptionTemplate?: string;
  addTags?: string[];
  removeTags?: string[];
}

export interface SyncRule {
  id: string;
  name: string;
  sourceProviderId: string;
  destinationProviderIds: string[];
  trigger: SyncTrigger;
  filter?: SyncFilter;
  transform?: SyncTransform;
  isActive: boolean;
}

export interface SyncExecuteParams {
  jobId: string;

  // Legacy S3 mode
  sourceKey?: string;
  sourceBucket?: string;
  destinations?: string[];
  platformOptions?: {
    vimeo?: Record<string, unknown>;
    gumlet?: Record<string, unknown>;
    cloudflare?: Record<string, unknown>;
  };

  // Provider-based mode
  sourceProviderId?: string;
  destinationProviderIds?: string[];
  sourceVideoId?: string;

  // Common
  title?: string;
  description?: string;
  tags?: string[];
  onProgress?: (pct: number) => Promise<void>;
}
