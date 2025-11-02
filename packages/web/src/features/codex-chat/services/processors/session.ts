import {
  chatTurnActions,
  selectConversationFromWs,
  useChatTurnStore,
  chatTurnSelectors
} from '../../stores/chat-turns'

export function handleSession(method: string, params: any) {
  switch (method) {
    case 'chat.session.new':
    case 'chat.session.resumed': {
      const id = typeof params?.conversationId === 'string' ? params.conversationId : ''
      if (id) selectConversationFromWs(id)
      return true
    }
    case 'chat.session.history': {
      // 前端不再回放 history（HTTP resume 已提供 turns 快照）；此处仅消费事件以防止冒泡
      return true
    }
  }
  return false
}
