export function queueJobId(eventId: string): string {
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw new Error('queue-event-id-required');
  }
  return `mw_${Buffer.from(eventId, 'utf16le').toString('base64url')}`;
}
