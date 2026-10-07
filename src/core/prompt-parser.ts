import { invalid } from "./errors.js";
import { languageNames, languages, normalizeLanguage, type DoubaoLang } from "../doubao/languages.js";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = languageNames.flatMap(([lang, names]) => names.map(name => ({ lang, name })))
  .concat(languages.map(lang => ({ lang, name: lang })))
  .sort((a, b) => b.name.length - a.name.length);
const nameExpression = names.map(x => escape(x.name)).join("|");
const english = new RegExp(`(?:\\btranslate\\b[^\\n:：]{0,160}?\\b(?:to|into)\\s+|\\b(?:target|output)\\s+language\\s*[:：]\\s*)(${nameExpression})(?![\\w-])`, "gi");
const chinese = new RegExp(`(?:翻译(?:成|为)|译为|目标语言\\s*[:：]\\s*)(${nameExpression})`, "gi");

function scan(text: string): DoubaoLang[] {
  const found: DoubaoLang[] = [];
  for (const expression of [english, chinese]) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      const entry = names.find(x => x.name.toLowerCase() === match[1]!.toLowerCase());
      if (entry) found.push(entry.lang);
    }
  }
  return found;
}
export function determineLanguage(body: string | undefined, header: string | undefined, contexts: string[], user: string,
  defaultLanguage?: DoubaoLang) {
  if (body !== undefined) return normalizeLanguage(body);
  if (header !== undefined) return normalizeLanguage(header);
  for (const values of [contexts.flatMap(scan), scan(instructionPrefix(user))]) {
    const unique = [...new Set(values)];
    if (unique.length > 1) throw invalid("Conflicting target translation languages.", "invalid_request", "target_lang");
    if (unique.length === 1) return unique[0]!;
  }
  const directive = /(?:\btranslate\b[^\n:：]{0,160}\b(?:to|into)\s+|\b(?:target|output)\s+language\s*[:：]|翻译(?:成|为)|译为|目标语言\s*[:：])/i;
  if (defaultLanguage && ![...contexts, instructionPrefix(user)].some(text => directive.test(text)))
    return defaultLanguage;
  throw invalid("Unable to determine target translation language.", "target_language_required", "target_lang");
}
function instructionPrefix(user: string) {
  const prefix = user.match(/^(?:please\s+)?translate[^\n:：]{1,160}[:：][ \t]*(?:\r\n|\n|\r)*/i) ??
    user.match(/^(?:请(?:将|把)?|将|把)?(?:下面(?:的)?(?:内容|文字|文本)?|以下(?:的)?(?:内容|文字|文本)?|这(?:段)?(?:文字|文本|内容))?[ \t]*(?:翻译(?:成|为)|译为)[^\n:：]{1,80}[:：][ \t]*(?:\r\n|\n|\r)*/) ??
    user.match(/^(?:(?:Target|Output)\s+language|目标语言)\s*[:：][^\r\n]{1,80}(?:\r\n|\n|\r)+/i);
  return prefix?.[0] ?? "";
}
export function extractSource(user: string) {
  let text = user;
  const prefix = instructionPrefix(text);
  if (prefix) text = text.slice(prefix.length);
  const label = text.match(/^(?:Text|Source text|原文)\s*[:：][ \t]*(?:\r\n|\n|\r)?/i);
  if (label) text = text.slice(label[0].length);
  if (!text.trim()) throw invalid("Translation input is empty.", "empty_translation_input");
  return text;
}
