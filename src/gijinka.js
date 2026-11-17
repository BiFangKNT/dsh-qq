/**
 * 可选角色资料包：各家 AI 模型的拟人同人形象，非真人或官方形象。
 * 仅由管理员选入指定范围后供资料检索，不再组装到 system。
 *
 * 数据来源：genderswapai.com 的角色档案（2026-10-25 抓取）。
 * 主要形象创作者 ZipZipPipe；DeepSeek 娘原角色为上善无形，CC BY-NC-SA 4.0。
 * 这里只存「认人需要的最小信息」——名字、别称、外貌特征。
 *
 * @module gijinka
 */

/**
 * @typedef {object} Gijinka
 * @property {string} slug   档案页的短名
 * @property {string} name   作品里的正式叫法
 * @property {string} ai     对应哪个 AI / 公司
 * @property {string[]} aliases  群友常用的别称（不含 AI 本名）
 * @property {string[]} traits   外貌特征，认图用
 * @property {string} [note]     额外提示
 */

/** @type {Gijinka[]} */
export const GIJINKA = [
  {
    slug: 'deepseek',
    name: 'DeepSeek 娘',
    ai: 'DeepSeek',
    aliases: ['蓝色大肥鱼', '鲸鱼娘', '大肥鱼', 'DS娘'],
    traits: ['蓝色长发', '鲸鱼尾巴', '黑白女仆裙'],
  },
  {
    slug: 'gpt',
    name: 'GPT 娘',
    ai: 'GPT / OpenAI',
    aliases: ['龙娘', '小龙娘', 'ChatGPT娘'],
    traits: ['白发龙角', '白金礼服', '龙尾龙翼'],
  },
  {
    slug: 'claude',
    name: 'Claude 娘',
    ai: 'Claude / Anthropic',
    aliases: ['克劳德娘'],
    traits: ['橙色长发', '花朵发饰', '白黑层叠裙'],
  },
  {
    slug: 'gemini',
    name: 'Gemini 娘',
    ai: 'Gemini / Google',
    aliases: ['双子娘'],
    traits: ['蓝紫长发', '猫耳', '异色瞳'],
  },
  {
    slug: 'grok',
    name: 'Grok 娘',
    ai: 'Grok / xAI',
    aliases: [],
    traits: ['金色长发', '黑色礼服', '尖角装饰'],
  },
  {
    slug: 'llama',
    name: 'Llama 娘',
    ai: 'Llama / Meta',
    aliases: ['羊驼娘'],
    traits: ['白色猫耳', '白色长卷发', '宽松外套'],
  },
  {
    slug: 'mistral',
    name: 'Mistral 娘',
    ai: 'Mistral',
    aliases: ['米斯特拉尔娘'],
    traits: ['红色宽檐帽', '金色长发', '红白法师裙'],
  },
  {
    slug: 'perplexity',
    name: 'Perplexity 娘',
    ai: 'Perplexity',
    aliases: ['困惑娘'],
    traits: ['墨绿长发', '法师长袍', '星形法杖'],
  },
  {
    slug: 'wenxin',
    name: '文心娘',
    ai: '文心一言 / 百度',
    aliases: ['文心一言娘', '百度娘'],
    traits: ['蓝色方块发夹', '蓝色长发', '蓝白中式衣裙'],
  },
  {
    slug: 'qwen',
    name: 'Qwen 娘',
    ai: 'Qwen / 阿里',
    aliases: ['通义娘', '千问娘'],
    traits: ['蓝紫长发', '圆形发饰', '中式衣裙'],
  },
  {
    slug: 'kimi',
    name: 'Kimi 娘',
    ai: 'Kimi / 月之暗面',
    aliases: ['月之暗面娘'],
    traits: ['银紫长发', '非对称服装', '月亮标记'],
  },
  {
    slug: 'glm',
    name: 'GLM 娘',
    ai: 'GLM / 智谱',
    aliases: ['智谱娘'],
    traits: ['黑色长发', '狐狸耳朵', '黑白女仆装'],
  },
  {
    slug: 'seed',
    name: 'Seed 娘',
    ai: 'Seed / 字节跳动',
    aliases: ['豆包娘'],
    traits: ['紫蓝单马尾', '蓝白科技服', '豆包挂件'],
  },
  {
    slug: 'minimax',
    name: 'MiniMax 娘',
    ai: 'MiniMax',
    aliases: ['海螺娘'],
    traits: ['粉色贝雷帽', '橙色短发', '场记板'],
  },
  {
    slug: 'jev',
    name: 'JEV 娘',
    ai: 'JEV',
    aliases: ['裁判者'],
    traits: ['黑粉配色', '手持天平', '嘴部荆棘'],
  },
]
