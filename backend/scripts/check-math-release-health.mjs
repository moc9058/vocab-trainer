const url = new URL('/health', process.argv[2]);
const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
const health = await response.json();
if (!response.ok || health.status !== 'ok' || !health.mathSchemaVersions?.includes(2) || health.sourceAliasVersion !== 2)
  throw new Error('Backend does not support the staged v2 catalog/source reader');
console.log('Math v1/v2 reader health verified');
