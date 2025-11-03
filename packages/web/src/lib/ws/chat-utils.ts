export const getConversationId = (params: any): string | undefined => {
  const cid = params?.conversationId
  return typeof cid === 'string' && cid.length > 0 ? cid : undefined
}

export const parseEventId = (value: any): number => {
  if (value == null) return 0
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

export const eventIdFromParams = (params: any): number => parseEventId(params?.eventId)

export const normalizeText = (input: string): string => String(input || '').replace(/\r/g, '')
