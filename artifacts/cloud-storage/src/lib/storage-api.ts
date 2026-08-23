export type ConnectionTestResult = {
  ok: boolean;
  status: 'connected' | 'not_configured' | 'unauthorized' | 'not_found' | 'unreachable' | 'error';
  message: string;
  endpoint: string | null;
  item: string | null;
};

export async function testStorageConnection(): Promise<ConnectionTestResult> {
  const response = await fetch('/api/storage/connection-test', {
    method: 'POST',
    headers: { accept: 'application/json' },
  });

  const result = (await response.json()) as ConnectionTestResult;
  return result;
}