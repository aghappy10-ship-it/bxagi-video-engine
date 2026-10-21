export type CatalogStatus = {
    source: {
        configured: boolean; label: string; distributorId: string; autoSync: boolean;
        connectionStatus: 'unconfigured' | 'pending' | 'verified' | 'error';
        lastSuccessAt: string | null; lastError: string | null;
    };
    integration: { configured: boolean; reason: string };
    run: null | {
        status: 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed';
        processed: number; inserted: number; updated: number; pages: number;
        nextRunAt: string | null; error: string | null; startedAt: string | null; finishedAt: string | null;
    };
    scheduler: { running: boolean; status: string };
};
export type CatalogItem = {
    id: string; externalId: string; title: string; episodeCount: number | null;
    releaseStatus: string; publishedAt: string | null; sourceUpdatedAt: string | null;
    businessMode: 'paid' | 'free' | 'unknown'; lastSeenAt: string;
};
export type CatalogItems = { items: CatalogItem[]; total: number; nextCursor: string | null; queryMs: number };
export type CatalogSourceInput = { label: string; distributorId: string; secretKey?: string; autoSync: boolean };
