import { setupServer } from 'msw/node'

// 默认不注册 handlers，由各测试用例按需 server.use(...) 注入
export const server = setupServer()

export default server

