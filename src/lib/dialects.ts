/** 语音转写支持的语言 / 方言。dialect 通过 prompt 引导，ISO 语言码仍传标准值。 */

export interface SpeechVariant {
  id: string;
  zh: string;
  en: string;
  /** 传给转写接口的 ISO-639-1 语言码，undefined 表示自动检测 */
  iso?: string;
  /** 引导用的提示语，帮助模型往这个方言上靠 */
  prompt?: string;
}

export const SPEECH_VARIANTS: SpeechVariant[] = [
  { id: "auto", zh: "自动", en: "Auto" },
  { id: "zh", zh: "普通话", en: "Mandarin", iso: "zh" },
  {
    id: "yue",
    zh: "粤语",
    en: "Cantonese",
    iso: "zh",
    prompt: "以下係一段粵語對話錄音，請逐字轉寫，保留「係」「嘅」「咗」「唔」「乜」等粵語用詞。",
  },
  {
    id: "sichuan",
    zh: "四川话",
    en: "Sichuanese",
    iso: "zh",
    prompt: "以下是一段四川方言录音，请逐字转写成中文，保留「啥子」「要得」「巴适」「摆龙门阵」等方言词。",
  },
  {
    id: "northeast",
    zh: "东北话",
    en: "Northeastern",
    iso: "zh",
    prompt: "以下是一段东北方言录音，请逐字转写成中文，保留「咋整」「贼」「唠嗑」「整挺好」等方言词。",
  },
  {
    id: "wu",
    zh: "上海话 / 吴语",
    en: "Shanghainese / Wu",
    iso: "zh",
    prompt: "以下是一段上海话（吴语）录音，请逐字转写成中文，保留「侬」「阿拉」「勿」「晓得」等吴语用词。",
  },
  {
    id: "minnan",
    zh: "闽南话",
    en: "Hokkien",
    iso: "zh",
    prompt: "以下是一段闽南话录音，请逐字转写成中文，保留「汝」「毋」「按怎」「食饭」等闽南语用词。",
  },
  {
    id: "hakka",
    zh: "客家话",
    en: "Hakka",
    iso: "zh",
    prompt: "以下是一段客家话录音，请逐字转写成中文，保留客家方言用词。",
  },
  {
    id: "henan",
    zh: "河南话",
    en: "Henan",
    iso: "zh",
    prompt: "以下是一段河南方言录音，请逐字转写成中文，保留「中」「恁」「弄啥嘞」等方言词。",
  },
  {
    id: "shaanxi",
    zh: "陕西话",
    en: "Shaanxi",
    iso: "zh",
    prompt: "以下是一段陕西方言录音，请逐字转写成中文，保留「咥」「聊咋咧」「额」等方言词。",
  },
  {
    id: "hunan",
    zh: "湖南话",
    en: "Hunanese",
    iso: "zh",
    prompt: "以下是一段湖南方言录音，请逐字转写成中文，保留湘语方言用词。",
  },
  { id: "en", zh: "English", en: "English", iso: "en" },
];

export function findVariant(id: string): SpeechVariant {
  return SPEECH_VARIANTS.find((item) => item.id === id) ?? SPEECH_VARIANTS[0];
}
