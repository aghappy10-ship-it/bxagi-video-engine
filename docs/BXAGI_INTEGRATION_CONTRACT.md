# BXAGI workforce integration contract

The adapter uses actual BXAGI public-client protocol. Runtime identity and employees must come from the upstream API, not local role names. Live sign-in, file transfer and employee execution require a real account and are not fixture-verified claims.

## Ownership and module boundaries

- `server/bxagi-auth.mjs` / `bxagi-session-repository.mjs`: upstream login and server-encrypted sessions, scoped to the verified BXAGI subject/account mapping. `resolveBxagiContext(request,env,{fetcher,required})` returns server-only `{userId,nativeUserId:userId,subject,profile,accessToken,sessionId}`. Auth routes `/bxagi/auth/status|login|logout` are handled before normal API actions. Cookie uses `__Host-bxagi-session; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`, with no `Domain`; passwords are never saved.
- `server/bxagi-workforce.mjs`: fixed-origin observed API adapter; no hire, renew, arbitrary host, unverified runtime direct calls or imaginary success.
- `server/bxagi-orchestrator.mjs`: owner-scoped production/buying jobs, automatic employee routing, staged dispatch, actual artifact import, budget-safe real channel execution.
- `server/platform-api.mjs`: route integration. `components/platform/` stops local automatic production when a BXAGI job is returned, polls real job sync and refreshes stored results.

## Orchestrator interface

`createBxagiOrchestrator({repository,bucket,env,context,fetcher,adsService,workforce?})` returns:

- `catalog()` => actual normalized upstream employees, cached only for this request.
- `submitProduction(project,{optimizationTaskId?})` => `{provider:'bxagi',queued:true,project,job,assignment,variants:[]}`.
- `submitBuying(campaign,{action:'launch'|'pause'})` => `{provider:'bxagi',queued:true,campaign,job}`; initial launch explicitly authorizes selected actual creatives and current budget but does not fabricate active status.
- `syncJob(id)` => `{provider:'bxagi',job,creatives:[],campaign?}`; one staged operation at a time. Unknown create/send outcome requires reconciliation, not automatic write retry.

Repository additions: owner-scoped `getJob(userId,id)`, `updateJob(userId,id,patch)`, `claimBxagiJobOperation(userId,id,operationId)` / `releaseBxagiJobOperation`, `listDueBxagiJobs(limit)` worker-only. Claim uses job.details.operationId/operationExpiresAt, and can recover expired locks only when no remote writePending exists. Atomic createBxagiProductionJob prevents simultaneous active production for the same owner/project; listPendingBxagiOptimizations filters autoOptimize opt-in, owner/project links, retry time and nonexpired owner sessions. Existing optimization-task methods are reused. BXAGI token stays outside job details.

## API integration

- Bootstrap includes `bxagi:{connected,profile?,status,error?,protocolVerified:true,liveVerified:false}` and actual employee records if connected. It never exports access/session tokens. Missing connection remains explicit.
- Production `/projects/:id/plan` uses BXAGI if connected; deployment sets required mode for workflow actions. It returns an async job rather than claiming variants/files are finished. Upload remains actual cloud storage; dispatch begins after plan request so multiple source files form one input snapshot.
- Explicit launch/pause routes use BXAGI buying job before calling the guarded ads service. Active/paused status comes only from real provider reads and mutations.
- POST `/bxagi/jobs/:id/sync` resumes an owner job using the current verified BXAGI context. Service worker may sync due jobs and queue eligible opt-in feedback production using saved owner credential, verified subject and existing worker authorization. Budget monitoring and BXAGI synchronization have separate endpoints and runner threads. Each poll transfers at most one source/result; partial artifacts remain drafts until the whole manifest is validated.
- Local fallback is explicit and never represents a remote employee run. A configured but failing BXAGI service must not silently fall back.

## Artifact convention

For each task, create a new conversation with the selected already-hired employee and its authorized node/memory. Upload original source files into `bxagi-advertising/<jobId>/input/`. Send the actual production instruction only after sources are stored.

Ask the employee to write `bxagi-advertising/<jobId>/output/manifest.json`:

```json
{"version":1,"jobId":"same job id","kind":"production","creatives":[{"path":"bxagi-advertising/job/output/creative.png","filename":"creative.png","mimeType":"image/png","title":"fact-grounded title","format":"portrait","sourceAssetIds":["own source id"],"factsUsed":["a provided fact"]}]}
```

A buying job writes `kind:'buying'` and `decision:{action:'launch'|'pause',campaignId:'same campaign id',inputVersion:'exact current campaign fingerprint'}` plus rationale. This is an execution request, not proof of channel success; the platform checks current owner/budget/content and its real ad adapter.

Only bounded actual PNG/MP4/text bytes in the task's output directory may enter R2. Manifest and conversation text alone do not complete production. Technical byte checks do not imply semantic review or measured uplift. Source IDs and feedback revision remain traceable.

Current remote transfer bound is 16 MiB per file to stay within hosted Worker memory; original local uploads remain 64 MiB. No automatic hiring or subscription renewal occurs.

## Access boundary

The opaque session cookie supports third-party embedding through [CHIPS](https://privacysandbox.google.com/cookies/chips): its host binding remains restricted to the Site, and supporting browsers partition it by the top-level site. Setting and clearing use the same partition attributes. The server additionally binds every session to the unique verified BXAGI account and workspace mapping, caps its lifetime at seven days, and keeps strict same-origin `Origin` / `Sec-Fetch-Site` checks for mutations. Cookie-header and cross-origin rejection tests pass; an actual embedded-browser login has not been verified.

The application now authenticates directly with BXAGI, and no native hosting identity headers are trusted. The public entry displays only the BXAGI login page; owned records and files remain protected by a valid session. bxagiAccounts and bxagiLegacyBindings preserve unambiguous existing workspace associations and reject conflicts. Standalone builds omit Sites/connector integration and project metadata; see STANDALONE_DEPLOYMENT.md. The existing demonstration URL still uses its current hosting infrastructure until separately migrated.
