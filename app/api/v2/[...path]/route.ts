import { env } from 'cloudflare:workers';
import { handlePlatformRequest } from '../../../../server/platform-api.mjs';

export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handlePlatformRequest(request, env);
export const POST = (request: Request) => handlePlatformRequest(request, env);
export const PATCH = (request: Request) => handlePlatformRequest(request, env);
export const DELETE = (request: Request) => handlePlatformRequest(request, env);
