export interface OwnerRecoveryInput {
  credential: string;
  newPassword: string;
}

export async function readOwnerRecoveryInput(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<OwnerRecoveryInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new Error('Input too large');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks),
  );
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid input');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['credential', 'newPassword'].includes(key),
    ) ||
    typeof record.credential !== 'string' ||
    typeof record.newPassword !== 'string'
  )
    throw new Error('Invalid input');
  return { credential: record.credential, newPassword: record.newPassword };
}
