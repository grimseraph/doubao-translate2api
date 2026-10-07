import { invalid } from "../core/errors.js";

export const languages = ["en", "ar", "de", "es", "es-ES", "fil", "fr", "id", "it", "ja", "ko", "ms", "pt", "ru", "th", "uz", "vi", "zh", "zh-Hant"] as const;
export type DoubaoLang = typeof languages[number];
const aliases: Record<string, DoubaoLang> = {
  "zh-cn": "zh", "zh-hans": "zh", "zh-sg": "zh",
  "zh-tw": "zh-Hant", "zh-hk": "zh-Hant", "zh-hant": "zh-Hant", "zh-mo": "zh-Hant",
  "pt-br": "pt", "pt-pt": "pt", "es-419": "es", "es-mx": "es", "es-es": "es-ES", tl: "fil",
};
export function normalizeLanguage(value: string): DoubaoLang {
  const key = value.trim();
  const exact = languages.find(x => x === key);
  const match = exact ?? aliases[key.toLowerCase()] ??
    languages.find(x => x.toLowerCase() === key.toLowerCase()) ??
    languages.find(x => x === key.toLowerCase().split("-")[0]);
  if (!match) throw invalid("Unsupported target translation language.", "unsupported_target_language", "target_lang");
  return match;
}

export const languageNames: Array<[DoubaoLang, string[]]> = [
  ["zh-Hant", ["Traditional Chinese", "繁体中文", "繁體中文"]],
  ["zh", ["Simplified Chinese", "Chinese", "简体中文", "中文"]],
  ["en", ["English", "英语", "英文"]],
  ["ja", ["Japanese", "日语", "日文", "日本語"]],
  ["ko", ["Korean", "韩语", "韩文", "한국어"]],
  ["fr", ["French", "法语"]], ["de", ["German", "德语"]],
  ["es-ES", ["European Spanish", "Spanish (Spain)"]],
  ["es", ["Spanish", "西班牙语"]], ["pt", ["Portuguese", "葡萄牙语"]],
  ["ru", ["Russian", "俄语"]], ["ar", ["Arabic", "阿拉伯语"]],
  ["it", ["Italian", "意大利语"]], ["id", ["Indonesian", "印尼语", "印度尼西亚语"]],
  ["ms", ["Malay", "马来语"]], ["th", ["Thai", "泰语"]],
  ["vi", ["Vietnamese", "越南语"]], ["fil", ["Filipino", "Tagalog", "菲律宾语"]],
  ["uz", ["Uzbek", "乌兹别克语"]],
];
