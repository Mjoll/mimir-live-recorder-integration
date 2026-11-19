/** Creates the Mimir item for a live recording and returns its ID. */
export async function createLiveItem(params: {
  baseUrl: string;
  apiKey: string;
  title: string;
  generatedMediaLocationId: string;
}): Promise<string> {
  const response = await fetch(`${params.baseUrl}/api/v1/items`, {
    method: 'POST',
    headers: { 'x-mimir-cognito-id-token': `Bearer ${params.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      itemType: 'video',
      title: params.title,
      metadata: { formId: 'default', formData: { title: params.title } },
      // Says that a proxy TS stream will arrive in S3, which makes this a live item that accepts segments.
      enabledStreams: ['lrwt'],
      // Must be at the top level; nested anywhere else, it is ignored and Mimir's own bucket is used.
      generatedMediaLocationId: params.generatedMediaLocationId,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Creating the Mimir item failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return (JSON.parse(text) as { id: string }).id;
}
