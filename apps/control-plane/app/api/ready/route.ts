import { NextResponse } from 'next/server';

import { repositoryFromEnv } from '../../../src/persistence/repository-factory';

export async function GET(): Promise<Response> {
  try {
    await repositoryFromEnv().listProjects({ limit: 1 });
    return NextResponse.json({ status: 'ready' });
  } catch {
    return NextResponse.json({ status: 'unavailable' }, { status: 503 });
  }
}
