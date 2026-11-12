export function registerMemoryTool(tools, manager) {
  tools.register({
    name: 'qq_memory',
    description: '查询或更新当前聊天的当前事项、长期事实与已确认群词。add 新增，update 更正或标完成/取消，list 查询（含待核实、完成记录），history 查看旧版本。仅明确要求记住才新增事实。使用稳定 id 与当前 version 修改，不读写旧便签、话头、事实卡或群词典文件。',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'history'] },
        kind: { type: 'string', enum: ['task', 'fact', 'term', 'candidate'] },
        id: { type: 'string' }, version: { type: 'integer', minimum: 1 }, text: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'cancelled', 'unverified', 'expired', 'removed'] },
        verifyAt: { type: 'number', description: '有效期或下次核实的 Unix 毫秒时间戳；有明确日期时填写' },
      }, required: ['action'], additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { maintenance: { type: 'string' }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      required: ['entries', 'maintenance'], additionalProperties: false },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const id = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id
      const record = manager.find(String(id))
      if (!record || !manager.memory) throw new Error('记忆工具只能在当前 QQ 聊天中使用')
      if (!['list', 'history', 'add', 'update'].includes(args.action)) throw new Error('未知记忆操作')
      if (args.action === 'list' || args.action === 'history') {
        const entries = manager.memory.query(record, { kind: args.kind, status: args.status, text: args.action === 'list' ? args.text : '' })
          .filter(e => !args.id || e.id === args.id)
        return { maintenance: manager.memory.status(record), entries: args.action === 'history' ? entries : entries.map(({ history, ...e }) => e) }
      }
      if (args.action === 'update' && (!args.id || !Number.isSafeInteger(args.version))) throw new Error('修改需要条目 id 与 version')
      if (args.action === 'add' && args.id) throw new Error('新增不能指定已有条目 id')
      const entry = await manager.memory.update(record, args)
      return { maintenance: manager.memory.status(record), entries: [entry] }
    },
  })
}
